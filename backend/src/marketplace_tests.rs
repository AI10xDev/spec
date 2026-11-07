use super::*;
use crate::tests::{app, json as body, request};
use axum::{
    Router,
    body::Body,
    extract::Request,
    http::{HeaderMap, Method},
    response::{IntoResponse, Response},
};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
};
use tower::ServiceExt;

const COMMIT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const INDEX: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BLOB: &str = "cccccccccccccccccccccccccccccccccccccccc";
const PRIVATE: &str = "# Private skill\n\nPrivate instructions, not a preview.\n";

fn values() -> HashMap<String, String> {
    KEYS.into_iter()
        .zip([
            "github-private-token",
            "owner/private",
            "main",
            "paypal-client",
            "paypal-secret",
            "MERCHANT1",
            "https://spec.example/",
            "sandbox",
        ])
        .map(|(k, v)| (k.into(), v.into()))
        .collect()
}

struct Mock {
    status: String,
    capture_status: String,
    orders: Vec<Value>,
    create_keys: Vec<String>,
    capture_keys: Vec<String>,
    reads: Vec<String>,
    manifest: Value,
    private: String,
    mutations: Vec<(String, Value)>,
    fail_create: bool,
    fail_capture: bool,
    delay_create: bool,
    fail_storage_create: Option<PathBuf>,
    fail_storage_capture: Option<PathBuf>,
    redirect: bool,
    truncated: bool,
    approval: String,
    github_failure: bool,
    order_failure: Option<StatusCode>,
}

impl Default for Mock {
    fn default() -> Self {
        Self {
            status: "CREATED".into(),
            capture_status: "COMPLETED".into(),
            orders: vec![],
            create_keys: vec![],
            capture_keys: vec![],
            reads: vec![],
            manifest: json!({"skills":[{"id":"private-review","name":"Private Review","path":"nested/skills.md","description":"A safe public preview.","price":"12.50","currency":"USD"}]}),
            private: PRIVATE.into(),
            mutations: vec![],
            fail_create: false,
            fail_capture: false,
            delay_create: false,
            fail_storage_create: None,
            fail_storage_capture: None,
            redirect: false,
            truncated: false,
            approval: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1".into(),
            github_failure: false,
            order_failure: None,
        }
    }
}

