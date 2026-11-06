use super::*;
use nix::fcntl::{OFlag, openat};
use nix::sys::stat::Mode;
use std::os::unix::fs::MetadataExt;
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(test)]
#[path = "computeruse_tests.rs"]
mod tests;

#[derive(Clone)]
pub struct Config {
    local: PathBuf,
    remote: String,
    argv: Vec<String>,
}

impl Config {
    pub fn from_env(
        remote: Option<&Remote>,
    ) -> std::result::Result<Option<Self>, Box<dyn std::error::Error>> {
        let values = [
            "SPEC_COMPUTERUSE_LOCAL_FILE",
            "SPEC_COMPUTERUSE_REMOTE_FILE",
            "SPEC_COMPUTERUSE_COMMAND",
        ]
        .map(std::env::var_os);
        if values.iter().all(Option::is_none) {
            return Ok(None);
        }
        let [local, file, command] = values;
        let config = Self {
            local: local
                .ok_or("Set all three SPEC_COMPUTERUSE variables")?
                .into(),
            remote: file
                .ok_or("Set SPEC_COMPUTERUSE_REMOTE_FILE")?
                .into_string()
                .map_err(|_| "Remote file must be UTF-8")?,
            argv: serde_json::from_str(
                &command
                    .ok_or("Set SPEC_COMPUTERUSE_COMMAND")?
                    .into_string()
                    .map_err(|_| "Command must be UTF-8 JSON")?,
            )?,
        };
        config.validate(remote).map_err(|e| e.1)?;
        Ok(Some(config))
    }

    fn validate(&self, remote: Option<&Remote>) -> Result<()> {
        if remote.is_none() {
            return Err(invalid(
                "Computeruse requires the existing SSH Remote configuration",
            ));
        }
        path_parts(&self.local)?;
        path_parts(FsPath::new(&self.remote))?;
        if self.argv.is_empty()
            || self.argv.iter().any(|arg| arg.contains('\0'))
            || self
                .argv
                .iter()
                .filter(|arg| arg.as_str() == "{instructions}")
                .count()
                != 1
            || self
                .argv
                .iter()
                .any(|arg| arg.contains("{instructions}") && arg != "{instructions}")
        {
            return Err(invalid(
                "SPEC_COMPUTERUSE_COMMAND must be a nonempty JSON argv array with exactly one standalone {instructions}",
            ));
        }
        let executable = FsPath::new(&self.argv[0]);
        if !executable.is_absolute()
            || !executable.is_file()
            || fs::metadata(executable)?.permissions().mode() & 0o111 == 0
        {
            return Err(invalid(
                "Computeruse executable must be an absolute executable file",
            ));
        }
        LocalFile::open(&self.local)?.read()?;
        Ok(())
    }
}

