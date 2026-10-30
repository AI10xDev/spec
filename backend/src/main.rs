use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use nix::{
    sys::signal::{Signal, killpg},
    unistd::Pid,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path as FsPath, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    sync::watch,
};
use tower_http::services::ServeDir;
use uuid::Uuid;

mod ai_settings;
mod analytics;
mod azure_realtime;
mod chat;
mod completion;
mod realtime;
mod recovery;
mod remote;
mod settings;
use azure_realtime::AzureRealtime;
use completion::Completion;
use realtime::Realtime;
use remote::Remote;

const MAX_FILE: usize = 2 * 1024 * 1024;
// The existing spec launcher forwards the prompt as one Linux exec argument.
const MAX_BUILD_SPEC: usize = 120 * 1024;
const MAX_OUTPUT: usize = 256 * 1024;
const MAX_RUNS: usize = 16;
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

#[derive(Clone)]
struct App {
    root: PathBuf,
    token: String,
    remote: Option<Remote>,
    completion: Option<Completion>,
    settings: Arc<settings::Store>,
    realtime: Option<Realtime>,
    azure_realtime: Option<AzureRealtime>,
    files: Arc<Mutex<()>>,
    jobs: Arc<Mutex<Vec<Job>>>,
    recovered: Arc<Mutex<bool>>,
    recovery_runs: Arc<recovery::RunGates>,
    // Serializes admission and latest-pointer changes, never polling or cancellation.
    recovery_gate: Arc<tokio::sync::Mutex<()>>,
}

impl App {
    fn ai_completion(&self) -> Option<Completion> {
        self.settings
            .completion()
            .or_else(|| self.completion.clone())
    }
}

#[derive(Serialize, Deserialize)]
struct Job {
    id: String,
    name: String,
    status: String,
    output: VecDeque<u8>,
    truncated: bool,
    remote_identity: String,
    recover: bool,
    #[serde(default)]
    repository_save: bool,
    #[serde(default)]
    optimization: bool,
    #[serde(skip, default = "detached_control")]
    stop: watch::Sender<RunControl>,
    #[serde(skip)]
    attached: bool,
    #[serde(skip)]
    dirty: bool,
    #[serde(skip)]
    persistence_error: Option<String>,
}

fn detached_control() -> watch::Sender<RunControl> {
    watch::channel(RunControl::Detach).0
}

#[derive(Clone, Copy, PartialEq)]
enum RunControl {
    Running,
    Cancel,
    Detach,
}

#[derive(Serialize, Deserialize, Debug)]
struct Document {
    name: String,
    content: String,
    revision: String,
}

#[derive(Deserialize)]
struct Save {
    content: String,
    revision: Option<String>,
}

#[derive(Serialize)]
struct Entry {
    name: String,
    modified: u64,
    bytes: u64,
}

#[derive(Deserialize)]
struct Run {
    name: String,
    revision: String,
}

#[derive(Deserialize)]
struct Optimize {
    name: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(default)]
struct Continue {
    message: String,
}

impl Default for Continue {
    fn default() -> Self {
        Self {
            message: CONTINUE_RECOMMENDED.to_owned(),
        }
    }
}

enum RunInput {
    Build(Run),
    RepositorySave(Run),
    Continue(String, String),
    Optimize(Optimize),
}

const CONTINUE_RECOMMENDED: &str = "Use the recommended option from your last response and continue the build session. Implement it now; do not stop at a plan. If no recommended option was provided, explain what input is needed rather than guessing.";

#[derive(Serialize, Deserialize)]
struct Output {
    id: String,
    name: String,
    status: String,
    output: String,
    truncated: bool,
    recoverable: bool,
    continuable: bool,
}

struct Error(StatusCode, String);
type Result<T> = std::result::Result<T, Error>;

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({"error": self.1}))).into_response()
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        let code = if error.kind() == std::io::ErrorKind::NotFound {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        Self(code, error.to_string())
    }
}

fn invalid(message: &str) -> Error {
    Error(StatusCode::BAD_REQUEST, message.into())
}

