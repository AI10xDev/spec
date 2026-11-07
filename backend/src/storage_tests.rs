use super::*;
use crate::tests::{app, json as response_json, request};
use axum::{
    Router,
    body::Body,
    http::{Request, header},
    response::IntoResponse,
    routing::any,
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    os::unix::{
        ffi::OsStringExt,
        fs::{MetadataExt, symlink},
    },
    path::Path,
};
use tower::ServiceExt;

const SETTINGS: &str = "/api/settings/storage";
const UPLOAD: &str = "/api/settings/storage/upload";

fn input() -> Value {
    json!({"accountName":"testaccount", "containerName":"specs", "accountKey":STANDARD.encode([42u8; 64])})
}

fn destination() -> Value {
    json!({"accountName":"testaccount", "containerName":"specs"})
}

fn fixture() -> (tempfile::TempDir, App, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let state = app(&workspace);
    let path = workspace
        .with_extension("settings")
        .join("profile.json.storage.json");
    (root, state, path)
}

fn update(store: &Store, value: Value) -> Result<View> {
    store.update(
        Some(serde_json::from_value(value).unwrap()),
        store.permit()?,
    )
}

fn reopen(path: &Path, state: &App) -> Result<Store> {
    Store::open(PrivateFile::open(
        path.to_owned(),
        &state.root,
        &state.root.join("ui"),
    )?)
}