#[derive(Default)]
pub struct Bridge {
    pub config: Option<Config>,
    gate: Arc<tokio::sync::Mutex<()>>,
    current: Mutex<Option<LocalRun>>,
    closed: AtomicBool,
    #[cfg(test)]
    after_mirror: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Bridge {
    pub fn new(config: Option<Config>) -> Self {
        Self {
            config,
            ..Self::default()
        }
    }
}

struct LocalRun {
    view: RunView,
    stop: watch::Sender<bool>,
    done: watch::Receiver<bool>,
}

#[derive(Clone, Serialize)]
struct RunView {
    id: String,
    name: String,
    status: String,
    output: String,
    truncated: bool,
}

#[derive(Serialize, Deserialize)]
pub struct SharedFile {
    content: String,
    revision: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Push {
    name: String,
    revision: String,
    remote_revision: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pull {
    name: String,
    revision: Option<String>,
}

fn configured(app: &App) -> Result<(&Config, &Remote)> {
    app.computeruse
        .config
        .as_ref()
        .zip(app.remote.as_ref())
        .ok_or_else(|| {
            Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Computeruse bridge is disabled".into(),
            )
        })
}

pub async fn status(State(app): State<App>) -> Json<serde_json::Value> {
    let config = configured(&app).ok().map(|(config, _)| config);
    Json(serde_json::json!({
        "configured": config.is_some(),
        "local_path": config.map(|c| &c.local),
        "remote_path": config.map(|c| &c.remote),
        "run": app.computeruse.current.lock().unwrap().as_ref().map(|r| &r.view),
    }))
}

pub async fn file(State(app): State<App>) -> Result<Json<SharedFile>> {
    let (config, remote) = configured(&app)?;
    exchange(
        remote,
        serde_json::json!({"operation":"read", "path":config.remote}),
    )
    .await
    .map(Json)
}

async fn exchange(remote: &Remote, request: serde_json::Value) -> Result<SharedFile> {
    let mut child = remote
        .computeruse_command()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()?;
    let _group = ProcessGroup(child.id().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let bytes = serde_json::to_vec(&request).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        let (_, out, err) = tokio::try_join!(
            async {
                stdin.write_all(&bytes).await?;
                stdin.shutdown().await?;
                drop(stdin);
                Ok::<_, std::io::Error>(())
            },
            limited(stdout, MAX_FILE * 6 + 4096),
            limited(stderr, 16 * 1024),
        )?;
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((status, out, err))
    })
    .await;
    let (status, out, _) = match result {
        Ok(Ok(result)) => result,
        failure => {
            let _ = killpg(Pid::from_raw(_group.0 as i32), Signal::SIGKILL);
            let _ = child.wait().await;
            return Err(Error(
                if failure.is_err() {
                    StatusCode::GATEWAY_TIMEOUT
                } else {
                    StatusCode::BAD_GATEWAY
                },
                "Shared-file SSH operation failed or exceeded its limits".into(),
            ));
        }
    };
    if !status.success() {
        return Err(Error(
            StatusCode::BAD_GATEWAY,
            "Shared-file SSH helper failed".into(),
        ));
    }
    let value: serde_json::Value = serde_json::from_slice(&out).map_err(|_| {
        Error(
            StatusCode::BAD_GATEWAY,
            "Invalid shared-file response".into(),
        )
    })?;
    if let Some(message) = value.get("error").and_then(|v| v.as_str()) {
        let code = match value["status"].as_u64() {
            Some(400) => StatusCode::BAD_REQUEST,
            Some(409) => StatusCode::CONFLICT,
            Some(504) => StatusCode::GATEWAY_TIMEOUT,
            _ => StatusCode::BAD_GATEWAY,
        };
        return Err(Error(code, message.to_owned()));
    }
    let shared: SharedFile = serde_json::from_value(value).map_err(|_| {
        Error(
            StatusCode::BAD_GATEWAY,
            "Invalid shared-file response".into(),
        )
    })?;
    if shared.content.len() > MAX_FILE
        || shared.content.contains('\0')
        || (request["operation"] == "write"
            && (request["content"].as_str() != Some(shared.content.as_str())
                || shared.revision.is_none()))
        || match &shared.revision {
            Some(revision) => *revision != digest(&shared.content),
            None => !shared.content.is_empty(),
        }
    {
        return Err(Error(
            StatusCode::BAD_GATEWAY,
            "Invalid shared-file content or revision".into(),
        ));
    }
    Ok(shared)
}

async fn limited(stream: impl AsyncRead + Unpin, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    stream
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > limit {
        return Err(std::io::Error::other("Response exceeds limit"));
    }
    Ok(bytes)
}

fn digest(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

fn path_parts(path: &FsPath) -> Result<Vec<&str>> {
    let text = path
        .to_str()
        .ok_or_else(|| invalid("Shared-file paths must be UTF-8"))?;
    let parts: Vec<_> = text
        .strip_prefix('/')
        .ok_or_else(|| invalid("Shared-file paths must be absolute"))?
        .split('/')
        .collect();
    if parts.iter().any(|part| {
        part.is_empty() || *part == "." || *part == ".." || part.chars().any(char::is_control)
    }) {
        return Err(invalid("Invalid shared-file path"));
    }
    Ok(parts)
}

// Pin each parent directory and never follow links, including during replacement.
struct LocalFile {
    parent: File,
    name: String,
}

impl LocalFile {
    fn open(path: &FsPath) -> Result<Self> {
        let parts = path_parts(path)?;
        let mut parent = File::open("/")?;
        for (index, part) in parts[..parts.len() - 1].iter().enumerate() {
            parent = File::from(
                openat(
                    &parent,
                    *part,
                    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                    Mode::empty(),
                )
                .map_err(std::io::Error::from)?,
            );
            let info = parent.metadata()?;
            let sticky = info.uid() == 0 && info.mode() & 0o1000 != 0 && index < parts.len() - 2;
            if ![0, unsafe { nix::libc::geteuid() }].contains(&info.uid())
                || (info.mode() & 0o022 != 0 && !sticky)
            {
                return Err(invalid("Unsafe shared-file parent"));
            }
        }
        Ok(Self {
            parent,
            name: parts.last().unwrap().to_string(),
        })
    }

    fn read(&self) -> Result<SharedFile> {
        let fd = match openat(
            &self.parent,
            self.name.as_str(),
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => fd,
            Err(nix::errno::Errno::ENOENT) => {
                return Ok(SharedFile {
                    content: String::new(),
                    revision: None,
                });
            }
            Err(error) => return Err(invalid(&format!("Unsafe shared file: {error}"))),
        };
        let file = File::from(fd);
        let info = file.metadata()?;
        if !info.is_file() || info.nlink() != 1 || info.len() > MAX_FILE as u64 {
            return Err(invalid("Shared file must be regular and at most 2 MiB"));
        }
        let mut content = String::new();
        file.take((MAX_FILE + 1) as u64)
            .read_to_string(&mut content)
            .map_err(|_| invalid("Shared file must be readable UTF-8"))?;
        if content.len() > MAX_FILE || content.contains('\0') {
            return Err(invalid("Shared file exceeds 2 MiB or contains NUL"));
        }
        Ok(SharedFile {
            revision: Some(digest(&content)),
            content,
        })
    }

    fn lock(&self) -> Result<nix::fcntl::Flock<File>> {
        // All writers must flock this persistent sidecar, not the replaced data inode.
        // Hash checks alone cannot exclude noncooperating external editors.
        let name = format!(".computeruse-lock-{}", digest(&self.name));
        let fd = openat(
            &self.parent,
            name.as_str(),
            OFlag::O_WRONLY
                | OFlag::O_CREAT
                | OFlag::O_NOFOLLOW
                | OFlag::O_NONBLOCK
                | OFlag::O_CLOEXEC,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(std::io::Error::from)?;
        let file = File::from(fd);
        if !file.metadata()?.is_file() || file.metadata()?.nlink() != 1 {
            return Err(invalid("Unsafe shared-file lock"));
        }
        nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock)
            .map_err(|_| Error(StatusCode::CONFLICT, "Shared-file writer is busy".into()))
    }

    fn directory(&self) -> PathBuf {
        use std::os::fd::AsRawFd;
        PathBuf::from(format!("/proc/self/fd/{}", self.parent.as_raw_fd()))
    }

    fn prepare(&self, content: &str) -> Result<(tempfile::NamedTempFile, Option<String>)> {
        let revision = self.read()?.revision;
        let mut file = tempfile::NamedTempFile::new_in(self.directory())?;
        file.write_all(content.as_bytes())?;
        file.as_file().sync_all()?;
        Ok((file, revision))
    }

    fn commit(
        &self,
        (file, revision): (tempfile::NamedTempFile, Option<String>),
        replaced: &mut bool,
    ) -> Result<()> {
        if self.read()?.revision != revision {
            return Err(Error(
                StatusCode::CONFLICT,
                "Local shared file changed during synchronization".into(),
            ));
        }
        file.persist(self.directory().join(&self.name))
            .map_err(|e| Error::from(e.error))?;
        *replaced = true;
        self.parent.sync_all()?;
        Ok(())
    }
}

fn sync_error(error: Error, outcome: &str) -> Error {
    Error(
        error.0,
        format!(
            "Synchronization incomplete: {outcome}. No callback executed. Read GET /api/computeruse/file, inspect the local shared file, and reload the editor to compare revisions before retrying. Cause: {}",
            error.1,
        ),
    )
}

async fn admission(app: &App) -> Result<tokio::sync::OwnedMutexGuard<()>> {
    configured(app)?;
    let guard = app.computeruse.gate.clone().try_lock_owned().map_err(|_| {
        Error(
            StatusCode::CONFLICT,
            "Computeruse synchronization is busy".into(),
        )
    })?;
    if app.computeruse.closed.load(Ordering::SeqCst) {
        return Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Computeruse is shutting down".into(),
        ));
    }
    Ok(guard)
}

