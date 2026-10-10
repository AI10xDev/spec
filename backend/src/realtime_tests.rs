use super::*;
use crate::tests::{app, json as response_json, request};
use axum::{
    Router,
    body::{Body, Bytes},
    extract::DefaultBodyLimit,
    http::{HeaderMap, Request, Uri, header},
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::Value;
use tokio::{sync::mpsc, task::JoinHandle};
use tower::ServiceExt;

const SDP: &str = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n";

fn input() -> Value {
    json!({
        "sdp": SDP, "name": "idea.md", "spec": "# Done\nPending change",
        "output": {"id": "run-1", "status": "running", "output": "Displayed nohup output", "truncated": false},
    })
}

struct Mock {
    state: App,
    requests: mpsc::Receiver<(Uri, HeaderMap, Bytes)>,
    task: JoinHandle<()>,
    _root: tempfile::TempDir,
}

impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn mock(response: Response, delay: Duration) -> Mock {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (send, requests) = mpsc::channel(8);
    let response = Arc::new(std::sync::Mutex::new(Some(response)));
    let server = Router::new()
        .fallback(post(move |uri: Uri, headers: HeaderMap, body: Bytes| {
            let send = send.clone();
            let response = response.clone();
            async move {
                send.send((uri, headers, body)).await.unwrap();
                tokio::time::sleep(delay).await;
                response
                    .lock()
                    .unwrap()
                    .take()
                    .unwrap_or_else(|| StatusCode::INTERNAL_SERVER_ERROR.into_response())
            }
        }))
        .layer(DefaultBodyLimit::max(MAX_BODY));
    let mut provider = Realtime::configured(Some("mock-secret"), Some("gpt-realtime-test"))
        .unwrap()
        .unwrap();
    // Production has no endpoint override; only isolated tests can use loopback HTTP.
    provider.url = format!(
        "http://{}/v1/realtime/calls",
        listener.local_addr().unwrap()
    );
    provider.client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let mut state = app(root.path());
    state.realtime = Some(provider);
    Mock {
        state,
        requests,
        _root: root,
        task: tokio::spawn(async move {
            axum::serve(listener, server).await.unwrap();
        }),
    }
}

async fn session(mock: &mut Mock, sdp: &str) -> Value {
    let (uri, headers, bytes) = mock.requests.recv().await.unwrap();
    assert_eq!(uri, "/v1/realtime/calls");
    assert_eq!(headers[header::AUTHORIZATION], "Bearer mock-secret");
    assert!(!headers.contains_key("openai-beta"));
    let boundary = headers[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .strip_prefix("multipart/form-data; boundary=")
        .unwrap();
    let body = std::str::from_utf8(&bytes).unwrap();
    let parts: Vec<_> = body.split(&format!("--{boundary}")).collect();
    assert_eq!(parts.len(), 4);
    assert!(parts[1].contains("name=\"sdp\"\r\n"));
    assert!(parts[1].contains("Content-Type: application/sdp"));
    assert_eq!(
        parts[1].split_once("\r\n\r\n").unwrap().1,
        format!("{sdp}\r\n")
    );
    assert!(parts[2].contains("name=\"session\"\r\n"));
    assert!(parts[2].contains("Content-Type: application/json"));
    serde_json::from_str(parts[2].split_once("\r\n\r\n").unwrap().1.trim_end()).unwrap()
}

#[test]
fn configuration_is_independent_optional_and_validated() {
    assert!(Realtime::configured(None, None).unwrap().is_none());
    assert!(
        Realtime::configured(None, Some("gpt-realtime"))
            .unwrap()
            .is_none()
    );
    let provider = Realtime::configured(Some("test-key"), None)
        .unwrap()
        .unwrap();
    assert_eq!(provider.url, CALLS_URL);
    assert_eq!(provider.model, "gpt-realtime");
    assert!(provider.key.is_sensitive());
    assert_eq!(provider.slots.available_permits(), 4);
    for key in [
        "",
        " ",
        "bad\nkey",
        "bad\0key",
        "non-ascii-\u{e9}",
        &"x".repeat(4097),
    ] {
        assert!(Realtime::configured(Some(key), None).is_err());
    }
    for model in [
        "",
        " ",
        ".",
        "..",
        "https://evil.test",
        "bad\nmodel",
        &"x".repeat(129),
    ] {
        assert!(Realtime::configured(Some("test-key"), Some(model)).is_err());
    }
    assert!(
        crate::CSP
            .split(';')
            .any(|part| part.trim() == "connect-src 'self'")
    );
    assert!(
        crate::CSP
            .split(';')
            .any(|part| part.trim() == "media-src 'self' blob:")
    );
}

#[tokio::test]
async fn auth_disabled_and_enabled_configuration() {
    let mut mock = mock(SDP.into_response(), Duration::ZERO).await;
    for token in [None, Some("Bearer wrong")] {
        for (method, path) in [("POST", "/api/realtime"), ("GET", "/api/config")] {
            let mut req = Request::builder().method(method).uri(path);
            if let Some(token) = token {
                req = req.header(header::AUTHORIZATION, token);
            }
            let response = crate::router(mock.state.clone())
                .oneshot(req.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
    }
    let config = request(mock.state.clone(), "GET", "/api/config", Value::Null).await;
    assert_eq!(config.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        response_json(config).await,
        json!({"execution": false, "completion": false, "chat": false, "realtime": true, "azureRealtime": false})
    );
    mock.state.realtime = None;
    let config =
        response_json(request(mock.state.clone(), "GET", "/api/config", Value::Null).await).await;
    assert_eq!(config["realtime"], false);
    let response = request(mock.state.clone(), "POST", "/api/realtime", input()).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        response_json(response).await,
        json!({"error": "OpenAI Realtime is not configured"})
    );
    assert!(mock.requests.try_recv().is_err());
}

#[tokio::test]
async fn unified_call_supplies_read_only_snapshot_without_touching_workspace() {
    let mut mock = mock(
        (
            StatusCode::CREATED,
            [(header::LOCATION, "/v1/realtime/calls/private-id")],
            SDP,
        )
            .into_response(),
        Duration::ZERO,
    )
    .await;
    std::fs::write(
        mock.state.root.join("idea.md"),
        "Saved text, not editor text",
    )
    .unwrap();
    let response = request(mock.state.clone(), "POST", "/api/realtime", input()).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert!(!response.headers().contains_key(header::LOCATION));
    assert_eq!(response_json(response).await, json!({"sdp": SDP}));
    let payload = session(&mut mock, SDP).await;
    assert_eq!(payload["type"], "realtime");
    assert_eq!(payload["model"], "gpt-realtime-test");
    assert_eq!(payload["output_modalities"], json!(["audio"]));
    assert_eq!(payload["audio"]["output"]["voice"], "marin");
    assert_eq!(
        payload["audio"]["input"]["turn_detection"],
        json!({"type": "server_vad", "create_response": true, "interrupt_response": true})
    );
    assert_eq!(payload["tools"], json!([]));
    assert_eq!(payload["tool_choice"], "none");
    let instructions = payload["instructions"].as_str().unwrap();
    let context: Value = serde_json::from_str(instructions.strip_prefix(PROMPT).unwrap()).unwrap();
    assert_eq!(context["spec"], input()["spec"]);
    assert_eq!(context["output"], input()["output"]);
    assert_eq!(context["name"], "idea.md");
    assert_eq!(context["contextTruncated"], false);
    assert_eq!(
        context["omissions"],
        json!({"specTailBytes": 0, "outputHeadBytes": 0})
    );
    assert!(!instructions.contains("mock-secret"));
    assert_eq!(
        std::fs::read_to_string(mock.state.root.join("idea.md")).unwrap(),
        "Saved text, not editor text"
    );
    assert!(mock.state.jobs.lock().unwrap().is_empty());
    assert_eq!(std::fs::read_dir(&mock.state.root).unwrap().count(), 1);
}

#[tokio::test]
async fn context_is_utf8_bounded_with_explicit_omissions_and_null_output() {
    for output in [Value::Null, input()["output"].clone()] {
        let mut mock = mock(SDP.into_response(), Duration::ZERO).await;
        let mut body = input();
        let spec = format!("{}\u{1f331}tail", "s".repeat(MAX_CONTEXT - 1));
        body["spec"] = json!(spec);
        body["output"] = output;
        let log = format!("head\u{1f331}{}", "l".repeat(MAX_CONTEXT - 1));
        if !body["output"].is_null() {
            body["output"]["output"] = json!(log);
            body["output"]["truncated"] = json!(true);
        }
        let response = request(mock.state.clone(), "POST", "/api/realtime", body.clone()).await;
        assert_eq!(response.status(), StatusCode::OK);
        let payload = session(&mut mock, SDP).await;
        let context: Value = serde_json::from_str(
            payload["instructions"]
                .as_str()
                .unwrap()
                .strip_prefix(PROMPT)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(context["spec"], "s".repeat(MAX_CONTEXT - 1));
        assert_eq!(context["omissions"]["specTailBytes"], 8);
        assert_eq!(context["contextTruncated"], true);
        if body["output"].is_null() {
            assert!(context["output"].is_null());
            assert_eq!(context["omissions"]["outputHeadBytes"], 0);
        } else {
            assert_eq!(context["output"]["output"], "l".repeat(MAX_CONTEXT - 1));
            assert_eq!(context["omissions"]["outputHeadBytes"], 8);
            assert_eq!(context["output"]["truncated"], true);
        }
    }
}

#[tokio::test]
async fn invalid_and_oversized_requests_never_reach_provider() {
    let mut mock = mock(SDP.into_response(), Duration::ZERO).await;
    for (field, value, status) in [
        ("sdp", json!(""), StatusCode::BAD_REQUEST),
        ("sdp", json!("not SDP"), StatusCode::BAD_REQUEST),
        (
            "sdp",
            json!("v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"),
            StatusCode::BAD_REQUEST,
        ),
        ("sdp", json!(format!("{SDP}\0")), StatusCode::BAD_REQUEST),
        (
            "sdp",
            json!("x".repeat(MAX_SDP + 1)),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        ("sdp", json!(42), StatusCode::UNPROCESSABLE_ENTITY),
        ("name", json!("../secret"), StatusCode::BAD_REQUEST),
        ("name", json!("x".repeat(181)), StatusCode::BAD_REQUEST),
        (
            "spec",
            json!("x".repeat(MAX_FILE + 1)),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (
            "endpoint",
            json!("https://evil.test"),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            "model",
            json!("client-model"),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        ("tools", json!([]), StatusCode::UNPROCESSABLE_ENTITY),
    ] {
        let mut body = input();
        body[field] = value;
        let response = request(mock.state.clone(), "POST", "/api/realtime", body).await;
        assert_eq!(response.status(), status, "field {field}");
    }
    for (field, value, status) in [
        ("id", json!(""), StatusCode::BAD_REQUEST),
        ("id", json!("x".repeat(129)), StatusCode::BAD_REQUEST),
        ("status", json!("running\n"), StatusCode::BAD_REQUEST),
        ("status", json!("x".repeat(257)), StatusCode::BAD_REQUEST),
        (
            "output",
            json!("x".repeat(MAX_OUTPUT + 1)),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (
            "truncated",
            json!("false"),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            "url",
            json!("https://evil.test"),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
    ] {
        let mut body = input();
        body["output"][field] = value;
        let response = request(mock.state.clone(), "POST", "/api/realtime", body).await;
        assert_eq!(response.status(), status, "output field {field}");
    }
    for field in ["sdp", "name", "spec", "output"] {
        let mut body = input();
        body.as_object_mut().unwrap().remove(field);
        assert_eq!(
            request(mock.state.clone(), "POST", "/api/realtime", body)
                .await
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let response = crate::router(mock.state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/realtime")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(" ".repeat(MAX_BODY + 1)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(mock.requests.try_recv().is_err());
}

#[tokio::test]
async fn exact_field_bounds_are_accepted_and_concurrency_is_shared() {
    let mut mock = mock(SDP.into_response(), Duration::ZERO).await;
    let slots = mock.state.realtime.as_ref().unwrap().slots.clone();
    let permits = slots.acquire_many(4).await.unwrap();
    let response = request(mock.state.clone(), "POST", "/api/realtime", input()).await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(mock.requests.try_recv().is_err());
    drop(permits);
    let mut body = input();
    let sdp = format!("{SDP}a={}", "x".repeat(MAX_SDP - SDP.len() - 2));
    body["sdp"] = json!(sdp);
    body["spec"] = json!("\u{1}".repeat(MAX_FILE));
    body["name"] = json!("n".repeat(180));
    body["output"]["id"] = json!("i".repeat(128));
    body["output"]["status"] = json!("s".repeat(256));
    body["output"]["output"] = json!("\u{1}".repeat(MAX_OUTPUT));
    let response = request(mock.state.clone(), "POST", "/api/realtime", body).await;
    assert_eq!(response.status(), StatusCode::OK);
    session(&mut mock, &sdp).await;
    assert_eq!(slots.available_permits(), 4);
}

#[tokio::test]
async fn provider_failures_are_sanitized_bounded_and_redirects_are_not_followed() {
    for response in [
        (StatusCode::UNAUTHORIZED, "mock-secret provider diagnostic").into_response(),
        (StatusCode::TOO_MANY_REQUESTS, "mock-secret").into_response(),
        (StatusCode::INTERNAL_SERVER_ERROR, "mock-secret").into_response(),
        (
            StatusCode::TEMPORARY_REDIRECT,
            [(header::LOCATION, "/redirect?mock-secret")],
            "mock-secret",
        )
            .into_response(),
        "".into_response(),
        "not SDP: mock-secret".into_response(),
        Json(json!({"error": "mock-secret"})).into_response(),
        vec![0xff, 0xfe].into_response(),
        format!("{SDP}\0mock-secret").into_response(),
        "x".repeat(MAX_SDP + 1).into_response(),
        (
            [(header::TRANSFER_ENCODING, "chunked")],
            "x".repeat(MAX_SDP + 1),
        )
            .into_response(),
    ] {
        let mut mock = mock(response, Duration::ZERO).await;
        let response = request(mock.state.clone(), "POST", "/api/realtime", input()).await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(
            response_json(response).await,
            json!({"error": "Realtime provider request failed"})
        );
        mock.requests.recv().await.unwrap();
        assert!(mock.requests.try_recv().is_err());
        assert_eq!(
            mock.state
                .realtime
                .as_ref()
                .unwrap()
                .slots
                .available_permits(),
            4
        );
    }
}

#[tokio::test]
async fn timeouts_and_transport_errors_release_slots_without_leaking_details() {
    let mut mock = mock(SDP.into_response(), Duration::from_secs(1)).await;
    mock.state.realtime.as_mut().unwrap().client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(50))
        .build()
        .unwrap();
    let response = request(mock.state.clone(), "POST", "/api/realtime", input()).await;
    assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(
        response_json(response).await,
        json!({"error": "Realtime provider timed out"})
    );
    assert_eq!(
        mock.state
            .realtime
            .as_ref()
            .unwrap()
            .slots
            .available_permits(),
        4
    );
    mock.task.abort();
    let _ = (&mut mock.task).await;
    let response = request(mock.state.clone(), "POST", "/api/realtime", input()).await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(
        response_json(response).await,
        json!({"error": "Realtime provider request failed"})
    );
    assert_eq!(
        mock.state
            .realtime
            .as_ref()
            .unwrap()
            .slots
            .available_permits(),
        4
    );
}