fn validate(name: &str) -> Result<()> {
    // Deliberately flat workspace: no path components, dotfiles, or control characters.
    if name.is_empty()
        || name.len() > 180
        || name.starts_with('.')
        || name.trim() != name
        || name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
    {
        return Err(invalid(
            "Use a filename, not a path or hidden file (maximum 180 bytes)",
        ));
    }
    Ok(())
}

fn read(root: &FsPath, name: &str) -> Result<Document> {
    validate(name)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(root.join(name))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE as u64 {
        return Err(invalid(
            "Only regular UTF-8 files up to 2 MiB can be edited",
        ));
    }
    let mut content = String::new();
    (&mut file)
        .take((MAX_FILE + 1) as u64)
        .read_to_string(&mut content)?;
    if content.len() > MAX_FILE || content.contains('\0') {
        return Err(invalid("File is too large or contains NUL bytes"));
    }
    Ok(Document {
        name: name.into(),
        revision: format!("{:x}", Sha256::digest(content.as_bytes())),
        content,
    })
}

fn save(app: &App, name: &str, input: Save) -> Result<Document> {
    validate(name)?;
    if input.content.len() > MAX_FILE || input.content.contains('\0') {
        return Err(invalid("File is too large or contains NUL bytes"));
    }
    let _guard = app.files.lock().unwrap();
    let current = match read(&app.root, name) {
        Ok(doc) => Some(doc.revision),
        Err(Error(StatusCode::NOT_FOUND, _)) => None,
        Err(error) => return Err(error),
    };
    if current != input.revision {
        return Err(Error(
            StatusCode::CONFLICT,
            "File changed on disk. Reopen it in a new tab or download your edits before reloading."
                .into(),
        ));
    }
    let mut temporary = tempfile::NamedTempFile::new_in(&app.root)?;
    temporary.write_all(input.content.as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(app.root.join(name))
        .map_err(|error| Error::from(error.error))?;
    File::open(&app.root)?.sync_all()?;
    read(&app.root, name)
}

async fn authenticate(State(app): State<App>, request: Request, next: Next) -> Response {
    if request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        != Some(format!("Bearer {}", app.token).as_str())
    {
        return Error(
            StatusCode::UNAUTHORIZED,
            "Paste the access token printed by the Rust server".into(),
        )
        .into_response();
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

async fn list(State(app): State<App>) -> Result<Json<Vec<Entry>>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(&app.root)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if validate(&name).is_err() || !entry.file_type()?.is_file() {
            continue;
        }
        let metadata = entry.metadata()?;
        entries.push(Entry {
            name,
            modified: metadata
                .modified()?
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            bytes: metadata.len(),
        });
        if entries.len() >= 10_000 {
            break;
        }
    }
    entries.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.name.cmp(&b.name)));
    Ok(Json(entries))
}

async fn load(State(app): State<App>, Path(name): Path<String>) -> Result<Json<Document>> {
    Ok(Json(read(&app.root, &name)?))
}

async fn write(
    State(app): State<App>,
    Path(name): Path<String>,
    Json(input): Json<Save>,
) -> Result<Json<Document>> {
    Ok(Json(save(&app, &name, input)?))
}

fn append(app: &App, id: &str, bytes: &[u8]) {
    let mut jobs = app.jobs.lock().unwrap();
    let Some(job) = jobs.iter_mut().find(|job| job.id == id) else {
        return;
    };
    job.output.extend(bytes);
    job.dirty = true;
    if job.output.len() > MAX_OUTPUT {
        job.output.drain(..job.output.len() - MAX_OUTPUT);
        job.truncated = true;
    }
}

async fn drain(app: App, id: String, mut stream: impl AsyncRead + Unpin) {
    let mut bytes = [0u8; 4096];
    loop {
        match stream.read(&mut bytes).await {
            Ok(0) => break,
            Ok(size) => append(&app, &id, &bytes[..size]),
            Err(error) => {
                append(
                    &app,
                    &id,
                    format!("\n[output read error] {error}\n").as_bytes(),
                );
                break;
            }
        }
    }
}

async fn start(State(app): State<App>, Json(input): Json<Run>) -> Result<Json<serde_json::Value>> {
    start_run(app, RunInput::Build(input)).await
}