pub async fn push(
    State(app): State<App>,
    Json(input): Json<Push>,
) -> Result<Json<serde_json::Value>> {
    synchronize(app, input, false).await
}

pub async fn run(
    State(app): State<App>,
    Json(input): Json<Push>,
) -> Result<Json<serde_json::Value>> {
    synchronize(app, input, true).await
}

async fn synchronize(app: App, input: Push, launch: bool) -> Result<Json<serde_json::Value>> {
    let guard = admission(&app).await?;
    if launch
        && app
            .computeruse
            .current
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|run| !*run.done.borrow())
    {
        return Err(Error(
            StatusCode::CONFLICT,
            "A computeruse run is already active".into(),
        ));
    }
    // Accepted operations are server-owned: disconnecting the HTTP waiter does not
    // cancel synchronization or its callback. Shutdown still suppresses new launches.
    let worker = tokio::spawn(async move {
        let _guard = guard;
        let state = app.clone();
        let handle = tokio::runtime::Handle::current();
        let name = input.name.clone();
        let (shared, snapshot) = tokio::task::spawn_blocking(move || {
            let (config, remote) = configured(&state)?;
            let document = {
                let _files = state.files.lock().unwrap();
                read(&state.root, &input.name)?
            };
            if document.revision != input.revision {
                return Err(Error(StatusCode::CONFLICT, "Save your current editor revision before syncing".into()));
            }
            let local = LocalFile::open(&config.local)?;
            let _lock = local.lock()?;
            let prepared = local.prepare(&document.content)?;
            let snapshot = if launch {
                let directory = tempfile::Builder::new().prefix(".computeruse-").tempdir_in(&state.root)?;
                let path = directory.path().join("instructions.txt");
                let mut file = OpenOptions::new().write(true).create_new(true).mode(0o400).open(path)?;
                file.write_all(document.content.as_bytes())?;
                file.sync_all()?;
                Some(directory)
            } else { None };
            let shared = handle.block_on(exchange(remote, serde_json::json!({
                "operation":"write", "path":config.remote, "content":document.content, "revision":input.remote_revision,
            }))).map_err(|error| sync_error(error,
                "remote write was not confirmed and the remote file may have changed; local mirror replacement and editor replacement were not attempted"))?;
            {
                let _files = state.files.lock().unwrap();
                let mut replaced = false;
                local.commit(prepared, &mut replaced).map_err(|error| sync_error(error, if replaced {
                    "remote file updated; local mirror replaced but durability is uncertain; editor replacement not attempted"
                } else {
                    "remote file updated; local mirror not replaced by this operation; editor replacement not attempted"
                }))?;
            }
            Ok::<_, Error>((shared, snapshot))
        }).await.map_err(|_| Error(StatusCode::INTERNAL_SERVER_ERROR, "Shared-file worker failed".into()))??;
        let mut response = serde_json::to_value(&shared).unwrap();
        if let Some(snapshot) = snapshot {
            let run = start_local(&app, name, snapshot).map_err(|error| sync_error(error,
                "remote file and local mirror updated; editor replacement not attempted; local launch did not occur"))?;
            response["run"] = serde_json::to_value(run).unwrap();
        }
        Ok(Json(response))
    });
    worker.await.map_err(|_| {
        Error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Shared-file worker failed".into(),
        )
    })?
}

