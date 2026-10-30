use crate::{App, Completion, Error, Result, invalid};
use axum::{
    Json,
    extract::{State, rejection::JsonRejection},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::Semaphore;

pub const MAX_BODY: usize = 48 * 1024;

// Deliberately not Debug: this is also the private execution-agent handoff.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub provider: String,
    pub model: String,
    pub endpoint: String,
    pub api_version: String,
    pub api_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    provider: String,
    model: String,
    endpoint: String,
    api_version: String,
    #[serde(default, deserialize_with = "present_key")]
    api_key: Option<String>,
}

fn present_key<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    provider: String,
    model: String,
    endpoint: String,
    api_version: String,
    has_api_key: bool,
    source: &'static str,
}

#[derive(Default)]
struct Active {
    saved: Option<(Profile, Completion)>,
}

pub struct Store {
    path: PathBuf,
    active: Mutex<Active>,
    environment: Option<Profile>,
    slots: Arc<Semaphore>,
}

impl Store {
    pub fn from_env(
        root: &Path,
        ui: &Path,
        completion: Option<&Completion>,
    ) -> std::result::Result<Self, &'static str> {
        let path = std::env::var_os("SPEC_SETTINGS_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                root.parent()
                    .unwrap_or(root)
                    .join(format!(
                        ".spec-settings-{:x}",
                        Sha256::digest(root.as_os_str().as_encoded_bytes())
                    ))
                    .join("profile.json")
            });
        Self::open(path, root, ui, completion)
            .map_err(|_| "Could not open private AI settings storage")
    }

    pub fn open(
        path: PathBuf,
        root: &Path,
        ui: &Path,
        completion: Option<&Completion>,
    ) -> Result<Self> {
        if !path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
            || path.file_name().is_none()
        {
            return Err(storage_error());
        }
        let root = resolved(root).map_err(|_| storage_error())?;
        let ui = resolved(ui).map_err(|_| storage_error())?;
        if path.starts_with(&root) || path.starts_with(&ui) {
            return Err(storage_error());
        }
        let store = Self {
            path,
            active: Mutex::new(Active::default()),
            environment: completion.map(Completion::profile),
            slots: completion
                .map(|c| c.slots.clone())
                .unwrap_or_else(|| Arc::new(Semaphore::new(4))),
        };
        if let Some(directory) = store.directory(false)?
            && let Some(bytes) = store.bytes(&directory)?
        {
            let profile: Option<Profile> =
                serde_json::from_slice(&bytes).map_err(|_| storage_error())?;
            if let Some(profile) = profile {
                let mut completion =
                    Completion::from_profile(&profile).map_err(|_| storage_error())?;
                completion.slots = store.slots.clone();
                store.active.lock().unwrap().saved = Some((profile, completion));
            }
        }
        Ok(store)
    }

    pub fn profile(&self) -> Option<Profile> {
        self.active
            .lock()
            .unwrap()
            .saved
            .as_ref()
            .map(|(p, _)| p.clone())
    }

    pub fn completion(&self) -> Option<Completion> {
        self.active
            .lock()
            .unwrap()
            .saved
            .as_ref()
            .map(|(_, c)| c.clone())
    }

    fn view(&self, active: &Active) -> View {
        let profile = active
            .saved
            .as_ref()
            .map(|(p, _)| p)
            .or(self.environment.as_ref());
        View {
            provider: profile.map_or("azure", |p| &p.provider).into(),
            model: profile.map_or("", |p| &p.model).into(),
            endpoint: profile.map_or("", |p| &p.endpoint).into(),
            api_version: profile.map_or("", |p| &p.api_version).into(),
            has_api_key: profile.is_some_and(|p| !p.api_key.is_empty()),
            source: if active.saved.is_some() {
                "settings"
            } else if profile.is_some() {
                "environment"
            } else {
                "none"
            },
        }
    }

    fn update(&self, input: Option<Input>) -> Result<View> {
        let mut active = self.active.lock().unwrap();
        let saved = if let Some(input) = input {
            let prior = active
                .saved
                .as_ref()
                .map(|(p, _)| p)
                .or(self.environment.as_ref());
            let key = input.api_key.unwrap_or_else(|| {
                prior
                    .filter(|p| p.provider == input.provider && p.endpoint == input.endpoint)
                    .map(|p| p.api_key.clone())
                    .unwrap_or_default()
            });
            let profile = Profile {
                provider: input.provider,
                model: input.model,
                endpoint: input.endpoint,
                api_version: input.api_version,
                api_key: key,
            };
            let mut completion = Completion::from_profile(&profile).map_err(invalid)?;
            completion.slots = self.slots.clone();
            Some((profile, completion))
        } else {
            None
        };
        let bytes =
            serde_json::to_vec(&saved.as_ref().map(|(p, _)| p)).map_err(|_| storage_error())?;
        self.persist(&bytes)?;
        // Publication and credential retention share the same lock and commit point.
        active.saved = saved;
        Ok(self.view(&active))
    }

    fn directory(&self, create: bool) -> Result<Option<File>> {
        let parent = self.path.parent().ok_or_else(storage_error)?;
        let mut directory = File::open("/").map_err(|_| storage_error())?;
        let components: Vec<_> = parent
            .components()
            .filter_map(|c| {
                if let Component::Normal(c) = c {
                    Some(c)
                } else {
                    None
                }
            })
            .collect();
        if components.is_empty() {
            return Err(storage_error());
        }
        for (i, component) in components.iter().enumerate() {
            let last = i + 1 == components.len();
            let path = anchored(&directory).join(component);
            if last && create {
                match fs::DirBuilder::new().mode(0o700).create(&path) {
                    Ok(()) => directory.sync_all().map_err(|_| storage_error())?,
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(_) => return Err(storage_error()),
                }
            }
            directory = match OpenOptions::new()
                .read(true)
                .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW)
                .open(&path)
            {
                Ok(file) => file,
                Err(e) if !create && last && e.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(None);
                }
                Err(_) => return Err(storage_error()),
            };
            let metadata = directory.metadata().map_err(|_| storage_error())?;
            let uid = unsafe { nix::libc::geteuid() };
            let mode = metadata.permissions().mode();
            if last {
                private(&metadata, true)?;
            } else if (metadata.uid() != uid && metadata.uid() != 0)
                || (mode & 0o022 != 0 && !(metadata.uid() == 0 && mode & 0o1000 != 0))
            {
                return Err(storage_error());
            }
        }
        Ok(Some(directory))
    }

    fn bytes(&self, directory: &File) -> Result<Option<Vec<u8>>> {
        let path = anchored(directory).join(self.path.file_name().unwrap());
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
            .open(path)
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(storage_error()),
        };
        let metadata = file.metadata().map_err(|_| storage_error())?;
        private(&metadata, false)?;
        if metadata.len() > MAX_BODY as u64 {
            return Err(storage_error());
        }
        let mut bytes = Vec::new();
        file.take((MAX_BODY + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| storage_error())?;
        if bytes.len() > MAX_BODY {
            return Err(storage_error());
        }
        Ok(Some(bytes))
    }

    fn persist(&self, bytes: &[u8]) -> Result<()> {
        if bytes.len() > MAX_BODY {
            return Err(storage_error());
        }
        let directory = self.directory(true)?.ok_or_else(storage_error)?;
        self.bytes(&directory)?;
        let mut temp =
            tempfile::NamedTempFile::new_in(anchored(&directory)).map_err(|_| storage_error())?;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| storage_error())?;
        temp.write_all(bytes).map_err(|_| storage_error())?;
        temp.as_file().sync_all().map_err(|_| storage_error())?;
        directory.sync_all().map_err(|_| storage_error())?;
        temp.persist(anchored(&directory).join(self.path.file_name().unwrap()))
            .map_err(|_| storage_error())?;
        // Rename commits the transaction. A later fsync error cannot be reported as
        // a rejected update: the new file is already visible and must match memory.
        let _ = directory.sync_all();
        Ok(())
    }
}