async fn optimize(
    State(app): State<App>,
    Json(input): Json<Optimize>,
) -> Result<Json<serde_json::Value>> {
    validate(&input.name)?;
    if !input.name.ends_with(".optim") {
        return Err(invalid("Select a .optim file to optimize"));
    }
    if input.content.trim().is_empty()
        || input.content.contains('\0')
        || input.content.len() > 1024 * 1024
    {
        return Err(invalid(
            "Optimization specs must be nonempty UTF-8 without NUL bytes and at most 1 MiB",
        ));
    }
    start_run(app, RunInput::Optimize(input)).await
}

async fn latest_optimization(State(app): State<App>) -> Result<Json<Option<Output>>> {
    let Some(id) = recovery::latest_optimization(&app)? else {
        return Ok(Json(None));
    };
    let Json(output) = output(State(app), Path(id)).await?;
    Ok(Json(Some(output)))
}

async fn continue_recommended(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(input): Json<Continue>,
) -> Result<Json<serde_json::Value>> {
    if input.message.trim().is_empty()
        || input.message.contains('\0')
        || input.message.len() > 16 * 1024
    {
        return Err(invalid(
            "Feedback must be nonempty after trimming, NUL-free, and at most 16 KiB of UTF-8",
        ));
    }
    start_run(app, RunInput::Continue(id, input.message)).await
}

async fn repository(State(app): State<App>) -> Result<Json<serde_json::Value>> {
    let status = match &app.remote {
        Some(remote) => remote
            .repository_status()
            .await
            .map_err(|error| Error(StatusCode::BAD_GATEWAY, error))?,
        None => remote::RepositoryStatus {
            connected: false,
            dirty: false,
            directory: None,
            model: "azure/gpt-6-sol",
        },
    };
    let mut status = serde_json::json!(status);
    if let Some(profile) = app.settings.profile() {
        status["model"] = format!("{}/{}", profile.provider, profile.model).into();
    }
    Ok(Json(status))
}

async fn repository_save(
    State(app): State<App>,
    Json(input): Json<Run>,
) -> Result<Json<serde_json::Value>> {
    start_run(app, RunInput::RepositorySave(input)).await
}