pub async fn pull(State(app): State<App>, Json(input): Json<Pull>) -> Result<Json<Document>> {
    let guard = admission(&app).await?;
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let (config, remote) = configured(&app)?;
        validate(&input.name)?;
        let shared = handle.block_on(exchange(
            remote,
            serde_json::json!({"operation":"read", "path":config.remote}),
        ))?;
        let revision = shared.revision.ok_or_else(|| {
            Error(
                StatusCode::NOT_FOUND,
                "Remote shared file does not exist".into(),
            )
        })?;
        let _files = app.files.lock().unwrap();
        let current = match read(&app.root, &input.name) {
            Ok(doc) => Some(doc.revision),
            Err(Error(StatusCode::NOT_FOUND, _)) => None,
            Err(error) => return Err(error),
        };
        if current != input.revision {
            return Err(Error(
                StatusCode::CONFLICT,
                "Editor changed before pull".into(),
            ));
        }
        let local = LocalFile::open(&config.local)?;
        let _lock = local.lock()?;
        local.read()?;
        let mirror = local.prepare(&shared.content)?;
        let mut editor = tempfile::NamedTempFile::new_in(&app.root)?;
        editor.write_all(shared.content.as_bytes())?;
        editor.as_file().sync_all()?;
        let mut mirror_replaced = false;
        local.commit(mirror, &mut mirror_replaced).map_err(|error| sync_error(error, if mirror_replaced {
            "remote file not modified by pull; local mirror replaced but durability is uncertain; editor replacement not attempted"
        } else {
            "remote file not modified by pull; local mirror not replaced by this operation; editor replacement not attempted"
        }))?;
        #[cfg(test)]
        if let Some(hook) = app.computeruse.after_mirror.lock().unwrap().take() {
            hook();
        }
        editor
            .persist(app.root.join(&input.name))
            .map_err(|e| sync_error(Error::from(e.error),
                "remote file not modified by pull; local mirror updated; editor not replaced by this operation"))?;
        File::open(&app.root).and_then(|directory| directory.sync_all()).map_err(|error| sync_error(Error::from(error),
            "remote file not modified by pull; local mirror and editor replaced but editor durability is uncertain"))?;
        Ok(Json(Document {
            name: input.name,
            content: shared.content,
            revision,
        }))
    })
    .await
    .map_err(|_| {
        Error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Shared-file worker failed".into(),
        )
    })?
}