async fn provider(
    State(mock): State<Arc<StdMutex<Mock>>>,
    method: Method,
    headers: HeaderMap,
    uri: axum::http::Uri,
    bytes: axum::body::Bytes,
) -> Response {
    let delay = uri.path() == "/v2/checkout/orders" && mock.lock().unwrap().delay_create;
    let response = provider_response(mock, method, headers, uri, bytes);
    if delay {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    response
}

fn provider_response(
    mock: Arc<StdMutex<Mock>>,
    method: Method,
    headers: HeaderMap,
    uri: axum::http::Uri,
    bytes: axum::body::Bytes,
) -> Response {
    let mut mock = mock.lock().unwrap();
    let path = uri.path();
    mock.reads.push(path.into());
    if mock.redirect {
        return (
            StatusCode::FOUND,
            [("location", "http://127.0.0.1:1/leak")],
            "github-private-token",
        )
            .into_response();
    }
    if path.starts_with("/repos/") {
        assert_eq!(headers["authorization"], "Bearer github-private-token");
        if mock.github_failure {
            return (StatusCode::BAD_GATEWAY, "github-private-token private body").into_response();
        }
        let value = if path == "/repos/owner/private/commits/main" {
            json!({"sha":COMMIT})
        } else if path == format!("/repos/owner/private/git/trees/{COMMIT}") {
            assert_eq!(uri.query(), Some("recursive=1"));
            json!({"truncated":mock.truncated,"tree":[
                {"path":"skills-index.json","type":"blob","mode":"100644","sha":INDEX},
                {"path":"nested/skills.md","type":"blob","mode":"100644","sha":BLOB}]})
        } else if path == format!("/repos/owner/private/git/blobs/{INDEX}") {
            let content = mock.manifest.to_string();
            json!({"encoding":"base64","size":content.len(),"content":STANDARD.encode(content)})
        } else if path == format!("/repos/owner/private/git/blobs/{BLOB}") {
            json!({"encoding":"base64","size":mock.private.len(),"content":STANDARD.encode(&mock.private)})
        } else {
            panic!("unexpected GitHub fixture path: {path}")
        };
        return Json(value).into_response();
    }
    if path == "/v1/oauth2/token" {
        assert_eq!(
            headers["authorization"],
            format!("Basic {}", STANDARD.encode("paypal-client:paypal-secret"))
        );
        return Json(json!({"access_token":"paypal-private-access-token"})).into_response();
    }
    assert_eq!(
        headers["authorization"],
        "Bearer paypal-private-access-token"
    );
    if path == "/v2/checkout/orders" {
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        let key = headers["paypal-request-id"].to_str().unwrap().to_owned();
        let index = if let Some(index) = mock
            .orders
            .iter()
            .position(|order| order["purchase_units"][0]["custom_id"] == key)
        {
            assert_eq!(mock.orders[index], value);
            index
        } else {
            mock.orders.push(value.clone());
            mock.orders.len() - 1
        };
        let id = format!("ORDER{}", index + 1);
        assert_eq!(value["purchase_units"][0]["amount"]["value"], "12.50");
        assert_eq!(
            value["purchase_units"][0]["payee"]["merchant_id"],
            "MERCHANT1"
        );
        mock.create_keys.push(key);
        if let Some(path) = mock.fail_storage_create.take() {
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        if std::mem::take(&mut mock.fail_create) {
            return (
                StatusCode::BAD_GATEWAY,
                "github-private-token paypal-secret private body",
            )
                .into_response();
        }
        return Json(json!({"id":id,"status":"CREATED","links":[{"rel":"approve","href":mock.approval.replace("ORDER1", &id)}]})).into_response();
    }
    if method == Method::POST && path.ends_with("/capture") {
        mock.capture_keys
            .push(headers["paypal-request-id"].to_str().unwrap().into());
        mock.status = "COMPLETED".into();
        if let Some(path) = mock.fail_storage_capture.take() {
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        if std::mem::take(&mut mock.fail_capture) {
            return (StatusCode::BAD_GATEWAY, "paypal-secret private content").into_response();
        }
        return Json(json!({"status":"COMPLETED"})).into_response();
    }
    if let Some(status) = mock.order_failure {
        return (status, "paypal-secret private body").into_response();
    }
    let id = path.strip_prefix("/v2/checkout/orders/").unwrap();
    let index = id.strip_prefix("ORDER").unwrap().parse::<usize>().unwrap() - 1;
    let mut value = mock.orders[index].clone();
    value["id"] = json!(id);
    value["status"] = json!(mock.status);
    value["purchase_units"][0]["payments"] = json!({"captures":[{
        "id":"CAPTURE1","status":mock.capture_status,"final_capture":true,
        "amount":{"currency_code":"USD","value":"12.50"},
        "supplementary_data":{"related_ids":{"order_id":id}}
    }]});
    for (path, replacement) in &mock.mutations {
        *value.pointer_mut(path).unwrap() = replacement.clone();
    }
    Json(value).into_response()
}

struct Fixture {
    _dir: tempfile::TempDir,
    state: App,
    mock: Arc<StdMutex<Mock>>,
    task: tokio::task::JoinHandle<()>,
    origin: String,
    private_dir: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workspace");
        fs::create_dir(&root).unwrap();
        let mut state = app(&root);
        let mock = Arc::new(StdMutex::new(Mock::default()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = Router::new().fallback(provider).with_state(mock.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, server).await.unwrap();
        });
        let mut store = Store::open(Config::parse(&values()).unwrap(), &state.settings)
            .ok()
            .unwrap();
        store.origins = Some((origin.clone(), origin.clone()));
        state.marketplace = Arc::new(store);
        Self {
            _dir: dir,
            state,
            mock,
            task,
            origin,
            private_dir: root.with_extension("settings"),
        }
    }

    fn restart(&mut self) {
        let mut store = Store::open(Config::parse(&values()).unwrap(), &self.state.settings)
            .ok()
            .unwrap();
        store.origins = Some((self.origin.clone(), self.origin.clone()));
        self.state.marketplace = Arc::new(store);
    }

    async fn buy(&self) -> Response {
        request(
            self.state.clone(),
            "POST",
            "/api/marketplace/orders",
            json!({"skillId":"private-review"}),
        )
        .await
    }
    async fn capture(&self) -> Response {
        request(
            self.state.clone(),
            "POST",
            "/api/marketplace/orders/ORDER1/capture",
            json!({}),
        )
        .await
    }
    async fn content(&self) -> Response {
        request(
            self.state.clone(),
            "GET",
            "/api/marketplace/skills/private-review/content",
            Value::Null,
        )
        .await
    }

    async fn replace(&self) -> Response {
        request(
            self.state.clone(),
            "POST",
            "/api/marketplace/orders/ORDER1/replace",
            json!({}),
        )
        .await
    }

    fn fail_sync_after(&self, writes: isize) {
        self.state
            .marketplace
            .file
            .fail_after_rename
            .store(writes, std::sync::atomic::Ordering::SeqCst);
    }

    fn void_order(&self) {
        let mut mock = self.mock.lock().unwrap();
        mock.status = "VOIDED".into();
        mock.mutations = vec![("/purchase_units/0/payments/captures".into(), json!([]))];
    }
}

#[tokio::test]
async fn marketplace_private_gate_pinned_purchase_reload_and_idempotence() {
    let mut f = Fixture::new().await;
    assert_eq!(f.content().await.status(), StatusCode::FORBIDDEN);
    let catalog = request(f.state.clone(), "GET", "/api/marketplace", Value::Null).await;
    assert_eq!(catalog.headers()["cache-control"], "no-store");
    let catalog = body(catalog).await;
    assert_eq!(catalog["mode"], "sandbox");
    assert_eq!(
        catalog["skills"][0]["description"],
        "A safe public preview."
    );
    assert!(!catalog.to_string().contains(PRIVATE));
    assert!(
        !f.mock
            .lock()
            .unwrap()
            .reads
            .iter()
            .any(|p| p.ends_with(BLOB))
    );
    let order = body(f.buy().await).await;
    assert_eq!(order["purchased"], false);
    assert_eq!(order["id"], "ORDER1");
    assert_eq!(f.content().await.status(), StatusCode::FORBIDDEN);
    assert_eq!(f.capture().await.status(), StatusCode::CONFLICT);
    assert!(f.mock.lock().unwrap().capture_keys.is_empty());
    f.restart();
    let catalog =
        body(request(f.state.clone(), "GET", "/api/marketplace", Value::Null).await).await;
    assert_eq!(catalog["skills"][0]["order"]["id"], "ORDER1");
    assert_eq!(body(f.buy().await).await, order);
    assert_eq!(f.mock.lock().unwrap().create_keys.len(), 1);
    f.mock.lock().unwrap().private = "Later repository edit".into();
    f.mock.lock().unwrap().status = "APPROVED".into();
    assert_eq!(body(f.capture().await).await, json!({"purchased":true}));
    f.restart();
    assert_eq!(body(f.content().await).await, json!({"content":PRIVATE}));
    assert_eq!(f.capture().await.status(), StatusCode::OK);
    assert_eq!(f.mock.lock().unwrap().capture_keys.len(), 1);
    let catalog =
        body(request(f.state.clone(), "GET", "/api/marketplace", Value::Null).await).await;
    assert_eq!(catalog["skills"][0]["purchased"], true);
    assert!(catalog["skills"][0].get("order").is_none());
    let files = body(request(f.state.clone(), "GET", "/api/files", Value::Null).await).await;
    assert_eq!(files, json!([]));
    for entry in fs::read_dir(&f.private_dir).unwrap() {
        assert_eq!(
            entry.unwrap().metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[tokio::test]
async fn marketplace_rejects_unapproved_cancelled_pending_failed_and_wrong_capture() {
    let f = Fixture::new().await;
    assert_eq!(f.buy().await.status(), StatusCode::OK);
    for status in [
        "CREATED",
        "SAVED",
        "PAYER_ACTION_REQUIRED",
        "VOIDED",
        "CANCELLED",
    ] {
        f.mock.lock().unwrap().status = status.into();
        assert_eq!(f.capture().await.status(), StatusCode::CONFLICT);
        assert_eq!(f.content().await.status(), StatusCode::FORBIDDEN);
    }
    f.mock.lock().unwrap().status = "COMPLETED".into();
    for status in [
        "PENDING",
        "DECLINED",
        "FAILED",
        "REFUNDED",
        "PARTIALLY_REFUNDED",
    ] {
        f.mock.lock().unwrap().capture_status = status.into();
        assert_eq!(f.capture().await.status(), StatusCode::CONFLICT);
    }
    f.mock.lock().unwrap().capture_status = "COMPLETED".into();
    for (path, value) in [
        ("/id", json!("OTHER")),
        ("/intent", json!("AUTHORIZE")),
        ("/purchase_units/0/custom_id", json!("different-binding")),
        ("/purchase_units/0/reference_id", json!("other-skill")),
        ("/purchase_units/0/payee/merchant_id", json!("ATTACKER")),
        ("/purchase_units/0/amount/value", json!("0.01")),
        ("/purchase_units/0/amount/currency_code", json!("EUR")),
        (
            "/purchase_units/0/payments/captures/0/amount/value",
            json!("1.00"),
        ),
        (
            "/purchase_units/0/payments/captures/0/amount/currency_code",
            json!("EUR"),
        ),
        (
            "/purchase_units/0/payments/captures/0/final_capture",
            json!(false),
        ),
        (
            "/purchase_units/0/payments/captures/0/supplementary_data/related_ids/order_id",
            json!("OTHER"),
        ),
        ("/purchase_units/0/payments/captures", json!([])),
        ("/purchase_units", json!([])),
    ] {
        f.mock.lock().unwrap().mutations = vec![(path.into(), value)];
        assert!(!f.capture().await.status().is_success(), "accepted {path}");
        assert_eq!(f.content().await.status(), StatusCode::FORBIDDEN);
    }
    assert!(f.mock.lock().unwrap().capture_keys.is_empty());
}

#[tokio::test]
async fn marketplace_validates_binding_before_charging_approved_order() {
    let f = Fixture::new().await;
    f.buy().await;
    f.mock.lock().unwrap().status = "APPROVED".into();
    f.mock.lock().unwrap().mutations =
        vec![("/purchase_units/0/payee/merchant_id".into(), json!("OTHER"))];
    assert_eq!(f.capture().await.status(), StatusCode::BAD_GATEWAY);
    assert!(f.mock.lock().unwrap().capture_keys.is_empty());
}

#[tokio::test]
async fn marketplace_ambiguous_network_failures_recover_without_duplicate_payment() {
    let mut f = Fixture::new().await;
    f.mock.lock().unwrap().fail_create = true;
    let error = body(f.buy().await).await.to_string();
    assert!(!error.contains("github-private-token"));
    assert!(!error.contains("paypal-secret"));
    f.restart();
    assert_eq!(f.buy().await.status(), StatusCode::OK);
    let keys = f.mock.lock().unwrap().create_keys.clone();
    assert_eq!(keys.len(), 2);
    assert_eq!(keys[0], keys[1]);
    f.mock.lock().unwrap().status = "APPROVED".into();
    f.mock.lock().unwrap().fail_capture = true;
    assert_eq!(f.capture().await.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(f.content().await.status(), StatusCode::FORBIDDEN);
    f.restart();
    assert_eq!(f.capture().await.status(), StatusCode::OK);
    assert_eq!(f.mock.lock().unwrap().capture_keys.len(), 1);
    assert_eq!(body(f.content().await).await["content"], PRIVATE);
}

#[tokio::test]
async fn marketplace_persistence_failure_preserves_create_intent_and_completed_capture() {
    let mut f = Fixture::new().await;
    f.mock.lock().unwrap().fail_storage_create = Some(f.private_dir.clone());
    assert_eq!(f.buy().await.status(), StatusCode::SERVICE_UNAVAILABLE);
    fs::set_permissions(&f.private_dir, fs::Permissions::from_mode(0o700)).unwrap();
    f.restart();
    assert_eq!(f.buy().await.status(), StatusCode::OK);
    let keys = f.mock.lock().unwrap().create_keys.clone();
    assert_eq!(keys.len(), 2);
    assert_eq!(keys[0], keys[1]);
    f.mock.lock().unwrap().status = "APPROVED".into();
    f.mock.lock().unwrap().fail_storage_capture = Some(f.private_dir.clone());
    assert_eq!(f.capture().await.status(), StatusCode::SERVICE_UNAVAILABLE);
    fs::set_permissions(&f.private_dir, fs::Permissions::from_mode(0o700)).unwrap();
    f.restart();
    assert_eq!(f.content().await.status(), StatusCode::FORBIDDEN);
    assert_eq!(f.capture().await.status(), StatusCode::OK);
    assert_eq!(f.mock.lock().unwrap().capture_keys.len(), 1);
}

#[tokio::test]
async fn marketplace_old_ambiguous_order_is_not_recreated_after_idempotency_expiry() {
    let f = Fixture::new().await;
    f.mock.lock().unwrap().fail_create = true;
    f.buy().await;
    let mut ledger = f.state.marketplace.load().ok().unwrap();
    ledger.receipts[0].created = now() - 6 * 3600;
    f.state.marketplace.save(&ledger).ok().unwrap();
    assert_eq!(f.buy().await.status(), StatusCode::CONFLICT);
    assert_eq!(f.mock.lock().unwrap().create_keys.len(), 1);
}

#[tokio::test]
async fn marketplace_timed_out_create_and_concurrent_retries_use_one_intent() {
    let mut f = Fixture::new().await;
    Arc::get_mut(&mut f.state.marketplace).unwrap().client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(40))
        .build()
        .unwrap();
    f.mock.lock().unwrap().delay_create = true;
    let response = f.buy().await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(f.content().await.status(), StatusCode::FORBIDDEN);
    f.restart();
    f.mock.lock().unwrap().delay_create = false;
    let (first, second) = tokio::join!(f.buy(), f.buy());
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(second.status(), StatusCode::OK);
    let keys = f.mock.lock().unwrap().create_keys.clone();
    assert_eq!(keys.len(), 2);
    assert_eq!(keys[0], keys[1]);
}

#[tokio::test]
async fn marketplace_non_completed_capture_remains_locked_and_receipts_resist_symlinks() {
    let f = Fixture::new().await;
    f.buy().await;
    f.mock.lock().unwrap().status = "APPROVED".into();
    f.mock.lock().unwrap().capture_status = "PENDING".into();
    assert_eq!(f.capture().await.status(), StatusCode::CONFLICT);
    assert_eq!(f.content().await.status(), StatusCode::FORBIDDEN);
    let original = fs::read_dir(&f.private_dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let bytes = fs::read(&original).unwrap();
    let replacement = f.state.root.join("forged-receipts.json");
    fs::write(&replacement, bytes).unwrap();
    fs::set_permissions(&replacement, fs::Permissions::from_mode(0o600)).unwrap();
    fs::remove_file(&original).unwrap();
    std::os::unix::fs::symlink(&replacement, original).unwrap();
    assert_eq!(f.content().await.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(f.capture().await.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn marketplace_demo_is_explicit_durable_and_separate_from_real_receipts() {
    let mut f = Fixture::new().await;
    let real_namespace = f.state.marketplace.namespace.clone();
    f.state.marketplace = Arc::new(Store::demo(&f.state.settings));
    let catalog =
        body(request(f.state.clone(), "GET", "/api/marketplace", Value::Null).await).await;
    assert_eq!(catalog["mode"], "demo");
    assert_eq!(catalog["skills"].as_array().unwrap().len(), 3);
    let path = "/api/marketplace/skills/code-review/content";
    assert_eq!(
        request(f.state.clone(), "GET", path, Value::Null)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let purchase = body(
        request(
            f.state.clone(),
            "POST",
            "/api/marketplace/orders",
            json!({"skillId":"code-review"}),
        )
        .await,
    )
    .await;
    assert_eq!(purchase["approvalUrl"], Value::Null);
    assert_eq!(purchase["purchased"], true);
    f.state.marketplace = Arc::new(Store::demo(&f.state.settings));
    let content = body(request(f.state.clone(), "GET", path, Value::Null).await).await;
    assert!(content["content"].as_str().unwrap().contains("## Workflow"));
    let ledger = f.state.marketplace.load().ok().unwrap();
    f.restart();
    assert_eq!(
        request(f.state.clone(), "GET", path, Value::Null)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    // Even copying a demo ledger into the real namespace cannot unlock it.
    f.state
        .marketplace
        .file
        .persist_bounded(&serde_json::to_vec(&ledger).unwrap(), MAX_LEDGER, true)
        .ok()
        .unwrap();
    assert!(f.state.marketplace.load().is_err());
    let mut ledger = ledger;
    ledger.namespace = real_namespace;
    f.state.marketplace.save(&ledger).ok().unwrap();
    assert!(f.state.marketplace.load().is_err());
    assert!(f.mock.lock().unwrap().reads.is_empty());
}

#[test]
fn marketplace_configuration_fails_closed_and_namespaces_bind_merchant_repo_mode() {
    assert!(Config::parse(&HashMap::new()).unwrap().is_none());
    for key in KEYS {
        assert!(Config::parse(&HashMap::from([(key.into(), "".into())])).is_err());
    }
    for key in [KEYS[0], KEYS[1], KEYS[3], KEYS[4], KEYS[5], KEYS[6]] {
        let mut config = values();
        config.remove(key);
        assert!(Config::parse(&config).is_err());
    }
    for (key, value) in [
        (KEYS[7], "demo"),
        (KEYS[7], "production"),
        (KEYS[1], "owner/../../secret"),
        (KEYS[6], "http://spec.example/"),
        (KEYS[6], "https://spec.example/#token=private"),
        (KEYS[6], "https://user:secret@spec.example/"),
        (KEYS[2], ""),
    ] {
        let mut config = values();
        config.insert(key.into(), value.into());
        assert!(Config::parse(&config).is_err());
    }
    let mut config = values();
    config.remove(KEYS[7]);
    assert_eq!(Config::parse(&config).unwrap().unwrap().mode, "sandbox");
    let dir = tempfile::tempdir().unwrap();
    let state = app(dir.path());
    let original = Store::open(Config::parse(&values()).unwrap(), &state.settings)
        .ok()
        .unwrap();
    for (key, value) in [
        (KEYS[1], "other/repo"),
        (KEYS[2], "release"),
        (KEYS[3], "other-client"),
        (KEYS[5], "OTHER"),
        (KEYS[7], "live"),
    ] {
        let mut config = values();
        config.insert(key.into(), value.into());
        let other = Store::open(Config::parse(&config).unwrap(), &state.settings)
            .ok()
            .unwrap();
        assert_ne!(original.namespace, other.namespace);
    }
}

#[tokio::test]
async fn marketplace_authentication_and_untrusted_inputs_cannot_expose_private_data() {
    let f = Fixture::new().await;
    for (method, path) in [
        ("GET", "/api/marketplace"),
        ("POST", "/api/marketplace/orders"),
        ("POST", "/api/marketplace/orders/ORDER1/capture"),
        ("GET", "/api/marketplace/skills/private-review/content"),
    ] {
        let response = crate::router(f.state.clone())
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    assert!(f.mock.lock().unwrap().reads.is_empty());
    for value in [
        json!({"skillId":"../secret"}),
        json!({"skillId":"private-review","price":"0.01"}),
        json!({"skillId":"private-review","content":"injected"}),
        json!({"skillId":"private-review","purchased":true}),
    ] {
        let response = request(f.state.clone(), "POST", "/api/marketplace/orders", value).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    assert!(f.mock.lock().unwrap().reads.is_empty());
    assert_eq!(
        request(
            f.state.clone(),
            "POST",
            "/api/marketplace/orders/UNKNOWN/capture",
            json!({})
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    f.mock.lock().unwrap().redirect = true;
    let response = request(f.state.clone(), "GET", "/api/marketplace", Value::Null).await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let response = body(response).await.to_string();
    assert!(!response.contains("github-private-token"));
    assert!(!response.contains("127.0.0.1"));
    assert_eq!(f.mock.lock().unwrap().reads.len(), 1);
}

#[tokio::test]
async fn marketplace_unreadable_configuration_never_exposes_demo_routes_or_receipts() {
    let mut f = Fixture::new().await;
    let mut store = Store::demo(&f.state.settings);
    store.unavailable =
        Some("Marketplace unavailable: shared dotenv configuration could not be read");
    f.state.marketplace = Arc::new(store);
    for (method, path, input) in [
        ("GET", "/api/marketplace", Value::Null),
        (
            "POST",
            "/api/marketplace/orders",
            json!({"skillId":"code-review"}),
        ),
        ("POST", "/api/marketplace/orders/id/capture", json!({})),
        (
            "GET",
            "/api/marketplace/skills/code-review/content",
            Value::Null,
        ),
    ] {
        let response = request(f.state.clone(), method, path, input).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(!body(response).await.to_string().contains("purchased"));
    }
    assert!(f.mock.lock().unwrap().reads.is_empty());
}

#[tokio::test]
async fn marketplace_manifest_prices_paths_bounds_and_approval_hosts_are_validated() {
    for (field, value) in [
        ("id", "../bad"),
        ("path", "../skills.md"),
        ("path", "https://evil/skills.md"),
        ("path", "nested/missing/skills.md"),
        ("path", "nested/other.md"),
        ("price", "0.00"),
        ("price", "1e2"),
        ("price", "1.001"),
        ("price", "-1.00"),
        ("currency", "usd"),
        ("currency", "JPY"),
    ] {
        let f = Fixture::new().await;
        f.mock.lock().unwrap().manifest["skills"][0][field] = json!(value);
        assert_eq!(
            f.buy().await.status(),
            StatusCode::BAD_GATEWAY,
            "accepted {field}={value}"
        );
        assert!(f.mock.lock().unwrap().create_keys.is_empty());
    }
    for url in [
        "http://www.sandbox.paypal.com/checkoutnow?token=ORDER1",
        "https://evil.example/checkoutnow?token=ORDER1",
        "https://www.sandbox.paypal.com.evil.example/checkoutnow?token=ORDER1",
        "https://www.paypal.com/checkoutnow?token=ORDER1",
        "https://user:secret@www.sandbox.paypal.com/checkoutnow?token=ORDER1",
        "https://www.sandbox.paypal.com/checkoutnow?token=OTHER",
    ] {
        let f = Fixture::new().await;
        f.mock.lock().unwrap().approval = url.into();
        assert_eq!(f.buy().await.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(f.content().await.status(), StatusCode::FORBIDDEN);
    }
    let f = Fixture::new().await;
    f.mock.lock().unwrap().private = "x".repeat(MAX_CONTENT + 1);
    assert_eq!(f.buy().await.status(), StatusCode::BAD_GATEWAY);
    assert!(f.mock.lock().unwrap().create_keys.is_empty());
    f.mock.lock().unwrap().truncated = true;
    assert_eq!(f.buy().await.status(), StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn marketplace_post_rename_sync_failure_blocks_recovered_intent_and_approval() {
    for allowed_writes in [0, 1] {
        let mut f = Fixture::new().await;
        f.fail_sync_after(allowed_writes);
        assert_eq!(f.buy().await.status(), StatusCode::SERVICE_UNAVAILABLE);
        let ledger = f.state.marketplace.load().ok().unwrap();
        assert_eq!(ledger.receipts.len(), 1, "rename must already be visible");
        assert_eq!(ledger.receipts[0].order.is_some(), allowed_writes == 1);
        assert_eq!(
            f.mock.lock().unwrap().create_keys.len(),
            allowed_writes as usize
        );
        f.restart();
        f.fail_sync_after(0);
        f.mock.lock().unwrap().status = "APPROVED".into();
        let reads = f.mock.lock().unwrap().reads.len();
        for (method, path, input) in [
            ("GET", "/api/marketplace", Value::Null),
            (
                "POST",
                "/api/marketplace/orders",
                json!({"skillId":"private-review"}),
            ),
            ("POST", "/api/marketplace/orders/ORDER1/capture", json!({})),
            ("POST", "/api/marketplace/orders/ORDER1/replace", json!({})),
            (
                "GET",
                "/api/marketplace/skills/private-review/content",
                Value::Null,
            ),
        ] {
            let response = request(f.state.clone(), method, path, input).await;
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            let error = body(response).await;
            assert!(error.get("content").is_none());
            assert!(error.get("approvalUrl").is_none());
            assert!(error.get("purchased").is_none());
        }
        assert_eq!(
            f.mock.lock().unwrap().reads.len(),
            reads,
            "no payment side effects before confirmed durability"
        );
        f.fail_sync_after(-1);
        assert_eq!(f.buy().await.status(), StatusCode::OK);
        assert_eq!(f.mock.lock().unwrap().create_keys.len(), 1);
    }
}

#[tokio::test]
async fn marketplace_post_rename_capture_sync_failure_never_reveals_until_reconfirmed() {
    let mut f = Fixture::new().await;
    assert_eq!(f.buy().await.status(), StatusCode::OK);
    f.mock.lock().unwrap().status = "APPROVED".into();
    f.fail_sync_after(1); // Entry confirmation succeeds, but the entitlement's final sync fails.
    assert_eq!(f.capture().await.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(f.state.marketplace.load().ok().unwrap().receipts[0].purchased);
    assert_eq!(f.content().await.status(), StatusCode::SERVICE_UNAVAILABLE);
    f.restart();
    f.fail_sync_after(0);
    assert_eq!(f.content().await.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(f.buy().await.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(f.capture().await.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        request(f.state.clone(), "GET", "/api/marketplace", Value::Null)
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    f.fail_sync_after(-1);
    assert_eq!(body(f.capture().await).await, json!({"purchased":true}));
    assert_eq!(body(f.content().await).await["content"], PRIVATE);
    assert_eq!(f.mock.lock().unwrap().capture_keys.len(), 1);
}

#[tokio::test]
async fn marketplace_github_outage_returns_receipt_catalog_with_warning_not_content() {
    let f = Fixture::new().await;
    f.mock.lock().unwrap().github_failure = true;
    assert_eq!(
        request(f.state.clone(), "GET", "/api/marketplace", Value::Null)
            .await
            .status(),
        StatusCode::BAD_GATEWAY
    );
    f.mock.lock().unwrap().github_failure = false;
    assert_eq!(f.buy().await.status(), StatusCode::OK);
    f.mock.lock().unwrap().github_failure = true;
    for purchased in [false, true] {
        if purchased {
            f.mock.lock().unwrap().status = "APPROVED".into();
            assert_eq!(f.capture().await.status(), StatusCode::OK);
            assert_eq!(body(f.content().await).await["content"], PRIVATE);
        }
        let response = request(f.state.clone(), "GET", "/api/marketplace", Value::Null).await;
        assert_eq!(response.status(), StatusCode::OK);
        let catalog = body(response).await;
        assert!(
            catalog["warning"]
                .as_str()
                .unwrap()
                .contains("stored purchases and orders")
        );
        assert_eq!(catalog["mode"], "sandbox");
        assert_eq!(catalog["repository"], "owner/private");
        assert_eq!(catalog["skills"].as_array().unwrap().len(), 1);
        let skill = &catalog["skills"][0];
        assert_eq!(skill["purchased"], purchased);
        if !purchased {
            assert_eq!(skill["order"]["id"], "ORDER1");
        }
        assert!(skill.get("content").is_none());
        for private in [
            "Private instructions",
            "github-private-token",
            "paypal-secret",
            "paypal-private-access-token",
        ] {
            assert!(!catalog.to_string().contains(private));
        }
    }
    f.mock.lock().unwrap().github_failure = false;
    let catalog =
        body(request(f.state.clone(), "GET", "/api/marketplace", Value::Null).await).await;
    assert!(catalog.get("warning").is_none());
}

#[tokio::test]
async fn marketplace_replace_voided_order_is_durable_idempotent_and_uses_pinned_purchase() {
    let mut f = Fixture::new().await;
    assert_eq!(f.buy().await.status(), StatusCode::OK);
    let original = f.state.marketplace.load().ok().unwrap().receipts[0]
        .request_id
        .clone();
    f.void_order();
    f.mock.lock().unwrap().github_failure = true;
    f.mock.lock().unwrap().private = "Changed repository instructions".into();
    let response = f.replace().await;
    assert_eq!(response.status(), StatusCode::OK);
    let replacement = body(response).await;
    assert_eq!(
        replacement,
        json!({"id":"ORDER2","approvalUrl":"https://www.sandbox.paypal.com/checkoutnow?token=ORDER2","purchased":false})
    );
    let ledger = f.state.marketplace.load().ok().unwrap();
    assert_eq!(ledger.receipts.len(), 2);
    assert!(ledger.receipts[0].retired);
    assert_eq!(ledger.receipts[0].request_id, original);
    assert!(!ledger.receipts[1].retired);
    assert_ne!(ledger.receipts[1].request_id, original);
    assert_eq!(ledger.receipts[1].content, PRIVATE);
    assert_eq!(ledger.receipts[1].revision, COMMIT);
    assert!(f.mock.lock().unwrap().capture_keys.is_empty());
    f.restart();
    let (first, second) = tokio::join!(f.replace(), f.buy());
    assert_eq!(body(first).await, replacement);
    assert_eq!(body(second).await, replacement);
    assert_eq!(f.mock.lock().unwrap().create_keys.len(), 2);
    assert_eq!(f.capture().await.status(), StatusCode::CONFLICT);
    let catalog =
        body(request(f.state.clone(), "GET", "/api/marketplace", Value::Null).await).await;
    assert_eq!(catalog["skills"].as_array().unwrap().len(), 1);
    assert_eq!(catalog["skills"][0]["order"]["id"], "ORDER2");
    f.mock.lock().unwrap().mutations.clear();
    f.mock.lock().unwrap().status = "APPROVED".into();
    assert_eq!(
        request(
            f.state.clone(),
            "POST",
            "/api/marketplace/orders/ORDER2/capture",
            json!({})
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(body(f.content().await).await["content"], PRIVATE);
    assert_eq!(body(f.replace().await).await["purchased"], true);
    assert_eq!(f.mock.lock().unwrap().create_keys.len(), 2);
}

#[tokio::test]
async fn marketplace_replace_rejects_nonterminal_mismatched_captured_and_ambiguous_orders() {
    let f = Fixture::new().await;
    assert_eq!(f.buy().await.status(), StatusCode::OK);
    let mut ledger = f.state.marketplace.load().ok().unwrap();
    ledger.receipts[0].created = 0; // Age is never evidence of a safe replacement.
    f.state.marketplace.save(&ledger).ok().unwrap();
    for status in [
        "CREATED",
        "APPROVED",
        "PENDING",
        "COMPLETED",
        "EXPIRED",
        "CANCELLED",
        "UNKNOWN",
    ] {
        f.void_order();
        f.mock.lock().unwrap().status = status.into();
        assert_eq!(f.replace().await.status(), StatusCode::CONFLICT);
    }
    for (path, value) in [
        ("/id", json!("OTHER")),
        ("/intent", json!("AUTHORIZE")),
        ("/purchase_units/0/custom_id", json!("OTHER")),
        ("/purchase_units/0/reference_id", json!("other-skill")),
        ("/purchase_units/0/payee/merchant_id", json!("OTHER")),
        ("/purchase_units/0/amount/value", json!("0.01")),
        ("/purchase_units/0/amount/currency_code", json!("EUR")),
        ("/purchase_units/0/payments", Value::Null),
        ("/purchase_units/0/payments", json!({"unknown":[]})),
        (
            "/purchase_units/0/payments",
            json!({"captures":[{"status":"FAILED"}]}),
        ),
        (
            "/purchase_units/0/payments",
            json!({"captures":[{"status":"COMPLETED"}]}),
        ),
        (
            "/purchase_units/0/payments",
            json!({"captures":[{"status":"PENDING"}]}),
        ),
        ("/purchase_units", json!([])),
    ] {
        f.void_order();
        f.mock.lock().unwrap().mutations.push((path.into(), value));
        assert_eq!(
            f.replace().await.status(),
            StatusCode::CONFLICT,
            "accepted {path}"
        );
    }
    f.void_order();
    for status in [StatusCode::NOT_FOUND, StatusCode::BAD_GATEWAY] {
        f.mock.lock().unwrap().order_failure = Some(status);
        let response = f.replace().await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert!(!body(response).await.to_string().contains("paypal-secret"));
    }
    assert!(!f.state.marketplace.load().ok().unwrap().receipts[0].retired);
    assert_eq!(f.mock.lock().unwrap().create_keys.len(), 1);
    assert!(f.mock.lock().unwrap().capture_keys.is_empty());
    f.task.abort();
    assert_eq!(f.replace().await.status(), StatusCode::BAD_GATEWAY);
    assert!(!f.state.marketplace.load().ok().unwrap().receipts[0].retired);
}

#[tokio::test]
async fn marketplace_replace_sync_failures_preserve_history_and_never_duplicate_orders() {
    for allowed_writes in [1, 2, 3] {
        let mut f = Fixture::new().await;
        assert_eq!(f.buy().await.status(), StatusCode::OK);
        f.void_order();
        f.fail_sync_after(allowed_writes);
        assert_eq!(f.replace().await.status(), StatusCode::SERVICE_UNAVAILABLE);
        let ledger = f.state.marketplace.load().ok().unwrap();
        assert!(ledger.receipts[0].retired);
        assert_eq!(
            ledger.receipts.len(),
            if allowed_writes == 1 { 1 } else { 2 }
        );
        assert_eq!(
            f.mock.lock().unwrap().create_keys.len(),
            if allowed_writes == 3 { 2 } else { 1 }
        );
        f.restart();
        f.fail_sync_after(0);
        assert_eq!(f.replace().await.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(f.buy().await.status(), StatusCode::SERVICE_UNAVAILABLE);
        f.fail_sync_after(-1);
        let (first, second) = tokio::join!(f.replace(), f.buy());
        assert_eq!(body(first).await["id"], "ORDER2");
        assert_eq!(body(second).await["id"], "ORDER2");
        assert_eq!(f.mock.lock().unwrap().create_keys.len(), 2);
        assert_eq!(f.state.marketplace.load().ok().unwrap().receipts.len(), 2);
    }
}

#[tokio::test]
async fn marketplace_replace_ambiguous_create_reuses_new_key_and_history_is_bounded() {
    let mut f = Fixture::new().await;
    assert_eq!(f.buy().await.status(), StatusCode::OK);
    f.void_order();
    f.mock.lock().unwrap().fail_create = true;
    assert_eq!(f.replace().await.status(), StatusCode::BAD_GATEWAY);
    f.restart();
    assert_eq!(body(f.replace().await).await["id"], "ORDER2");
    let keys = f.mock.lock().unwrap().create_keys.clone();
    assert_eq!(keys.len(), 3);
    assert_ne!(keys[0], keys[1]);
    assert_eq!(keys[1], keys[2]);

    let mut ledger = f.state.marketplace.load().ok().unwrap();
    for i in 2..100 {
        let mut historic: Receipt =
            serde_json::from_value(serde_json::to_value(&ledger.receipts[0]).unwrap()).unwrap();
        historic.order.as_mut().unwrap().id = format!("HISTORY{i}");
        historic.request_id = Uuid::new_v4().to_string();
        ledger.receipts.insert(0, historic);
    }
    f.state.marketplace.save(&ledger).ok().unwrap();
    assert_eq!(
        request(
            f.state.clone(),
            "POST",
            "/api/marketplace/orders/ORDER2/replace",
            json!({})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(body(f.buy().await).await["id"], "ORDER2");
    assert_eq!(f.state.marketplace.load().ok().unwrap().receipts.len(), 100);
}

#[tokio::test]
async fn marketplace_replace_auth_and_body_validation_precede_provider_requests() {
    let f = Fixture::new().await;
    let uri = "/api/marketplace/orders/ORDER1/replace";
    let response = crate::router(f.state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        request(f.state.clone(), "POST", uri, json!({"purchased":true}))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(f.replace().await.status(), StatusCode::NOT_FOUND);
    assert!(f.mock.lock().unwrap().reads.is_empty());
}