async fn start_run(app: App, input: RunInput) -> Result<Json<serde_json::Value>> {
    // Capture once per admission; never persist credentials with the job or snapshot.
    let profile = app.settings.profile();
    let profile_bytes = profile
        .as_ref()
        .map(serde_json::to_vec)
        .transpose()
        .map_err(|_| invalid("Cannot encode execution provider settings"))?
        .unwrap_or_default();
    if profile_bytes.len() > 65536 {
        return Err(invalid("Execution provider settings exceed 64 KiB"));
    }
    let repository_save = matches!(&input, RunInput::RepositorySave(_));
    let optimization = matches!(&input, RunInput::Optimize(_));
    let remote = app.remote.as_ref().ok_or_else(|| Error(
        if repository_save { StatusCode::FORBIDDEN } else { StatusCode::BAD_REQUEST },
        "Remote execution is disabled. Set SPEC_SSH_TARGET and SPEC_SSH_WORKSPACE on the local Rust server, then restart it.".into(),
    ))?;
    recovery::initialize(&app)?;
    let pending: Vec<_> = app
        .jobs
        .lock()
        .unwrap()
        .iter()
        .filter(|job| job.recover && !job.attached)
        .map(|job| job.id.clone())
        .collect();
    for id in pending {
        recovery::refresh(&app, &id, false).await?;
    }
    let _recovery_guard = app.recovery_gate.lock().await;
    let parent_id = match &input {
        RunInput::Continue(id, _) => Some(id.clone()),
        _ => None,
    };
    let mut optimization_spec = String::new();
    let (name, content, session_id) = match input {
        RunInput::Optimize(input) => {
            optimization_spec = input.content;
            (
                "optimization".into(),
                include_str!("optimize.py").into(),
                None,
            )
        }
        RunInput::Build(input) | RunInput::RepositorySave(input) => {
            let document = read(&app.root, &input.name)?;
            if document.revision != input.revision {
                return Err(Error(
                    StatusCode::CONFLICT,
                    "Save your current revision before running".into(),
                ));
            }
            if document.content.trim().is_empty() {
                return Err(invalid("Cannot run an empty spec"));
            }
            if document.content.len() > MAX_BUILD_SPEC {
                return Err(invalid(
                    "spec build supports snapshots up to 120 KiB; larger files can still be edited and saved",
                ));
            }
            (document.name, document.content, None)
        }
        RunInput::Continue(id, message) => {
            let name = {
                let jobs = recovery::restore(&app, &id)?;
                let job = jobs.iter().find(|job| job.id == id).unwrap();
                if job.recover
                    || job.attached
                    || job.status != "completed"
                    || job.repository_save
                    || job.optimization
                {
                    return Err(Error(StatusCode::CONFLICT, "Only a completed build can be continued. Wait for completion or load its output before retrying.".into()));
                }
                if job.remote_identity != remote.identity() {
                    return Err(Error(
                        StatusCode::CONFLICT,
                        "Remote configuration does not match the saved run".into(),
                    ));
                }
                job.name.clone()
            };
            // The latest pointer is advanced before launch under this same gate.
            // Retrying an old button/request cannot submit another continuation.
            if recovery::latest(&app, &name)?.as_deref() != Some(&id) {
                return Err(Error(
                    StatusCode::CONFLICT,
                    "This run is no longer the latest build. Load its output before continuing."
                        .into(),
                ));
            }
            let session = remote
                .session_id(&id, &name)
                .await
                .map_err(|error| Error(StatusCode::BAD_GATEWAY, error))?;
            (name, message, Some(session))
        }
    };
    // A changed SSH configuration cannot prove that an old harness finished.
    if app.jobs.lock().unwrap().iter().any(|job| {
        job.recover && (repository_save || optimization || job.repository_save || job.optimization)
    }) {
        return Err(Error(
            StatusCode::CONFLICT,
            "A run is active or its remote status is unresolved for this repository. Load its output before retrying.".into(),
        ));
    }
    if repository_save {
        let status = remote
            .repository_status()
            .await
            .map_err(|error| Error(StatusCode::BAD_GATEWAY, error))?;
        if !status.connected || !status.dirty {
            return Err(Error(
                StatusCode::CONFLICT,
                "Repository save requires a connected Git worktree with unsaved changes".into(),
            ));
        }
    }
    let id = Uuid::new_v4().to_string();
    let (stop, mut stopped) = watch::channel(RunControl::Running);
    {
        let mut jobs = app.jobs.lock().unwrap();
        if let Some(job) = jobs.iter().find(|job| job.name == name && job.recover) {
            return Err(Error(
                StatusCode::CONFLICT,
                format!(
                    "A run is active or its remote status is unresolved for this file (run {}, status: {}). Load its output or stop it before retrying.",
                    job.id, job.status
                ),
            ));
        }
        if jobs.iter().filter(|job| job.recover).count() >= MAX_RUNS {
            return Err(Error(
                StatusCode::CONFLICT,
                format!(
                    "The {MAX_RUNS}-run limit was reached. Wait for an active run to finish, stop one, or resolve its remote status before retrying."
                ),
            ));
        }
        if jobs.len() >= 32 {
            let index = jobs.iter().position(|job| !job.recover).unwrap();
            jobs.remove(index);
        }
        let mut job = Job {
            id: id.clone(),
            name: name.clone(),
            status: "running".into(),
            output: VecDeque::new(),
            truncated: false,
            stop,
            remote_identity: remote.identity(),
            recover: true,
            repository_save,
            optimization,
            attached: true,
            dirty: false,
            persistence_error: None,
        };
        // The durable ID and latest-file pointer must exist before SSH can launch.
        recovery::persist(&app, &job)?;
        if let Err(error) = recovery::set_latest(&app, &job) {
            job.status = "failed to persist latest run; SSH was not started".into();
            job.recover = false;
            job.attached = false;
            recovery::persist(&app, &job)?;
            return Err(error);
        }
        jobs.push(job);
    }
    // All operations use the same fixed adapter and durable output/status protocol.
    let mode = if session_id.is_some() {
        "continue"
    } else if repository_save {
        "repository-save"
    } else if optimization {
        "optimize"
    } else {
        "build"
    };
    let mut command = if !profile_bytes.is_empty() {
        remote.execution_command(
            content.len(),
            &id,
            &name,
            mode,
            session_id.as_deref().unwrap_or(""),
            optimization_spec.len(),
            profile_bytes.len(),
        )
    } else if let Some(session) = &session_id {
        remote.continuation_command(content.len(), &id, &name, session)
    } else if repository_save {
        remote.repository_command(content.len(), &id, &name)
    } else if optimization {
        remote.optimization_command(content.len(), &id, &name, optimization_spec.len())
    } else {
        remote.command(content.len(), &id, &name)
    };
    let child = command
        .current_dir(&app.root)
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(error) => {
            let mut jobs = app.jobs.lock().unwrap();
            let job = jobs.iter_mut().find(|job| job.id == id).unwrap();
            job.status = format!("failed to start SSH ({error})");
            job.recover = false;
            job.attached = false;
            recovery::persist(&app, job)?;
            // No SSH process started, so the original session is safe to retry.
            if let Some(parent_id) = &parent_id {
                recovery::set_latest(&app, &recovery::load(&app, parent_id)?)?;
            }
            return Err(error.into());
        }
    };
    let mut stdin = child.stdin.take().unwrap();
    let pid = child.id().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let response = Json(serde_json::json!({ "id": id }));
    drop(_recovery_guard);
    tokio::spawn(async move {
        append(
            &app,
            &id,
            if session_id.is_some() {
                b"[started] Submitting feedback and continuing the same build session with automatic tool approval.\n"
            } else if repository_save {
                b"[started] remote repository save over SSH with the saved snapshot as context and the existing repository workflow. Output and logs only.\n"
            } else if optimization {
                b"[started] Uploading the editor's .optim spec to remote ~/projects and optimizing the latest detached build using its absolute path. No iteration or time limit; Stop run cancels. Progress and gain reports follow.\n"
            } else {
                b"[started] remote spec build over SSH: running the saved snapshot with automatic tool approval requested. Output and logs only.\n"
            },
        );
        // EOF only detaches. Stop sends a distinct control byte after the entire
        // snapshot, optimization spec, and profile, so an early Stop cannot corrupt them.
        let mut control = stopped.clone();
        let mut upload = tokio::spawn(async move {
            stdin.write_all(content.as_bytes()).await?;
            stdin.write_all(optimization_spec.as_bytes()).await?;
            stdin.write_all(&profile_bytes).await?;
            drop(profile_bytes);
            let _ = control.changed().await;
            if *control.borrow() == RunControl::Cancel {
                stdin.write_all(b"C").await?;
                stdin.flush().await?;
                // Keep the attachment alive for its final output/status.
                std::future::pending::<()>().await;
            }
            Ok::<_, std::io::Error>(())
        });
        let out = tokio::spawn(drain(app.clone(), id.clone(), stdout));
        let err = tokio::spawn(drain(app.clone(), id.clone(), stderr));
        let mut checkpoint = tokio::time::interval(Duration::from_secs(1));
        let mut status = loop {
            break tokio::select! {
                result = child.wait() => match result {
                    Ok(exit) if exit.success() => "completed".to_owned(),
                    Ok(exit) if exit.code() == Some(124) => "timed out".to_owned(),
                    Ok(exit) if exit.code() == Some(130) => "cancelled".to_owned(),
                    Ok(exit) => format!("failed ({exit})"),
                    Err(error) => format!("failed ({error})"),
                },
                _ = stopped.changed() => if *stopped.borrow() == RunControl::Cancel { "cancelled" } else { "detached" }.into(),
                _ = &mut upload => "detached (input closed)".into(),
                _ = checkpoint.tick() => {
                    recovery::checkpoint(&app, &id);
                    continue;
                }
            };
        };
        // Give explicit cancellation time to reach the supervisor and confirm it.
        if status == "cancelled" {
            match tokio::time::timeout(Duration::from_secs(3), child.wait()).await {
                Ok(Ok(exit)) if exit.code() == Some(130) => {}
                Ok(Ok(exit)) if exit.success() => status = "completed".into(),
                _ => {
                    status = "detached (cancellation unconfirmed)".into();
                    append(&app, &id, b"\n[warning] Cancellation was not confirmed; remote work may still be running. Load its output and retry Stop run.\n");
                }
            }
        }
        upload.abort();
        if status != "completed" && status != "cancelled" && status != "timed out" {
            append(&app, &id, b"\n[remote] SSH attachment ended; this does not cancel remote work. Use Load nohup output to restore the spec's session log/status before retrying.\n");
        }
        // Reap the local SSH process group as well.
        let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
        let _ = child.wait().await;
        for mut task in [out, err] {
            if tokio::time::timeout(Duration::from_secs(2), &mut task)
                .await
                .is_err()
            {
                task.abort();
            }
        }
        append(&app, &id, format!("\n[{status}]\n").as_bytes());
        let _guard = recovery::run_gate(&app, &id).await;
        if let Some(job) = app.jobs.lock().unwrap().iter_mut().find(|job| job.id == id) {
            job.status = status;
            job.attached = false;
            job.dirty = true;
        }
        recovery::checkpoint(&app, &id);
        // An SSH exit alone is not authoritative remote completion evidence.
        if let Err(error) = recovery::refresh_locked(&app, &id, false).await {
            eprintln!("Run {id} recovery: {}", error.1);
        }
    });
    Ok(response)
}