struct ProcessGroup(u32);

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        let _ = killpg(Pid::from_raw(self.0 as i32), Signal::SIGKILL);
    }
}

fn start_local(app: &App, name: String, snapshot: tempfile::TempDir) -> Result<RunView> {
    let (config, _) = configured(app)?;
    // Shutdown sets closed under this same lock, making closure and spawn ordered.
    let mut current = app.computeruse.current.lock().unwrap();
    if app.computeruse.closed.load(Ordering::SeqCst) {
        return Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Computeruse is shutting down".into(),
        ));
    }
    let path = snapshot.path().join("instructions.txt");
    let args: Vec<_> = config.argv[1..]
        .iter()
        .map(|arg| {
            if arg == "{instructions}" {
                path.as_os_str()
            } else {
                std::ffi::OsStr::new(arg)
            }
        })
        .collect();
    // Local means this server's computer. Only operator argv can opt into --execute.
    let mut child = tokio::process::Command::new(&config.argv[0])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()?;
    let group = ProcessGroup(child.id().unwrap());
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (stop, mut control) = watch::channel(false);
    let (finished, done) = watch::channel(false);
    let view = RunView {
        id: Uuid::new_v4().to_string(),
        name,
        status: "running".into(),
        output: String::new(),
        truncated: false,
    };
    *current = Some(LocalRun {
        view: view.clone(),
        stop,
        done,
    });
    let bridge = app.computeruse.clone();
    tokio::spawn(async move {
        let _snapshot = snapshot;
        let out = tokio::spawn(capture(bridge.clone(), stdout));
        let err = tokio::spawn(capture(bridge.clone(), stderr));
        let status = tokio::select! {
            biased;
            _ = control.wait_for(|stop| *stop) => "cancelled",
            result = child.wait() => if result.is_ok_and(|exit| exit.success()) { "completed" } else { "failed" },
            _ = tokio::time::sleep(Duration::from_secs(24 * 60 * 60)) => "failed",
        };
        // Signal the group even if its leader exited: descendants may own the pipes.
        let _ = killpg(Pid::from_raw(group.0 as i32), Signal::SIGTERM);
        tokio::time::sleep(Duration::from_secs(2)).await;
        drop(group);
        let _ = child.wait().await;
        for mut task in [out, err] {
            if tokio::time::timeout(Duration::from_secs(2), &mut task)
                .await
                .is_err()
            {
                task.abort();
                let _ = task.await;
            }
        }
        bridge.current.lock().unwrap().as_mut().unwrap().view.status = status.into();
        finished.send_replace(true);
    });
    Ok(view)
}