// Resolve existing ancestors of a possibly not-yet-built static directory.
fn resolved(path: &Path) -> std::io::Result<PathBuf> {
    match path.canonicalize() {
        Ok(path) => return Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    // A dangling static-root symlink must not become a route to the private
    // directory when the first settings write creates its target.
    if fs::symlink_metadata(path).is_ok() {
        return Err(std::io::Error::other("Unresolved static path"));
    }
    let path = std::path::absolute(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("Invalid path"))?;
    Ok(resolved(parent)?.join(
        path.file_name()
            .ok_or_else(|| std::io::Error::other("Invalid path"))?,
    ))
}

fn anchored(directory: &File) -> PathBuf {
    PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()))
}

fn private(metadata: &fs::Metadata, directory: bool) -> Result<()> {
    if metadata.uid() != unsafe { nix::libc::geteuid() }
        || metadata.permissions().mode() & 0o777 != if directory { 0o700 } else { 0o600 }
        || (directory && !metadata.is_dir())
        || (!directory && (!metadata.is_file() || metadata.nlink() != 1))
    {
        return Err(storage_error());
    }
    Ok(())
}

fn storage_error() -> Error {
    Error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Could not access private AI settings storage".into(),
    )
}

pub async fn get(State(app): State<App>) -> Json<View> {
    Json(app.settings.view(&app.settings.active.lock().unwrap()))
}

