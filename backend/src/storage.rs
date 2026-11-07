use crate::{App, Error, Result, invalid, settings::PrivateFile};
use axum::{
    Json,
    body::Bytes,
    extract::{
        State,
        rejection::{BytesRejection, JsonRejection},
    },
    http::StatusCode,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use reqwest::{
    Client, Method, Url,
    header::{HeaderMap, HeaderValue},
};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::{
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
use tokio::{
    io::AsyncReadExt,
    sync::{OwnedSemaphorePermit, Semaphore},
};

pub const MAX_BODY: usize = 4096;
const CONTENT_TYPE: &str = "text/plain; charset=utf-8";
const VERSION: &str = "2023-11-03";

// Never Debug or part of an AI profile / execution handoff.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    account_name: String,
    container_name: String,
    account_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    account_name: String,
    container_name: String,
    #[serde(default, deserialize_with = "crate::settings::present_key")]
    account_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadInput {
    account_name: String,
    container_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    account_name: String,
    container_name: String,
    has_account_key: bool,
}

#[derive(Default, Serialize)]
pub struct Counts {
    uploaded: usize,
    skipped: usize,
    failed: usize,
}

pub struct Store {
    file: PrivateFile,
    active: Mutex<Option<Config>>,
    gate: Arc<Semaphore>,
    client: Client,
    #[cfg(test)]
    endpoint: Option<Url>,
}

fn local_error() -> Error {
    Error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Could not access private storage settings or workspace snapshot".into(),
    )
}

fn upstream_error() -> Error {
    Error(StatusCode::BAD_GATEWAY, "Could not verify the existing private Azure container; check storage credentials and container configuration".into())
}

impl Config {
    fn key(&self) -> Result<Vec<u8>> {
        if !(3..=24).contains(&self.account_name.len())
            || !self
                .account_name
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        {
            return Err(invalid(
                "Storage account name must be 3-24 lowercase letters or digits",
            ));
        }
        let container = &self.container_name;
        if !(3..=63).contains(&container.len())
            || !container
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            || container.starts_with('-')
            || container.ends_with('-')
            || container.contains("--")
        {
            return Err(invalid(
                "Container name must be 3-63 lowercase letters, digits or single interior hyphens",
            ));
        }
        // Azure account access keys are base64-encoded 512-bit keys, not SAS tokens.
        if self.account_key.len() != 88 {
            return Err(invalid("A base64 Azure storage account key is required"));
        }
        STANDARD
            .decode(&self.account_key)
            .ok()
            .filter(|key| key.len() == 64)
            .ok_or_else(|| invalid("A base64 Azure storage account key is required"))
    }
}

impl Store {
    pub fn open(file: PrivateFile) -> Result<Self> {
        let active: Option<Config> = match file.load().map_err(|_| local_error())? {
            Some(bytes) => serde_json::from_slice(&bytes).map_err(|_| local_error())?,
            None => None,
        };
        if let Some(config) = &active {
            config.key().map_err(|_| local_error())?;
        }
        Ok(Self {
            file,
            active: Mutex::new(active),
            gate: Arc::new(Semaphore::new(1)),
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .no_proxy()
                .build()
                .map_err(|_| local_error())?,
            #[cfg(test)]
            endpoint: None,
        })
    }

    fn permit(&self) -> Result<OwnedSemaphorePermit> {
        self.gate.clone().try_acquire_owned().map_err(|_| {
            Error(
                StatusCode::CONFLICT,
                "A storage upload or settings change is already in progress".into(),
            )
        })
    }

    fn view(&self) -> View {
        let active = self.active.lock().unwrap();
        View {
            account_name: active.as_ref().map_or("", |c| &c.account_name).into(),
            container_name: active.as_ref().map_or("", |c| &c.container_name).into(),
            has_account_key: active.is_some(),
        }
    }

    fn update(&self, input: Option<Input>, _permit: OwnedSemaphorePermit) -> Result<View> {
        let mut active = self.active.lock().unwrap();
        let next = match input {
            Some(input) => {
                let account_key = input.account_key.unwrap_or_else(|| {
                    active
                        .as_ref()
                        .filter(|c| c.account_name == input.account_name)
                        .map(|c| c.account_key.clone())
                        .unwrap_or_default()
                });
                let config = Config {
                    account_name: input.account_name,
                    container_name: input.container_name,
                    account_key,
                };
                config.key()?;
                Some(config)
            }
            None => None,
        };
        self.file
            .persist(&serde_json::to_vec(&next).map_err(|_| local_error())?)
            .map_err(|_| local_error())?;
        *active = next;
        drop(active);
        Ok(self.view())
    }

    fn url(&self, config: &Config, name: Option<&str>) -> Result<Url> {
        let mut url = Url::parse(&format!(
            "https://{}.blob.core.windows.net/",
            config.account_name
        ))
        .map_err(|_| local_error())?;
        #[cfg(test)]
        if let Some(endpoint) = &self.endpoint {
            url = endpoint.clone();
        }
        url.path_segments_mut()
            .map_err(|_| local_error())?
            .clear()
            .push(&config.container_name);
        if let Some(name) = name {
            url.path_segments_mut()
                .map_err(|_| local_error())?
                .push(name);
        } else {
            url.set_query(Some("restype=container&comp=acl"));
        }
        Ok(url)
    }

    async fn private(&self, config: &Config, key: &[u8]) -> Result<()> {
        let url = self.url(config, None)?;
        let headers = signed_headers(config, key, &Method::GET, &url, None, SystemTime::now())?;
        let response = self
            .client
            .get(url)
            .headers(headers)
            .send()
            .await
            .map_err(|_| upstream_error())?;
        if response.status() != StatusCode::OK {
            return Err(upstream_error());
        }
        // Azure omits this header for private containers. Fail closed on any value.
        if response.headers().contains_key("x-ms-blob-public-access") {
            return Err(Error(
                StatusCode::CONFLICT,
                "The Azure container must be private; public access is not allowed".into(),
            ));
        }
        Ok(())
    }

    async fn batch(
        &self,
        app: App,
        input: UploadInput,
        _permit: OwnedSemaphorePermit,
    ) -> Result<Counts> {
        let config = self
            .active
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| invalid("Save Azure storage settings before uploading"))?;
        if input.account_name != config.account_name
            || input.container_name != config.container_name
        {
            return Err(Error(
                StatusCode::PRECONDITION_FAILED,
                "Storage destination changed; reload storage settings before uploading".into(),
            ));
        }
        let key = config.key()?;
        self.private(&config, &key).await?;
        let snapshot = tokio::task::spawn_blocking(move || snapshot(&app))
            .await
            .map_err(|_| local_error())??;
        let mut counts = Counts {
            skipped: snapshot.skipped,
            ..Counts::default()
        };
        for (name, path) in &snapshot.files {
            self.private(&config, &key).await?;
            let mut body = Vec::new();
            tokio::fs::File::open(path)
                .await
                .map_err(|_| local_error())?
                .take((crate::MAX_FILE + 1) as u64)
                .read_to_end(&mut body)
                .await
                .map_err(|_| local_error())?;
            if body.len() > crate::MAX_FILE {
                return Err(local_error());
            }
            let url = self.url(&config, Some(name))?;
            let headers = signed_headers(
                &config,
                &key,
                &Method::PUT,
                &url,
                Some(body.len()),
                SystemTime::now(),
            )?;
            match self
                .client
                .put(url)
                .headers(headers)
                .body(body)
                .send()
                .await
            {
                Ok(response) if response.status() == StatusCode::CREATED => counts.uploaded += 1,
                Ok(response)
                    if response.status().is_redirection()
                        || (response.status().is_client_error()
                            && !matches!(response.status().as_u16(), 408 | 429)) =>
                {
                    return Err(upstream_error());
                }
                _ => counts.failed += 1,
            }
        }
        Ok(counts)
    }
}