async fn capture(bridge: Arc<Bridge>, mut stream: impl AsyncRead + Unpin) {
    let mut buffer = [0; 8192];
    let mut pending = Vec::new();
    loop {
        let count = stream.read(&mut buffer).await.unwrap_or(0);
        pending.extend_from_slice(&buffer[..count]);
        // Retain only an incomplete UTF-8 suffix (at most three bytes) per pipe.
        // Invalid sequences are rendered lossily; an unfinished suffix waits for EOF.
        let mut complete = 0;
        while complete < pending.len() {
            match std::str::from_utf8(&pending[complete..]) {
                Ok(_) => {
                    complete = pending.len();
                }
                Err(error) => {
                    complete += error.valid_up_to();
                    if let Some(length) = error.error_len() {
                        complete += length;
                    } else {
                        break;
                    }
                }
            }
        }
        if count == 0 {
            complete = pending.len();
        }
        let mut current = bridge.current.lock().unwrap();
        let run = &mut current.as_mut().unwrap().view;
        run.output
            .push_str(&String::from_utf8_lossy(&pending[..complete]));
        pending.drain(..complete);
        if run.output.len() > MAX_OUTPUT {
            let mut remove = run.output.len() - MAX_OUTPUT;
            while !run.output.is_char_boundary(remove) {
                remove += 1;
            }
            run.output.drain(..remove);
            run.truncated = true;
        }
        if count == 0 {
            break;
        }
    }
}

pub async fn cancel(
    State(app): State<App>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    configured(&app)?;
    let mut current = app.computeruse.current.lock().unwrap();
    let run = current
        .as_mut()
        .filter(|run| run.view.id == id)
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "Computeruse run not found".into()))?;
    if !*run.done.borrow() {
        run.stop.send_replace(true);
    }
    Ok(Json(serde_json::json!({"run":run.view})))
}

pub async fn shutdown(app: &App) {
    {
        let current = app.computeruse.current.lock().unwrap();
        app.computeruse.closed.store(true, Ordering::SeqCst);
        if let Some(run) = current.as_ref() {
            run.stop.send_replace(true);
        }
    }
    let _gate = app.computeruse.gate.lock().await;
    let done = app.computeruse.current.lock().unwrap().as_ref().map(|run| {
        run.stop.send_replace(true);
        run.done.clone()
    });
    if let Some(mut done) = done {
        let _ = done.wait_for(|done| *done).await;
    }
}