pub async fn put(
    State(app): State<App>,
    input: std::result::Result<Json<Input>, JsonRejection>,
) -> Result<Json<View>> {
    let Json(input) = input.map_err(|e| Error(e.status(), "Invalid settings request".into()))?;
    let store = app.settings.clone();
    tokio::task::spawn_blocking(move || store.update(Some(input)))
        .await
        .map_err(|_| storage_error())?
        .map(Json)
}

pub async fn delete(State(app): State<App>) -> Result<Json<View>> {
    let store = app.settings.clone();
    tokio::task::spawn_blocking(move || store.update(None))
        .await
        .map_err(|_| storage_error())?
        .map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{app, json as response_json, request};
    use axum::{
        body::Body,
        http::{Request, header},
    };
    use serde_json::{Value, json};
    use std::os::unix::fs::symlink;
    use tower::ServiceExt;

    fn fixture() -> (tempfile::TempDir, App, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let path = root.path().join(".private/profile.json");
        let mut state = app(&workspace);
        state.settings = Arc::new(
            Store::open(path.clone(), &workspace, &root.path().join("ui"), None)
                .ok()
                .unwrap(),
        );
        (root, state, path)
    }

    fn input() -> Value {
        json!({"provider": "openai", "model": "gpt-5", "endpoint": "https://api.openai.com/v1", "apiVersion": "", "apiKey": "mock-secret"})
    }

    fn update(store: &Store, input: Value) -> Result<View> {
        store.update(Some(serde_json::from_value(input).unwrap()))
    }

    #[tokio::test]
    async fn settings_roundtrip_is_redacted_private_and_survives_restart() {
        let (root, state, path) = fixture();
        let response = request(state.clone(), "GET", "/api/settings", Value::Null).await;
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            response_json(response).await,
            json!({"provider": "azure", "model": "", "endpoint": "", "apiVersion": "", "hasApiKey": false, "source": "none"})
        );
        let response = request(state.clone(), "PUT", "/api/settings", input()).await;
        assert_eq!(response.status(), StatusCode::OK);
        let view = response_json(response).await;
        assert_eq!(
            view,
            json!({"provider": "openai", "model": "gpt-5", "endpoint": "https://api.openai.com/v1", "apiVersion": "", "hasApiKey": true, "source": "settings"})
        );
        assert!(!view.to_string().contains("mock-secret"));
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        assert_eq!(
            fs::metadata(path.parent().unwrap()).unwrap().mode() & 0o777,
            0o700
        );
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        let stored: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored, input());
        let mut restarted = state.clone();
        restarted.settings = Arc::new(
            Store::open(path, &state.root, &root.path().join("ui"), None)
                .ok()
                .unwrap(),
        );
        assert_eq!(restarted.settings.profile().unwrap().api_key, "mock-secret");
        assert_eq!(
            response_json(request(restarted.clone(), "GET", "/api/settings", Value::Null).await)
                .await,
            view
        );
        let config =
            response_json(request(restarted.clone(), "GET", "/api/config", Value::Null).await)
                .await;
        assert_eq!(config["completion"], true);
        assert_eq!(config["chat"], true);
        assert!(restarted.ai_completion().is_some());
        assert_eq!(
            response_json(request(restarted, "GET", "/api/files", Value::Null).await).await,
            json!([])
        );
    }

    #[test]
    fn settings_keys_are_retained_only_for_identical_provider_and_endpoint() {
        let (_root, state, _path) = fixture();
        assert!(update(&state.settings, input()).is_ok());
        let mut omitted = input();
        omitted.as_object_mut().unwrap().remove("apiKey");
        omitted["model"] = json!("gpt-5.1");
        assert!(update(&state.settings, omitted.clone()).is_ok());
        assert_eq!(state.settings.profile().unwrap().api_key, "mock-secret");
        for (field, value) in [
            ("provider", "openrouter"),
            ("endpoint", "https://other.test/v1"),
            ("apiKey", ""),
        ] {
            let mut changed = omitted.clone();
            changed[field] = json!(value);
            assert!(update(&state.settings, changed).is_err());
            assert_eq!(state.settings.profile().unwrap().api_key, "mock-secret");
        }
        let mut local = json!({"provider": "huggingface", "model": "org/model", "endpoint": "http://127.0.0.1:8080/v1", "apiVersion": "", "apiKey": "local-secret"});
        assert!(update(&state.settings, local.clone()).is_ok());
        local["apiKey"] = json!("");
        assert!(update(&state.settings, local.clone()).is_ok());
        assert!(state.settings.profile().unwrap().api_key.is_empty());
        local.as_object_mut().unwrap().remove("apiKey");
        local["endpoint"] = json!("http://localhost:8081/v1");
        assert!(update(&state.settings, local).is_ok());
        assert!(state.settings.profile().unwrap().api_key.is_empty());
    }

    #[tokio::test]
    async fn settings_delete_restores_environment_without_reloading_or_mutating_it() {
        let (root, mut state, path) = fixture();
        let profile = Profile {
            provider: "azure".into(),
            model: "deployment".into(),
            endpoint: "https://azure.test/openai/v1".into(),
            api_version: String::new(),
            api_key: "environment-secret".into(),
        };
        state.completion = Some(Completion::from_profile(&profile).unwrap());
        state.settings = Arc::new(
            Store::open(
                path.clone(),
                &state.root,
                &root.path().join("ui"),
                state.completion.as_ref(),
            )
            .ok()
            .unwrap(),
        );
        let environment =
            response_json(request(state.clone(), "GET", "/api/settings", Value::Null).await).await;
        assert_eq!(environment["source"], "environment");
        let mut keep_env = serde_json::to_value(profile).unwrap();
        keep_env.as_object_mut().unwrap().remove("apiKey");
        assert!(update(&state.settings, keep_env).is_ok());
        assert_eq!(
            state.settings.profile().unwrap().api_key,
            "environment-secret"
        );
        assert!(update(&state.settings, input()).is_ok());
        let response = request(state.clone(), "DELETE", "/api/settings", Value::Null).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response_json(response).await, environment);
        assert!(state.settings.profile().is_none());
        assert_eq!(
            state.ai_completion().unwrap().profile().api_key,
            "environment-secret"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "null");
        let restarted = Store::open(
            path,
            &state.root,
            &root.path().join("ui"),
            state.completion.as_ref(),
        )
        .ok()
        .unwrap();
        assert!(restarted.profile().is_none());
        assert_eq!(
            restarted.view(&restarted.active.lock().unwrap()).source,
            "environment"
        );
        assert_eq!(
            request(state, "DELETE", "/api/settings", Value::Null)
                .await
                .status(),
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn settings_auth_validation_and_body_errors_never_echo_secrets() {
        let (_root, state, _path) = fixture();
        for method in ["GET", "PUT", "DELETE"] {
            for token in [None, Some("Bearer wrong")] {
                let mut req = Request::builder().method(method).uri("/api/settings");
                if let Some(token) = token {
                    req = req.header(header::AUTHORIZATION, token);
                }
                let response = crate::router(state.clone())
                    .oneshot(req.body(Body::empty()).unwrap())
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            }
        }
        for body in [
            json!({"mock-secret": "value"}),
            json!({"provider": "mock-secret"}),
            {
                let mut value = input();
                value["apiKey"] = Value::Null;
                value
            },
        ] {
            let response = request(state.clone(), "PUT", "/api/settings", body).await;
            assert!(response.status().is_client_error());
            assert!(
                !response_json(response)
                    .await
                    .to_string()
                    .contains("mock-secret")
            );
        }
        for (field, value) in [
            ("provider", "mock-secret".into()),
            ("model", "../mock-secret".into()),
            ("model", "x".repeat(257)),
            ("apiKey", "x".repeat(4097)),
            ("apiKey", "mock-secret\n".into()),
            ("apiVersion", "x".repeat(129)),
            ("endpoint", "https://user:mock-secret@api.test/v1".into()),
        ] {
            let mut body = input();
            body[field] = json!(value);
            let response = request(state.clone(), "PUT", "/api/settings", body).await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{field}");
            assert!(
                !response_json(response)
                    .await
                    .to_string()
                    .contains("mock-secret")
            );
        }
        let response = request(
            state.clone(),
            "PUT",
            "/api/settings",
            json!({"apiKey": "x".repeat(MAX_BODY + 1)}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(state.settings.profile().is_none());
    }

    #[test]
    fn settings_save_and_delete_failure_leave_profile_and_completion_unchanged() {
        let (_root, state, path) = fixture();
        assert!(update(&state.settings, input()).is_ok());
        let original = fs::read(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        for value in [Some(serde_json::from_value(input()).unwrap()), None] {
            assert!(state.settings.update(value).is_err());
            assert_eq!(state.settings.profile().unwrap().api_key, "mock-secret");
            assert_eq!(
                state.settings.completion().unwrap().profile().api_key,
                "mock-secret"
            );
            assert_eq!(fs::read(&path).unwrap(), original);
        }
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(state.settings.update(None).is_ok());
        assert!(state.ai_completion().is_none());
    }

    #[test]
    fn settings_storage_rejects_unsafe_files_and_directories_and_public_roots() {
        for kind in [
            "symlink",
            "hardlink",
            "fifo",
            "directory",
            "public",
            "oversized",
            "malformed",
            "invalid-profile",
            "public-dir",
            "linked-dir",
        ] {
            let (root, state, path) = fixture();
            let directory = path.parent().unwrap();
            fs::DirBuilder::new().mode(0o700).create(directory).unwrap();
            let outside = root.path().join("outside");
            fs::write(&outside, "mock-secret").unwrap();
            match kind {
                "symlink" => symlink(&outside, &path).unwrap(),
                "hardlink" => {
                    fs::set_permissions(&outside, fs::Permissions::from_mode(0o600)).unwrap();
                    fs::hard_link(&outside, &path).unwrap();
                }
                "fifo" => nix::unistd::mkfifo(
                    &path,
                    nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
                )
                .unwrap(),
                "directory" => fs::create_dir(&path).unwrap(),
                "public-dir" => {
                    fs::set_permissions(directory, fs::Permissions::from_mode(0o755)).unwrap()
                }
                "linked-dir" => {
                    fs::remove_dir(directory).unwrap();
                    symlink(root.path(), directory).unwrap();
                }
                _ => {
                    fs::write(
                        &path,
                        match kind {
                            "oversized" => "x".repeat(MAX_BODY + 1),
                            "malformed" => "mock-secret".into(),
                            "invalid-profile" => {
                                json!({"provider":"unknown", "apiKey":"mock-secret"}).to_string()
                            }
                            _ => "null".into(),
                        },
                    )
                    .unwrap();
                    fs::set_permissions(
                        &path,
                        fs::Permissions::from_mode(if kind == "public" { 0o644 } else { 0o600 }),
                    )
                    .unwrap();
                }
            }
            assert!(
                Store::open(path.clone(), &state.root, &root.path().join("ui"), None).is_err(),
                "{kind}"
            );
            if !matches!(kind, "malformed" | "invalid-profile") {
                assert!(update(&state.settings, input()).is_err(), "{kind}");
            }
            assert_eq!(fs::read_to_string(outside).unwrap(), "mock-secret");
        }
        let (root, state, _) = fixture();
        for path in [
            state.root.join(".private/profile.json"),
            root.path().join("ui/.private/profile.json"),
            state.root.join("public.out"),
            PathBuf::from("relative/profile.json"),
        ] {
            assert!(Store::open(path, &state.root, &root.path().join("ui"), None).is_err());
        }
        let path = root.path().join(".private/profile.json");
        let ui = root.path().join("ui-link");
        symlink(path.parent().unwrap(), &ui).unwrap();
        assert!(Store::open(path, &state.root, &ui, None).is_err());
    }

    #[test]
    fn settings_provider_switches_share_the_environment_concurrency_budget() {
        let (root, mut state, path) = fixture();
        state.completion =
            Some(Completion::from_profile(&serde_json::from_value(input()).unwrap()).unwrap());
        state.settings = Arc::new(
            Store::open(
                path,
                &state.root,
                &root.path().join("ui"),
                state.completion.as_ref(),
            )
            .ok()
            .unwrap(),
        );
        let slots = state.completion.as_ref().unwrap().slots.clone();
        assert!(update(&state.settings, input()).is_ok());
        assert!(Arc::ptr_eq(
            &slots,
            &state.settings.completion().unwrap().slots
        ));
        let mut next = input();
        next["provider"] = json!("claude");
        next["endpoint"] = json!("https://api.anthropic.com");
        assert!(update(&state.settings, next).is_ok());
        assert!(Arc::ptr_eq(
            &slots,
            &state.settings.completion().unwrap().slots
        ));
    }
}