async fn output(State(app): State<App>, Path(id): Path<String>) -> Result<Json<Output>> {
    recovery::initialize(&app)?;
    drop(recovery::restore(&app, &id)?);
    recovery::refresh(&app, &id, false).await?;
    let jobs = app.jobs.lock().unwrap();
    let job = jobs
        .iter()
        .find(|job| job.id == id)
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "Run not found".into()))?;
    Ok(Json(Output {
        id: job.id.clone(),
        name: job.name.clone(),
        status: job.status.clone(),
        output: String::from_utf8_lossy(&job.output.iter().copied().collect::<Vec<_>>())
            .into_owned(),
        truncated: job.truncated,
        recoverable: job.recover,
        continuable: !job.repository_save && !job.optimization,
    }))
}

async fn latest_output(
    State(app): State<App>,
    Path(name): Path<String>,
) -> Result<Json<Option<Output>>> {
    validate(&name)?;
    let Some(id) = recovery::latest(&app, &name)? else {
        return Ok(Json(None));
    };
    let Json(output) = output(State(app), Path(id)).await?;
    Ok(Json(Some(output)))
}

async fn output_log(
    State(app): State<App>,
    Path(name): Path<String>,
) -> Result<Json<Option<Output>>> {
    let Some(id) = recovery::latest(&app, &name)? else {
        return Ok(Json(None));
    };
    let job = recovery::load(&app, &id)?;
    let remote = app
        .remote
        .as_ref()
        .filter(|remote| remote.identity() == job.remote_identity)
        .ok_or_else(|| {
            Error(
                StatusCode::BAD_GATEWAY,
                "Remote configuration does not match the saved run".into(),
            )
        })?;
    let (status, bytes, truncated) = match remote.snapshot(&id, false, &name).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            // A missing or rejected remote log must not hide output we already have.
            let jobs = app.jobs.lock().unwrap();
            let cached = jobs.iter().find(|job| job.id == id).unwrap_or(&job);
            return Ok(Json(Some(Output {
                id,
                name,
                status: format!("unavailable ({error})"),
                output: String::from_utf8_lossy(&cached.output.iter().copied().collect::<Vec<_>>())
                    .into_owned(),
                truncated: cached.truncated,
                recoverable: cached.recover,
                continuable: !cached.repository_save && !cached.optimization,
            })));
        }
    };
    // A disk snapshot must not replace the buffer an attached SSH stream is appending to.
    Ok(Json(Some(Output {
        id,
        name,
        recoverable: status == "running" || status.starts_with("unknown"),
        status,
        output: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
        continuable: !job.repository_save && !job.optimization,
    })))
}