fn signed_headers(
    config: &Config,
    key: &[u8],
    method: &Method,
    url: &Url,
    length: Option<usize>,
    now: SystemTime,
) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-ms-date",
        HeaderValue::from_str(&httpdate::fmt_http_date(now)).map_err(|_| local_error())?,
    );
    headers.insert("x-ms-version", HeaderValue::from_static(VERSION));
    if let Some(length) = length {
        headers.insert("x-ms-blob-type", HeaderValue::from_static("BlockBlob"));
        headers.insert("content-type", HeaderValue::from_static(CONTENT_TYPE));
        headers.insert(
            "content-length",
            HeaderValue::from_str(&length.to_string()).map_err(|_| local_error())?,
        );
    }
    let mut canonical_headers: Vec<_> = headers
        .iter()
        .filter(|(name, _)| name.as_str().starts_with("x-ms-"))
        .map(|(name, value)| format!("{}:{}\n", name.as_str(), value.to_str().unwrap()))
        .collect();
    canonical_headers.sort();
    let mut resource = format!("/{}{}", config.account_name, url.path());
    if length.is_none() {
        resource.push_str("\ncomp:acl\nrestype:container");
    }
    let length = length
        .filter(|n| *n != 0)
        .map(|n| n.to_string())
        .unwrap_or_default();
    let content_type = headers
        .get("content-type")
        .map_or("", |v| v.to_str().unwrap());
    let to_sign = format!(
        "{method}\n\n\n{length}\n\n{content_type}\n\n\n\n\n\n\n{}{resource}",
        canonical_headers.concat()
    );
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| local_error())?;
    mac.update(to_sign.as_bytes());
    let mut authorization = HeaderValue::from_str(&format!(
        "SharedKey {}:{}",
        config.account_name,
        STANDARD.encode(mac.finalize().into_bytes())
    ))
    .map_err(|_| local_error())?;
    authorization.set_sensitive(true);
    headers.insert("authorization", authorization);
    Ok(headers)
}