#[tokio::test]
async fn roundtrip_is_private_redacted_persistent_and_independent_of_ai() {
    let (_root, mut state, path) = fixture();
    let empty = json!({"accountName":"", "containerName":"", "hasAccountKey":false});
    assert_eq!(
        response_json(request(state.clone(), "GET", SETTINGS, Value::Null).await).await,
        empty
    );
    let ai = json!({"provider":"openai", "model":"gpt-5", "endpoint":"https://api.openai.com/v1", "apiVersion":"", "apiKey":"ai-secret"});
    assert_eq!(
        request(state.clone(), "PUT", "/api/settings", ai.clone())
            .await
            .status(),
        StatusCode::OK
    );
    let ai_path = path.with_file_name("profile.json");
    let ai_bytes = fs::read(&ai_path).unwrap();
    let response = request(state.clone(), "PUT", SETTINGS, input()).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let view = json!({"accountName":"testaccount", "containerName":"specs", "hasAccountKey":true});
    assert_eq!(response_json(response).await, view);
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
    assert_eq!(
        fs::metadata(path.parent().unwrap()).unwrap().mode() & 0o777,
        0o700
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap(),
        input()
    );
    assert_eq!(fs::read(&ai_path).unwrap(), ai_bytes);
    assert_eq!(
        serde_json::to_value(state.settings.profile().unwrap()).unwrap(),
        ai
    );
    state.storage = Arc::new(reopen(&path, &state).ok().unwrap());
    assert_eq!(
        response_json(request(state.clone(), "GET", SETTINGS, Value::Null).await).await,
        view
    );
    let storage_bytes = fs::read(&path).unwrap();
    assert_eq!(
        request(state.clone(), "DELETE", "/api/settings", Value::Null)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(fs::read(&path).unwrap(), storage_bytes);
    assert_eq!(
        response_json(request(state.clone(), "GET", SETTINGS, Value::Null).await).await,
        view
    );
    assert_eq!(
        request(state.clone(), "PUT", "/api/settings", ai)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        response_json(request(state.clone(), "DELETE", SETTINGS, Value::Null).await).await,
        empty
    );
    assert_eq!(fs::read(&path).unwrap(), b"null");
    assert_eq!(fs::read(&ai_path).unwrap(), ai_bytes);
    assert!(
        reopen(&path, &state)
            .ok()
            .unwrap()
            .active
            .lock()
            .unwrap()
            .is_none()
    );
    assert_eq!(
        request(state.clone(), "POST", UPLOAD, destination())
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        response_json(request(state, "GET", "/api/files", Value::Null).await).await,
        json!([])
    );
}

#[test]
fn key_retention_requires_same_account_and_invalid_updates_do_not_mutate() {
    let (_root, state, path) = fixture();
    assert!(update(&state.storage, input()).is_ok());
    let mut omitted = input();
    omitted.as_object_mut().unwrap().remove("accountKey");
    omitted["containerName"] = json!("other-specs");
    assert!(update(&state.storage, omitted.clone()).is_ok());
    let saved = fs::read(&path).unwrap();
    omitted["accountName"] = json!("otheraccount");
    assert!(update(&state.storage, omitted.clone()).is_err());
    assert_eq!(fs::read(&path).unwrap(), saved);
    omitted["accountKey"] = json!(STANDARD.encode([99u8; 64]));
    assert!(update(&state.storage, omitted).is_ok());
    assert_eq!(
        state
            .storage
            .active
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .account_key,
        STANDARD.encode([99u8; 64])
    );
    assert!(
        state
            .storage
            .update(None, state.storage.permit().ok().unwrap())
            .is_ok()
    );
    assert!(
        update(
            &state.storage,
            json!({"accountName":"otheraccount", "containerName":"specs"})
        )
        .is_err()
    );
}

#[tokio::test]
async fn routes_require_auth_enforce_bounds_and_sanitize_validation() {
    let (_root, state, _path) = fixture();
    for (method, path) in [
        ("GET", SETTINGS),
        ("PUT", SETTINGS),
        ("DELETE", SETTINGS),
        ("POST", UPLOAD),
    ] {
        for token in [None, Some("Bearer wrong")] {
            let mut req = Request::builder().method(method).uri(path);
            if let Some(token) = token {
                req = req.header(header::AUTHORIZATION, token);
            }
            let response = crate::router(state.clone())
                .oneshot(req.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        let response = request(
            state.clone(),
            method,
            path,
            json!({"accountKey":"s".repeat(MAX_BODY + 1)}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE, "{method}");
        assert!(
            !response_json(response)
                .await
                .to_string()
                .contains(&"s".repeat(20))
        );
    }
    for (field, value) in [
        ("accountName", json!("ab")),
        ("accountName", json!("x".repeat(25))),
        ("accountName", json!("ABC")),
        ("accountName", json!("abc.evil.test")),
        ("accountName", json!("ab/c")),
        ("accountName", json!("abc@host")),
        ("accountName", json!("abc\n")),
        ("accountName", json!(" abc")),
        ("containerName", json!("ab")),
        ("containerName", json!("x".repeat(64))),
        ("containerName", json!("Specs")),
        ("containerName", json!("a--b")),
        ("containerName", json!("-abc")),
        ("containerName", json!("abc-")),
        ("containerName", json!("a_b")),
        ("containerName", json!("$root")),
        ("containerName", json!("abc?comp=acl")),
        ("accountKey", json!("")),
        ("accountKey", Value::Null),
        ("accountKey", json!(STANDARD.encode([0u8; 32]))),
        ("accountKey", json!("?sv=secret-sas")),
        (
            "accountKey",
            json!(format!("{}\n", STANDARD.encode([0u8; 64]))),
        ),
        ("accountKey", json!("!".repeat(88))),
        ("secret-unknown-field", json!("secret-value")),
    ] {
        let mut body = input();
        body[field] = value;
        let response = request(state.clone(), "PUT", SETTINGS, body).await;
        assert!(response.status().is_client_error(), "{field}");
        let error = response_json(response).await.to_string();
        assert!(!error.contains(input()["accountKey"].as_str().unwrap()));
        assert!(
            !error.contains("secret-sas")
                && !error.contains("secret-value")
                && !error.contains("secret-unknown-field")
        );
    }
    for body in ["{\"accountKey\":\"secret", "not-json-secret"] {
        let response = crate::router(state.clone())
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(SETTINGS)
                    .header(header::AUTHORIZATION, "Bearer test-token")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(!response_json(response).await.to_string().contains("secret"));
    }
    for (account, container) in [("abc", "a-b"), (&"a".repeat(24), &"b".repeat(63))] {
        let mut body = input();
        body["accountName"] = json!(account);
        body["containerName"] = json!(container);
        assert_eq!(
            request(state.clone(), "PUT", SETTINGS, body).await.status(),
            StatusCode::OK
        );
    }
}

#[test]
fn unsafe_persistence_and_failed_writes_are_redacted_and_atomic() {
    for kind in [
        "public-file",
        "public-dir",
        "symlink",
        "hardlink",
        "fifo",
        "directory",
        "oversized",
        "malformed",
        "invalid",
    ] {
        let (root, state, path) = fixture();
        assert!(update(&state.storage, input()).is_ok());
        let before = fs::read(&path).unwrap();
        let outside = root.path().join("outside");
        fs::write(&outside, "secret-outside").unwrap();
        match kind {
            "public-file" => fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap(),
            "public-dir" => {
                fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o755))
                    .unwrap()
            }
            "symlink" | "hardlink" | "fifo" | "directory" => {
                fs::remove_file(&path).unwrap();
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
                    _ => fs::create_dir(&path).unwrap(),
                }
            }
            "oversized" => fs::write(&path, "s".repeat(crate::settings::MAX_BODY + 1)).unwrap(),
            "malformed" => fs::write(&path, "secret-malformed").unwrap(),
            _ => fs::write(&path, b"{\"accountName\":\"secret-invalid\"}").unwrap(),
        }
        assert!(reopen(&path, &state).is_err(), "{kind}");
        if !matches!(kind, "malformed" | "invalid") {
            for next in [Some(serde_json::from_value(input()).unwrap()), None] {
                let error = state
                    .storage
                    .update(next, state.storage.permit().ok().unwrap())
                    .err()
                    .unwrap();
                assert!(!error.1.contains("secret"));
                assert_eq!(
                    serde_json::to_vec(&*state.storage.active.lock().unwrap()).unwrap(),
                    before
                );
            }
        }
        assert_eq!(fs::read_to_string(outside).unwrap(), "secret-outside");
    }
}

#[test]
fn snapshot_is_flat_bounded_private_and_keeps_saved_content() {
    let (root, state, _path) = fixture();
    for (name, text) in [
        ("a.md", "saved"),
        ("extensionless", "document"),
        ("empty", ""),
        (".secret", "secret"),
        ("Agent.md", "instructions"),
        ("AGENT.MD", "instructions"),
        ("log.out", "log"),
        ("log.OUT", "log"),
        (" invalid", "invalid"),
        ("a:b", "invalid"),
        ("nul", "\0"),
        ("control", "\u{1}"),
    ] {
        fs::write(state.root.join(name), text).unwrap();
    }
    fs::write(state.root.join("binary"), [0xff, 0xff]).unwrap();
    fs::write(
        state.root.join(std::ffi::OsString::from_vec(vec![0xff])),
        "invalid name",
    )
    .unwrap();
    let large = fs::File::create(state.root.join("large")).unwrap();
    large.set_len((crate::MAX_FILE + 1) as u64).unwrap();
    fs::create_dir(state.root.join("directory")).unwrap();
    fs::write(state.root.join("directory/nested.md"), "nested").unwrap();
    fs::create_dir(state.root.join(".spec-runs")).unwrap();
    fs::write(root.path().join("outside"), "secret").unwrap();
    symlink(root.path().join("outside"), state.root.join("link")).unwrap();
    nix::unistd::mkfifo(
        &state.root.join("fifo"),
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    let snapshot = snapshot(&state).ok().unwrap();
    assert_eq!(
        snapshot
            .files
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        ["a.md", "empty", "extensionless"]
    );
    assert_eq!(snapshot.skipped, 16);
    assert_eq!(
        fs::metadata(snapshot._directory.path()).unwrap().mode() & 0o777,
        0o700
    );
    for (_, path) in &snapshot.files {
        assert_eq!(fs::metadata(path).unwrap().mode() & 0o777, 0o600);
    }
    fs::write(state.root.join("a.md"), "new saved version").unwrap();
    assert_eq!(fs::read_to_string(&snapshot.files[0].1).unwrap(), "saved");
    let directory = snapshot._directory.path().to_owned();
    drop(snapshot);
    assert!(!directory.exists());
}

#[test]
fn snapshot_does_not_silently_cap_at_ten_thousand() {
    let (_root, state, _path) = fixture();
    for i in 0..10_001 {
        fs::write(state.root.join(format!("spec-{i}")), "").unwrap();
    }
    let snapshot = snapshot(&state).ok().unwrap();
    assert_eq!(snapshot.files.len(), 10_001);
    assert_eq!(snapshot.skipped, 0);
}

struct Reply {
    status: StatusCode,
    public: Option<&'static str>,
}

#[derive(Clone)]
struct Mock {
    replies: Arc<Mutex<VecDeque<Reply>>>,
    requests: Arc<Mutex<Vec<(String, String, HeaderMap, Bytes)>>>,
    blocked_at: Option<usize>,
    entered: Arc<Semaphore>,
    release: Arc<Semaphore>,
}

async fn mock(
    state: &mut App,
    replies: Vec<Reply>,
    blocked_at: Option<usize>,
) -> (Mock, tokio::task::JoinHandle<()>) {
    let mock = Mock {
        replies: Arc::new(Mutex::new(replies.into())),
        requests: Arc::default(),
        blocked_at,
        entered: Arc::new(Semaphore::new(0)),
        release: Arc::new(Semaphore::new(0)),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    Arc::get_mut(&mut state.storage).unwrap().endpoint =
        Some(Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap());
    let router = Router::new()
        .fallback(any(
            |State(mock): State<Mock>, request: Request<Body>| async move {
                let (parts, body) = request.into_parts();
                let bytes = axum::body::to_bytes(body, crate::MAX_FILE).await.unwrap();
                let index = {
                    let mut requests = mock.requests.lock().unwrap();
                    requests.push((
                        parts.method.to_string(),
                        parts.uri.to_string(),
                        parts.headers,
                        bytes,
                    ));
                    requests.len()
                };
                if mock.blocked_at == Some(index) {
                    mock.entered.add_permits(1);
                    mock.release.acquire().await.unwrap().forget();
                }
                let reply = mock
                    .replies
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("unexpected Azure request");
                let mut response = (reply.status, "raw-provider-secret-error").into_response();
                if let Some(public) = reply.public {
                    response
                        .headers_mut()
                        .insert("x-ms-blob-public-access", HeaderValue::from_static(public));
                }
                response.headers_mut().insert(
                    "location",
                    HeaderValue::from_static("http://127.0.0.1:1/credential-leak"),
                );
                response
            },
        ))
        .with_state(mock.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (mock, server)
}

fn replies(statuses: &[u16]) -> Vec<Reply> {
    statuses
        .iter()
        .map(|status| Reply {
            status: StatusCode::from_u16(*status).unwrap(),
            public: None,
        })
        .collect()
}

#[test]
fn shared_key_signatures_match_independent_openssl_vectors() {
    // Reference digests generated with `openssl dgst -sha256 -mac HMAC` using
    // a 64-byte ASCII 'A' key and the Azure REST canonical field order.
    let config = Config {
        account_name: "testaccount".into(),
        container_name: "specs".into(),
        account_key: STANDARD.encode([b'A'; 64]),
    };
    let date = std::time::UNIX_EPOCH + Duration::from_secs(1_735_689_600);
    for (method, path, length, digest) in [
        (
            Method::GET,
            "/specs?restype=container&comp=acl",
            None,
            "dnWl9iZJP1D+QeDq+Q88vNJJcwhGvXrT15CHFDOKZVc=",
        ),
        (
            Method::PUT,
            "/specs/a%20%23%3F%25+.md",
            Some(6),
            "ZuQf9BcT7UUMSQdRVh7ffF16cDbLdBsOOJRMadODWcE=",
        ),
    ] {
        let url = Url::parse(&format!("https://testaccount.blob.core.windows.net{path}")).unwrap();
        let headers = signed_headers(
            &config,
            &config.key().ok().unwrap(),
            &method,
            &url,
            length,
            date,
        )
        .ok()
        .unwrap();
        assert_eq!(
            headers["authorization"],
            format!("SharedKey testaccount:{digest}")
        );
        assert!(headers["authorization"].is_sensitive());
    }
    let (_root, state, _) = fixture();
    assert_eq!(
        state
            .storage
            .url(&config, Some("a #?%+.md"))
            .ok()
            .unwrap()
            .as_str(),
        "https://testaccount.blob.core.windows.net/specs/a%20%23%3F%25+.md"
    );
}

#[tokio::test]
async fn uploads_encoded_names_saved_text_and_blockblob_headers_with_partial_counts() {
    let (_root, mut state, _path) = fixture();
    for (name, text) in [
        ("a #?%+.md", "saved text\n"),
        ("b", ""),
        ("c.md", "third"),
        ("ignored.out", "log"),
    ] {
        fs::write(state.root.join(name), text).unwrap();
    }
    let (mock, server) = mock(
        &mut state,
        replies(&[200, 200, 201, 200, 500, 200, 201]),
        None,
    )
    .await;
    assert!(update(&state.storage, input()).is_ok());
    let response = request(state.clone(), "POST", UPLOAD, destination()).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response_json(response).await,
        json!({"uploaded":2, "skipped":1, "failed":1})
    );
    let requests = mock.requests.lock().unwrap();
    assert_eq!(requests.len(), 7);
    for index in [0, 1, 3, 5] {
        assert_eq!(requests[index].0, "GET");
        assert_eq!(requests[index].1, "/specs?restype=container&comp=acl");
        assert!(requests[index].3.is_empty());
    }
    for (index, path, text) in [
        (2, "/specs/a%20%23%3F%25+.md", "saved text\n"),
        (4, "/specs/b", ""),
        (6, "/specs/c.md", "third"),
    ] {
        let (method, actual_path, headers, bytes) = &requests[index];
        assert_eq!(method, "PUT");
        assert_eq!(actual_path, path);
        assert_eq!(bytes.as_ref(), text.as_bytes());
        assert_eq!(headers["x-ms-blob-type"], "BlockBlob");
        assert_eq!(headers["content-type"], CONTENT_TYPE);
        assert_eq!(headers["content-length"], text.len().to_string());
    }
    for (method, path, headers, body) in requests.iter() {
        assert_eq!(headers["x-ms-version"], VERSION);
        assert!(!headers.contains_key("x-ms-blob-public-access"));
        assert!(!path.contains("sig="));
        let config: Config = serde_json::from_value(input()).unwrap();
        let url = Url::parse(&format!("https://testaccount.blob.core.windows.net{path}")).unwrap();
        let expected = signed_headers(
            &config,
            &config.key().ok().unwrap(),
            &Method::from_bytes(method.as_bytes()).unwrap(),
            &url,
            (method == "PUT").then_some(body.len()),
            httpdate::parse_http_date(headers["x-ms-date"].to_str().unwrap()).unwrap(),
        )
        .ok()
        .unwrap();
        assert_eq!(headers["authorization"], expected["authorization"]);
    }
    server.abort();
}

#[tokio::test]
async fn stale_account_or_container_is_rejected_before_any_azure_request() {
    for (field, value) in [
        ("accountName", "otheraccount"),
        ("containerName", "other-specs"),
    ] {
        let (_root, mut state, _) = fixture();
        fs::write(state.root.join("spec"), "private spec").unwrap();
        let (mock, server) = mock(&mut state, vec![], None).await;
        assert!(update(&state.storage, input()).is_ok());
        let confirmed = destination();
        let mut changed = input();
        changed[field] = json!(value);
        assert!(update(&state.storage, changed).is_ok());

        let response = request(state.clone(), "POST", UPLOAD, confirmed).await;
        assert_eq!(
            response.status(),
            StatusCode::PRECONDITION_FAILED,
            "{field}"
        );
        assert_eq!(
            response_json(response).await,
            json!({
                "error": "Storage destination changed; reload storage settings before uploading"
            })
        );
        assert!(mock.requests.lock().unwrap().is_empty());
        assert!(state.storage.permit().is_ok());
        server.abort();
    }
}

#[tokio::test]
async fn key_rotation_at_confirmed_destination_uses_current_key() {
    let (_root, mut state, _) = fixture();
    fs::write(state.root.join("spec"), "saved").unwrap();
    let (mock, server) = mock(&mut state, replies(&[200, 200, 201]), None).await;
    assert!(update(&state.storage, input()).is_ok());
    let confirmed = destination();
    let mut changed = input();
    changed["accountKey"] = json!(STANDARD.encode([99u8; 64]));
    assert!(update(&state.storage, changed.clone()).is_ok());
    let response = request(state, "POST", UPLOAD, confirmed).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response_json(response).await,
        json!({"uploaded":1, "skipped":0, "failed":0})
    );
    let config: Config = serde_json::from_value(changed).unwrap();
    for (method, path, headers, body) in mock.requests.lock().unwrap().iter() {
        let expected = signed_headers(
            &config,
            &config.key().ok().unwrap(),
            &Method::from_bytes(method.as_bytes()).unwrap(),
            &Url::parse(&format!("https://testaccount.blob.core.windows.net{path}")).unwrap(),
            (method == "PUT").then_some(body.len()),
            httpdate::parse_http_date(headers["x-ms-date"].to_str().unwrap()).unwrap(),
        )
        .ok()
        .unwrap();
        assert_eq!(headers["authorization"], expected["authorization"]);
    }
    server.abort();
}

#[tokio::test]
async fn upload_requires_well_formed_destination_json_before_any_azure_request() {
    let (_root, mut state, _) = fixture();
    let (mock, server) = mock(&mut state, vec![], None).await;
    assert!(update(&state.storage, input()).is_ok());
    for (body, content_type, status) in [
        ("", "application/json", StatusCode::BAD_REQUEST),
        (
            "{\"accountName\":\"secret",
            "application/json",
            StatusCode::BAD_REQUEST,
        ),
        ("null", "application/json", StatusCode::UNPROCESSABLE_ENTITY),
        ("{}", "application/json", StatusCode::UNPROCESSABLE_ENTITY),
        (
            r#"{"accountName":"testaccount"}"#,
            "application/json",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            r#"{"containerName":"specs"}"#,
            "application/json",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            r#"{"accountName":null,"containerName":"specs"}"#,
            "application/json",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            r#"{"accountName":"testaccount","containerName":42}"#,
            "application/json",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            r#"{"accountName":"testaccount","containerName":"specs","accountKey":"secret"}"#,
            "application/json",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            r#"{"accountName":"testaccount","containerName":"specs"}"#,
            "text/plain",
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
    ] {
        let response = crate::router(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(UPLOAD)
                    .header(header::AUTHORIZATION, "Bearer test-token")
                    .header(header::CONTENT_TYPE, content_type)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status);
        assert_eq!(
            response_json(response).await,
            json!({"error":"Invalid storage upload request"})
        );
        assert!(mock.requests.lock().unwrap().is_empty());
        assert!(state.storage.permit().is_ok());
    }
    server.abort();
}

#[tokio::test]
async fn public_containers_credentials_redirects_and_missing_containers_fail_closed() {
    for (status, public) in [
        (200, Some("blob")),
        (200, Some("container")),
        (200, Some("")),
        (200, Some("unknown")),
        (403, None),
        (401, None),
        (404, None),
        (302, None),
        (500, None),
    ] {
        let (_root, mut state, _path) = fixture();
        fs::write(state.root.join("spec"), "private spec").unwrap();
        let (mock, server) = mock(
            &mut state,
            vec![Reply {
                status: StatusCode::from_u16(status).unwrap(),
                public,
            }],
            None,
        )
        .await;
        assert!(update(&state.storage, input()).is_ok());
        let response = request(state.clone(), "POST", UPLOAD, destination()).await;
        assert!(!response.status().is_success());
        let text = response_json(response).await.to_string();
        assert!(
            !text.contains("raw-provider-secret")
                && !text.contains(input()["accountKey"].as_str().unwrap())
        );
        assert_eq!(mock.requests.lock().unwrap().len(), 1);
        assert!(state.storage.permit().is_ok());
        server.abort();
    }
}

#[tokio::test]
async fn rechecks_privacy_and_stops_on_midbatch_credentials_or_config_errors() {
    for status in [400, 401, 403, 404, 409, 302] {
        let (_root, mut state, _path) = fixture();
        fs::write(state.root.join("a"), "private").unwrap();
        fs::write(state.root.join("b"), "private").unwrap();
        let (mock, server) = mock(&mut state, replies(&[200, 200, status]), None).await;
        assert!(update(&state.storage, input()).is_ok());
        assert_eq!(
            request(state, "POST", UPLOAD, destination()).await.status(),
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(mock.requests.lock().unwrap().len(), 3);
        server.abort();
    }
    let (_root, mut state, _path) = fixture();
    fs::write(state.root.join("a"), "private").unwrap();
    fs::write(state.root.join("b"), "private").unwrap();
    let mut sequence = replies(&[200, 200, 201]);
    sequence.push(Reply {
        status: StatusCode::OK,
        public: Some("blob"),
    });
    let (mock, server) = mock(&mut state, sequence, None).await;
    assert!(update(&state.storage, input()).is_ok());
    assert_eq!(
        request(state, "POST", UPLOAD, destination()).await.status(),
        StatusCode::CONFLICT
    );
    assert_eq!(mock.requests.lock().unwrap().len(), 4);
    server.abort();
}

#[tokio::test]
async fn overlapping_batches_and_settings_changes_are_rejected_even_after_disconnect() {
    let (_root, mut state, path) = fixture();
    fs::write(state.root.join("a"), "saved snapshot").unwrap();
    let (mock, server) = mock(
        &mut state,
        replies(&[200, 200, 201, 200, 200, 201]),
        Some(2),
    )
    .await;
    assert!(update(&state.storage, input()).is_ok());
    let before = fs::read(&path).unwrap();
    let caller = tokio::spawn(request(state.clone(), "POST", UPLOAD, destination()));
    tokio::time::timeout(Duration::from_secs(5), mock.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    caller.abort();
    let _ = caller.await;
    for (method, path) in [("POST", UPLOAD), ("PUT", SETTINGS), ("DELETE", SETTINGS)] {
        assert_eq!(
            request(
                state.clone(),
                method,
                path,
                if path == UPLOAD {
                    destination()
                } else {
                    input()
                }
            )
            .await
            .status(),
            StatusCode::CONFLICT
        );
    }
    assert_eq!(
        request(state.clone(), "GET", SETTINGS, Value::Null)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    fs::write(state.root.join("a"), "new saved snapshot").unwrap();
    mock.release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(5), async {
        while state.storage.gate.available_permits() == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        mock.requests.lock().unwrap()[2].3.as_ref(),
        b"saved snapshot"
    );
    assert_eq!(
        request(state.clone(), "POST", UPLOAD, destination())
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        mock.requests.lock().unwrap()[5].3.as_ref(),
        b"new saved snapshot"
    );
    assert_eq!(
        request(state, "DELETE", SETTINGS, Value::Null)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(mock.requests.lock().unwrap().len(), 6);
    server.abort();
}

#[tokio::test]
async fn network_timeouts_are_bounded_and_redacted() {
    for blocked_at in [1, 3] {
        let (_root, mut state, _) = fixture();
        fs::write(state.root.join("spec"), "saved").unwrap();
        Arc::get_mut(&mut state.storage).unwrap().client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_millis(100))
            .build()
            .unwrap();
        let (mock, server) = mock(&mut state, replies(&[200, 200, 201]), Some(blocked_at)).await;
        assert!(update(&state.storage, input()).is_ok());
        let response = tokio::time::timeout(
            Duration::from_secs(5),
            request(state.clone(), "POST", UPLOAD, destination()),
        )
        .await
        .unwrap();
        if blocked_at == 1 {
            assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
            let body = response_json(response).await.to_string();
            assert!(!body.contains("raw-provider-secret") && !body.contains("127.0.0.1"));
        } else {
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response_json(response).await,
                json!({"uploaded":0, "skipped":0, "failed":1})
            );
        }
        assert!(state.storage.permit().is_ok());
        mock.release.add_permits(1);
        server.abort();
    }
}