async fn cancel(State(app): State<App>, Path(id): Path<String>) -> Result<Json<serde_json::Value>> {
    recovery::initialize(&app)?;
    {
        let jobs = recovery::restore(&app, &id)?;
        let job = jobs
            .iter()
            .find(|job| job.id == id)
            .ok_or_else(|| Error(StatusCode::NOT_FOUND, "Run not found".into()))?;
        if job.attached {
            let _ = job.stop.send(RunControl::Cancel);
            return Ok(Json(serde_json::json!({"ok": true})));
        }
    }
    recovery::refresh(&app, &id, true).await?;
    Ok(Json(serde_json::json!({"ok": true})))
}

fn retained_remote<'a>(app: &'a App, name: &str) -> Result<&'a Remote> {
    read(&app.root, name)?;
    let remote = app.remote.as_ref().ok_or_else(|| {
        Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Remote execution is disabled".into(),
        )
    })?;
    if let Some(id) = recovery::latest(app, name)?
        && recovery::load(app, &id)?.remote_identity != remote.identity()
    {
        return Err(Error(
            StatusCode::BAD_GATEWAY,
            "Remote configuration does not match the saved run".into(),
        ));
    }
    Ok(remote)
}

async fn retained_runs(
    State(app): State<App>,
    Path(name): Path<String>,
) -> Result<Json<remote::RetainedRuns>> {
    let remote = retained_remote(&app, &name)?;
    remote
        .retained(&name, None, false)
        .await
        .map(Json)
        .map_err(|error| Error(StatusCode::BAD_GATEWAY, error))
}