struct Snapshot {
    _directory: tempfile::TempDir,
    files: Vec<(String, PathBuf)>,
    skipped: usize,
}

fn snapshot(app: &App) -> Result<Snapshot> {
    let _guard = app.files.lock().unwrap();
    let directory = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .map_err(|_| local_error())?;
    let mut snapshot = Snapshot {
        _directory: directory,
        files: Vec::new(),
        skipped: 0,
    };
    // Enumerate directly: the editor's list endpoint has a 10,000-entry UI limit.
    for entry in fs::read_dir(&app.root).map_err(|_| local_error())? {
        let Ok(entry) = entry else {
            snapshot.skipped += 1;
            continue;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            snapshot.skipped += 1;
            continue;
        };
        if crate::validate(name).is_err()
            || name.to_ascii_lowercase().ends_with(".out")
            || name.eq_ignore_ascii_case("Agent.md")
            || !entry.file_type().is_ok_and(|kind| kind.is_file())
        {
            snapshot.skipped += 1;
            continue;
        }
        let document = match crate::read(&app.root, name) {
            Ok(document)
                if !document
                    .content
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) =>
            {
                document
            }
            _ => {
                snapshot.skipped += 1;
                continue;
            }
        };
        let path = snapshot
            ._directory
            .path()
            .join(snapshot.files.len().to_string());
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .map_err(|_| local_error())?;
        file.write_all(document.content.as_bytes())
            .map_err(|_| local_error())?;
        snapshot.files.push((document.name, path));
    }
    snapshot.files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(snapshot)
}

pub async fn get(
    State(app): State<App>,
    body: std::result::Result<Bytes, BytesRejection>,
) -> Result<Json<View>> {
    body.map_err(|e| Error(e.status(), "Invalid storage settings request".into()))?;
    Ok(Json(app.storage.view()))
}

pub async fn put(
    State(app): State<App>,
    input: std::result::Result<Json<Input>, JsonRejection>,
) -> Result<Json<View>> {
    let Json(input) =
        input.map_err(|e| Error(e.status(), "Invalid storage settings request".into()))?;
    let store = app.storage;
    let permit = store.permit()?;
    tokio::task::spawn_blocking(move || store.update(Some(input), permit))
        .await
        .map_err(|_| local_error())?
        .map(Json)
}

pub async fn delete(
    State(app): State<App>,
    body: std::result::Result<Bytes, BytesRejection>,
) -> Result<Json<View>> {
    body.map_err(|e| Error(e.status(), "Invalid storage settings request".into()))?;
    let store = app.storage;
    let permit = store.permit()?;
    tokio::task::spawn_blocking(move || store.update(None, permit))
        .await
        .map_err(|_| local_error())?
        .map(Json)
}

pub async fn upload(
    State(app): State<App>,
    input: std::result::Result<Json<UploadInput>, JsonRejection>,
) -> Result<Json<Counts>> {
    let Json(input) =
        input.map_err(|e| Error(e.status(), "Invalid storage upload request".into()))?;
    let store = app.storage.clone();
    let permit = store.permit()?;
    // Keep admission locked until all network work finishes, even if the caller disconnects.
    tokio::spawn(async move { store.batch(app, input, permit).await })
        .await
        .map_err(|_| local_error())?
        .map(Json)
}

#[cfg(test)]
#[path = "storage_tests.rs"]
mod tests;