async fn retained_log(
    State(app): State<App>,
    Path((name, id)): Path<(String, String)>,
) -> Result<Json<Output>> {
    if !Uuid::parse_str(&id).is_ok_and(|uuid| uuid.to_string() == id) {
        return Err(invalid("Invalid run ID"));
    }
    let remote = retained_remote(&app, &name)?;
    remote
        .retained(&name, Some(&id), false)
        .await
        .map(Json)
        .map_err(|error| Error(StatusCode::BAD_GATEWAY, error))
}

fn router(app: App) -> Router {
    Router::new()
        .route(
            "/api/config",
            get(|State(app): State<App>| async move {
                let completion = app.ai_completion().is_some();
                Json(serde_json::json!({
                    "execution": app.remote.is_some(),
                    "completion": completion,
                    "chat": completion,
                    "realtime": app.realtime.is_some(),
                    "azureRealtime": app.azure_realtime.is_some(),
                }))
            }),
        )
        .route(
            "/api/settings",
            get(settings::get)
                .put(settings::put)
                .delete(settings::delete)
                .layer(DefaultBodyLimit::max(settings::MAX_BODY)),
        )
        .route("/api/files", get(list))
        .route("/api/analytics", post(analytics::report))
        .route(
            "/api/realtime",
            post(realtime::call).layer(DefaultBodyLimit::max(realtime::MAX_BODY)),
        )
        .route(
            "/api/realtime/azure",
            post(azure_realtime::call).layer(DefaultBodyLimit::max(realtime::MAX_BODY)),
        )
        .route(
            "/api/chat",
            post(chat::chat).layer(DefaultBodyLimit::max(chat::MAX_BODY)),
        )
        .route(
            "/api/completions",
            post(completion::complete)
                .layer(DefaultBodyLimit::max(completion::MAX_PREFIX * 6 + 1024)),
        )
        .route("/api/files/{name}", get(load).put(write))
        .route("/api/files/{name}/run", get(latest_output))
        .route("/api/files/{name}/run/log", get(output_log))
        .route("/api/files/{name}/retained-runs", get(retained_runs))
        .route(
            "/api/files/{name}/retained-runs/{id}/log",
            get(retained_log),
        )
        .route("/api/runs", post(start))
        .route("/api/optimize", get(latest_optimization).post(optimize))
        .route("/api/repository", get(repository))
        .route("/api/repository/save", post(repository_save))
        .route("/api/runs/{id}", get(output))
        .route("/api/runs/{id}/cancel", post(cancel))
        .route("/api/runs/{id}/continue", post(continue_recommended))
        .layer(DefaultBodyLimit::max(MAX_FILE * 6 + 1024))
        .route_layer(middleware::from_fn_with_state(app.clone(), authenticate))
        .with_state(app)
}

#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let root =
        PathBuf::from(std::env::var("SPEC_WORKSPACE").unwrap_or_else(|_| "../workspace".into()));
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&root)?;
    let root = root.canonicalize()?;
    // Do not silently change permissions on an existing directory chosen by the user.
    if fs::metadata(&root)?.permissions().mode() & 0o022 != 0 {
        return Err("Workspace must not be writable by group/others".into());
    }
    let lock = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(root.join(".spec.lock"))?;
    if !lock.metadata()?.is_file() {
        return Err("Workspace lock must be a regular file".into());
    }
    let _lock = nix::fcntl::Flock::lock(lock, nix::fcntl::FlockArg::LockExclusiveNonblock)
        .map_err(|(_, error)| format!("Workspace is already served: {error}"))?;
    let remote = Remote::from_env()?;
    let completion = Completion::from_env();
    let ui = std::env::var("SPEC_UI_DIR").unwrap_or_else(|_| "../frontend/dist".into());
    let settings = Arc::new(settings::Store::from_env(
        &root,
        FsPath::new(&ui),
        completion.as_ref().ok().and_then(Option::as_ref),
    )?);
    // A saved profile overrides invalid text environment settings, but without one
    // startup must still fail rather than silently disabling a configured provider.
    let completion = match completion {
        Ok(completion) => completion,
        Err(_) if settings.profile().is_some() => None,
        Err(error) => return Err(error.into()),
    };
    let realtime = Realtime::from_env()?;
    let azure_realtime = AzureRealtime::from_env().unwrap_or_else(|error| {
        eprintln!("Azure Realtime voice disabled: {error}. Text chat configuration is unchanged.");
        None
    });
    let app = App {
        root,
        token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
        remote,
        completion,
        settings,
        realtime,
        azure_realtime,
        files: Arc::new(Mutex::new(())),
        jobs: Arc::new(Mutex::new(Vec::new())),
        recovered: Arc::new(Mutex::new(false)),
        recovery_runs: Arc::default(),
        recovery_gate: Arc::new(tokio::sync::Mutex::new(())),
    };
    let port: u16 = std::env::var("SPEC_PORT")
        .unwrap_or_else(|_| "4780".into())
        .parse()?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    println!(
        "Spec: http://127.0.0.1:{}/#token={}",
        listener.local_addr()?.port(),
        app.token
    );
    println!("Workspace: {}", app.root.display());
    if app.ai_completion().is_some() {
        println!("AI chat and ghost text: enabled");
    } else {
        println!(
            "AI chat and ghost text: disabled. Configure a provider in Settings, or set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY in .env or the server environment and restart; see .env.example."
        );
    }
    if app.azure_realtime.is_some() {
        println!("Azure Realtime voice: enabled");
    } else {
        println!(
            "Azure Realtime voice: disabled. Set AZURE_OPENAI_REALTIME_ENDPOINT, AZURE_OPENAI_REALTIME_API_KEY, and AZURE_OPENAI_REALTIME_DEPLOYMENT in the local server environment, .env, or SPEC_AZURE_REALTIME_ENV_FILE. Then restart the server and reload."
        );
    }
    if app.remote.is_some() {
        eprintln!(
            "WARNING: SSH spec build requests automatic tool approval (SPEC_BUILD_AUTO=1) with remote user privileges. Only run trusted specs."
        );
    }
    let server = router(app.clone())
        .fallback_service(ServeDir::new(ui))
        .layer(middleware::from_fn(
            |request: Request, next: Next| async move {
                let mut response = next.run(request).await;
                for (key, value) in [
                    ("x-content-type-options", "nosniff"),
                    ("referrer-policy", "no-referrer"),
                    ("content-security-policy", CSP),
                ] {
                    response
                        .headers_mut()
                        .insert(header::HeaderName::from_static(key), value.parse().unwrap());
                }
                response
            },
        ));
    axum::serve(listener, server)
        .with_graceful_shutdown(async move {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
            for job in app.jobs.lock().unwrap().iter() {
                // Server shutdown is not a user request to cancel remote work.
                let _ = job.stop.send_if_modified(|control| {
                    if *control == RunControl::Cancel {
                        false
                    } else {
                        *control = RunControl::Detach;
                        true
                    }
                });
            }
            for _ in 0..100 {
                if !app.jobs.lock().unwrap().iter().any(|job| job.attached) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod remote_tests;
