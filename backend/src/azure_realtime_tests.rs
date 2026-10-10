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
use std::collections::VecDeque;
use tokio::{sync::mpsc, task::JoinHandle};
use tower::ServiceExt;

const ENDPOINT: &str = "https://test-resource.openai.azure.com";
const ROUTE: &str = "/api/realtime/azure";
const SDP: &str = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

fn input() -> Value {
    json!({"sdp": SDP, "name": "idea.md", "spec": "Unsaved spec", "output": {
        "id": "run-1", "status": "running", "output": "Displayed log", "truncated": false
    }})
}

fn secret() -> Response {
    Json(json!({"value": "ephemeral-secret", "expires_at": 123, "session": {}})).into_response()
}

fn streamed(response: Response) -> Response {
    let (mut parts, body) = response.into_parts();
    parts.headers.remove(header::CONTENT_LENGTH);
    Response::from_parts(parts, Body::from_stream(body.into_data_stream()))
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

async fn mock(responses: Vec<(Response, Duration)>) -> Mock {
    let responses = std::sync::Mutex::new(VecDeque::from(responses));
    mock_responding(move |_, _| {
        responses.lock().unwrap().pop_front().unwrap_or((
            StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            Duration::ZERO,
        ))
    })
    .await
}

async fn mock_responding(
    respond: impl Fn(&Uri, &Bytes) -> (Response, Duration) + Send + Sync + 'static,
) -> Mock {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (send, requests) = mpsc::channel(8);
    let respond = Arc::new(respond);
    let server = Router::new()
        .fallback(post(move |uri: Uri, headers: HeaderMap, body: Bytes| {
            let send = send.clone();
            let respond = respond.clone();
            async move {
                let (response, delay) = respond(&uri, &body);
                send.send((uri, headers, body)).await.unwrap();
                tokio::time::sleep(delay).await;
                response
            }
        }))
        .layer(DefaultBodyLimit::max(realtime::MAX_BODY));
    let mut provider = AzureRealtime::configured(
        Some(ENDPOINT),
        Some("azure-secret"),
        Some("voice-deployment"),
    )
    .unwrap()
    .unwrap();
    // Only tests replace the trusted HTTPS origin/client with isolated loopback HTTP.
    provider.origin = format!("http://{}", listener.local_addr().unwrap());
    provider.client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let mut state = app(root.path());
    state.azure_realtime = Some(provider);
    Mock {
        state,
        requests,
        _root: root,
        task: tokio::spawn(async move {
            axum::serve(listener, server).await.unwrap();
        }),
    }
}

#[test]
fn configuration_requires_all_three_and_rejects_untrusted_origins() {
    for mask in 0..8 {
        let result = AzureRealtime::configured(
            (mask & 1 != 0).then_some(ENDPOINT),
            (mask & 2 != 0).then_some("azure-secret"),
            (mask & 4 != 0).then_some("voice-deployment"),
        );
        match mask {
            0 => assert!(result.unwrap().is_none()),
            7 => {
                let provider = result.unwrap().unwrap();
                assert!(provider.key.is_sensitive());
                assert_eq!(provider.origin, ENDPOINT);
                assert_eq!(provider.slots.available_permits(), 4);
                assert_eq!(provider.timeout, Duration::from_secs(30));
            }
            _ => assert!(result.is_err()),
        }
    }
    assert!(
        AzureRealtime::configured(
            Some(&format!("{ENDPOINT}/")),
            Some("key"),
            Some("voice-1.5_test")
        )
        .is_ok()
    );
    for endpoint in [
        "",
        "http://test.openai.azure.com",
        "https://evil.test",
        "https://openai.azure.com",
        "https://test.openai.azure.com.evil.test",
        "https://test.evil.openai.azure.com",
        "https://127.0.0.1",
        "https://user:secret@test.openai.azure.com",
        "https://@test.openai.azure.com",
        "https://test.openai.azure.com:8443",
        "https://test.openai.azure.com:443",
        "https://test.openai.azure.com?secret",
        "https://test.openai.azure.com#secret",
        "https://test.openai.azure.com/openai/v1",
        "https://test.openai.azure.com/../",
        "https://test.openai.azure.com/%2e/",
        "https://test.openai.azure.com//",
        " https://test.openai.azure.com",
        "https://test.openai.azure.com\n",
        "https://test.openai.azure.com\\",
    ] {
        assert!(
            AzureRealtime::configured(Some(endpoint), Some("key"), Some("voice")).is_err(),
            "{endpoint:?}"
        );
    }
    for key in [
        "",
        " ",
        "bad\nkey",
        "bad\0key",
        "non-ascii-\u{e9}",
        &"x".repeat(4097),
    ] {
        let error = AzureRealtime::configured(Some(ENDPOINT), Some(key), Some("voice"))
            .err()
            .unwrap();
        assert!(!error.contains(ENDPOINT));
    }
    for deployment in [
        "",
        " ",
        ".",
        "..",
        "bad/model",
        "bad\nmodel",
        &"x".repeat(129),
    ] {
        assert!(AzureRealtime::configured(Some(ENDPOINT), Some("key"), Some(deployment)).is_err());
    }
}

#[test]
fn environment_is_independent_without_mutating_other_tests() {
    if let Ok(mode) = std::env::var("AZURE_REALTIME_TEST_CHILD") {
        let azure = AzureRealtime::from_env().unwrap();
        let openai = crate::Realtime::from_env().unwrap();
        let text = crate::Completion::from_env().unwrap();
        assert_eq!(azure.is_some(), mode == "azure");
        assert_eq!(openai.is_some(), mode == "others");
        assert_eq!(text.is_some(), mode == "others");
        return;
    }
    for mode in ["azure", "others"] {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "azure_realtime::tests::environment_is_independent_without_mutating_other_tests",
            ])
            .env_clear()
            .env("SPEC_AI_ENV_FILE", "/dev/null")
            .env("AZURE_REALTIME_TEST_CHILD", mode);
        if mode == "azure" {
            command
                .env("AZURE_OPENAI_REALTIME_ENDPOINT", ENDPOINT)
                .env("AZURE_OPENAI_REALTIME_API_KEY", "azure-secret")
                .env("AZURE_OPENAI_REALTIME_DEPLOYMENT", "voice");
        } else {
            command
                .env("OPENAI_API_KEY", "openai-secret")
                .env(
                    "AZURE_OPENAI_ENDPOINT",
                    "https://text.openai.azure.com/openai/v1",
                )
                .env("AZURE_OPENAI_API_KEY", "text-secret")
                .env("DEPLOYMENT_NAME", "text");
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }
}

#[tokio::test]
async fn ga_protocol_keeps_credentials_separate_and_snapshot_read_only() {
    let mut mock = mock(vec![
        (secret(), Duration::ZERO),
        (
            (
                StatusCode::CREATED,
                [
                    (header::LOCATION, "/private-call-id"),
                    (header::SET_COOKIE, "secret"),
                ],
                SDP,
            )
                .into_response(),
            Duration::ZERO,
        ),
    ])
    .await;
    let response = request(mock.state.clone(), "POST", ROUTE, input()).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert!(!response.headers().contains_key(header::LOCATION));
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    assert_eq!(response_json(response).await, json!({"sdp": SDP}));
    let (uri, headers, body) = mock.requests.recv().await.unwrap();
    assert_eq!(uri, "/openai/v1/realtime/client_secrets");
    assert_eq!(headers["api-key"], "azure-secret");
    assert!(!headers.contains_key(header::AUTHORIZATION));
    assert!(!headers.contains_key("openai-beta"));
    assert_eq!(headers[header::CONTENT_TYPE], "application/json");
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload.as_object().unwrap().len(), 1);
    let mut decoded: Input = serde_json::from_value(input()).unwrap();
    assert_eq!(
        payload["session"],
        realtime::session(&mut decoded, "voice-deployment")
    );
    assert!(!String::from_utf8_lossy(&body).contains("azure-secret"));
    let (uri, headers, body) = mock.requests.recv().await.unwrap();
    assert_eq!(uri, "/openai/v1/realtime/calls"); // No api-version or webrtcfilter.
    assert_eq!(headers[header::AUTHORIZATION], "Bearer ephemeral-secret");
    assert_eq!(headers[header::CONTENT_TYPE], "application/sdp");
    assert!(!headers.contains_key("api-key"));
    assert!(!headers.contains_key("openai-beta"));
    assert_eq!(body.as_ref(), SDP.as_bytes());
    assert_eq!(std::fs::read_dir(&mock.state.root).unwrap().count(), 0);
    assert!(mock.state.jobs.lock().unwrap().is_empty());
    assert_eq!(
        mock.state
            .azure_realtime
            .as_ref()
            .unwrap()
            .slots
            .available_permits(),
        4
    );
}

#[tokio::test]
async fn client_secret_accepts_echoed_escape_heavy_session_and_exact_json_limit() {
    for (chunked, pad_to_limit) in [(false, false), (true, false), (false, true), (true, true)] {
        let mut mock = mock_responding(move |uri, body| {
            if uri.path() == "/openai/v1/realtime/client_secrets" {
                let submitted: Value = serde_json::from_slice(body).unwrap();
                let instructions = submitted["session"]["instructions"].as_str().unwrap();
                assert_eq!(instructions.matches("\\u0001").count(), 32 * 1024);
                let mut echoed = json!({
                    "value": "ephemeral-secret",
                    "session": submitted["session"],
                    "metadata": "",
                });
                let size = serde_json::to_vec(&echoed).unwrap().len();
                assert!(size > 7 * 32 * 1024);
                assert!(size > realtime::MAX_SDP);
                assert!(size < MAX_SECRET_RESPONSE);
                if pad_to_limit {
                    echoed["metadata"] = json!("x".repeat(MAX_SECRET_RESPONSE - size));
                    assert_eq!(
                        serde_json::to_vec(&echoed).unwrap().len(),
                        MAX_SECRET_RESPONSE
                    );
                }
                let mut response = Json(echoed).into_response();
                if chunked {
                    response = streamed(response);
                }
                (response, Duration::ZERO)
            } else {
                assert_eq!(uri, "/openai/v1/realtime/calls");
                assert_eq!(body.as_ref(), SDP.as_bytes());
                (SDP.into_response(), Duration::ZERO)
            }
        })
        .await;
        let mut body = input();
        body["spec"] = json!("\u{1}".repeat(16 * 1024));
        body["output"]["output"] = json!("\u{1}".repeat(16 * 1024));
        let response = request(mock.state.clone(), "POST", ROUTE, body).await;
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "chunked={chunked}, pad_to_limit={pad_to_limit}"
        );
        assert_eq!(response_json(response).await, json!({"sdp": SDP}));
        assert_eq!(
            mock.requests.recv().await.unwrap().0,
            "/openai/v1/realtime/client_secrets"
        );
        let (_, headers, _) = mock.requests.recv().await.unwrap();
        assert_eq!(headers[header::AUTHORIZATION], "Bearer ephemeral-secret");
        assert!(mock.requests.try_recv().is_err());
    }
}

#[tokio::test]
async fn authentication_capabilities_and_disabled_routes_are_independent() {
    let mut mock = mock(vec![]).await;
    for token in [None, Some("Bearer wrong")] {
        let mut req = Request::builder().method("POST").uri(ROUTE);
        if let Some(token) = token {
            req = req.header(header::AUTHORIZATION, token);
        }
        let response = crate::router(mock.state.clone())
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    for (azure, openai) in [(true, false), (true, true), (false, true), (false, false)] {
        if openai {
            mock.state.realtime = crate::Realtime::configured(Some("openai-secret"), None).unwrap();
        } else {
            mock.state.realtime = None;
        }
        if !azure {
            mock.state.azure_realtime = None;
        }
        let config = request(mock.state.clone(), "GET", "/api/config", Value::Null).await;
        assert_eq!(config.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            response_json(config).await,
            json!({"execution": false, "completion": false,
            "chat": false, "realtime": openai, "azureRealtime": azure})
        );
        if !azure {
            let response = request(mock.state.clone(), "POST", ROUTE, input()).await;
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(
                response_json(response).await,
                json!({"error": "Azure OpenAI Realtime is not configured"})
            );
        }
    }
    assert!(mock.requests.try_recv().is_err());
}

#[tokio::test]
async fn validation_body_limits_and_concurrency_precede_provider_requests() {
    let mut mock = mock(vec![
        (secret(), Duration::ZERO),
        (SDP.into_response(), Duration::ZERO),
    ])
    .await;
    for (field, value, status) in [
        ("sdp", json!("not SDP"), StatusCode::BAD_REQUEST),
        ("name", json!("../secret"), StatusCode::BAD_REQUEST),
        (
            "sdp",
            json!("x".repeat(realtime::MAX_SDP + 1)),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (
            "spec",
            json!("x".repeat(crate::MAX_FILE + 1)),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (
            "endpoint",
            json!("https://evil.test"),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        ("model", json!("other"), StatusCode::UNPROCESSABLE_ENTITY),
        ("tools", json!([]), StatusCode::UNPROCESSABLE_ENTITY),
    ] {
        let mut body = input();
        body[field] = value;
        assert_eq!(
            request(mock.state.clone(), "POST", ROUTE, body)
                .await
                .status(),
            status
        );
    }
    for (field, value, status) in [
        ("id", json!("x".repeat(129)), StatusCode::BAD_REQUEST),
        ("status", json!("running\n"), StatusCode::BAD_REQUEST),
        (
            "output",
            json!("x".repeat(crate::MAX_OUTPUT + 1)),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (
            "truncated",
            json!("false"),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
    ] {
        let mut body = input();
        body["output"][field] = value;
        assert_eq!(
            request(mock.state.clone(), "POST", ROUTE, body)
                .await
                .status(),
            status
        );
    }
    for field in ["sdp", "name", "spec", "output"] {
        let mut body = input();
        body.as_object_mut().unwrap().remove(field);
        assert_eq!(
            request(mock.state.clone(), "POST", ROUTE, body)
                .await
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let response = crate::router(mock.state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(ROUTE)
                .header(header::AUTHORIZATION, "Bearer test-token")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(" ".repeat(realtime::MAX_BODY + 1)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let slots = mock.state.azure_realtime.as_ref().unwrap().slots.clone();
    let permits = slots.acquire_many(4).await.unwrap();
    assert_eq!(
        request(mock.state.clone(), "POST", ROUTE, input())
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert!(mock.requests.try_recv().is_err());
    drop(permits);
    let mut body = input();
    body["sdp"] = json!(format!(
        "{SDP}a={}",
        "x".repeat(realtime::MAX_SDP - SDP.len() - 2)
    ));
    body["spec"] = json!("\u{1}".repeat(crate::MAX_FILE));
    body["output"] = Value::Null;
    assert_eq!(
        request(mock.state.clone(), "POST", ROUTE, body)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(slots.available_permits(), 4);
}

#[tokio::test]
async fn both_stages_bound_and_sanitize_errors_and_refuse_redirects() {
    for stage in 0..2 {
        // Otherwise-valid bodies ensure rejection is due to the stage's bound.
        let oversized = if stage == 0 {
            let mut body = json!({"value": "ephemeral-secret", "metadata": ""});
            let size = serde_json::to_vec(&body).unwrap().len();
            body["metadata"] = json!("x".repeat(MAX_SECRET_RESPONSE + 1 - size));
            serde_json::to_string(&body).unwrap()
        } else {
            format!(
                "{SDP}a={}",
                "x".repeat(realtime::MAX_SDP + 1 - SDP.len() - 2)
            )
        };
        for response in [
            (StatusCode::UNAUTHORIZED, "azure-secret ephemeral-secret").into_response(),
            (StatusCode::TOO_MANY_REQUESTS, "azure-secret").into_response(),
            (StatusCode::INTERNAL_SERVER_ERROR, "ephemeral-secret").into_response(),
            (
                StatusCode::TEMPORARY_REDIRECT,
                [(header::LOCATION, "/leak?azure-secret")],
                "ephemeral-secret",
            )
                .into_response(),
            "".into_response(),
            "not SDP or JSON azure-secret".into_response(),
            vec![0xff].into_response(),
            format!("{SDP}\0ephemeral-secret").into_response(),
            oversized.clone().into_response(),
            streamed(oversized.into_response()),
            Json(json!({"value": ""})).into_response(),
            Json(json!({"value": "bad\r\nheader"})).into_response(),
            Json(json!({"value": "x".repeat(4097)})).into_response(),
            Json(json!({"value": 123})).into_response(),
            Json(json!({"client_secret": {"value": "ephemeral-secret"}})).into_response(),
        ] {
            let mut responses = vec![];
            if stage == 1 {
                responses.push((secret(), Duration::ZERO));
            }
            responses.push((response, Duration::ZERO));
            let mut mock = mock(responses).await;
            let response = request(mock.state.clone(), "POST", ROUTE, input()).await;
            assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
            assert_eq!(
                response_json(response).await,
                json!({"error": "Realtime provider request failed"})
            );
            for _ in 0..=stage {
                mock.requests.recv().await.unwrap();
            }
            assert!(mock.requests.try_recv().is_err());
            assert_eq!(
                mock.state
                    .azure_realtime
                    .as_ref()
                    .unwrap()
                    .slots
                    .available_permits(),
                4
            );
        }
    }
}

#[tokio::test]
async fn deadline_spans_both_stages_and_cancellation_releases_permits() {
    for stage in 0..2 {
        let mut responses = vec![];
        if stage == 1 {
            responses.push((secret(), Duration::from_millis(150)));
        }
        responses.push((secret(), Duration::from_millis(200)));
        let mut mock = mock(responses).await;
        mock.state.azure_realtime.as_mut().unwrap().timeout = Duration::from_millis(300);
        if stage == 0 {
            mock.state.azure_realtime.as_mut().unwrap().timeout = Duration::from_millis(50);
        }
        let response = request(mock.state.clone(), "POST", ROUTE, input()).await;
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(
            response_json(response).await,
            json!({"error": "Realtime provider timed out"})
        );
        assert_eq!(
            mock.state
                .azure_realtime
                .as_ref()
                .unwrap()
                .slots
                .available_permits(),
            4
        );
    }
    let mut mock = mock(vec![
        (secret(), Duration::ZERO),
        (SDP.into_response(), Duration::from_secs(10)),
    ])
    .await;
    let state = mock.state.clone();
    let task = tokio::spawn(async move { request(state, "POST", ROUTE, input()).await });
    mock.requests.recv().await.unwrap();
    mock.requests.recv().await.unwrap();
    let slots = &mock.state.azure_realtime.as_ref().unwrap().slots;
    assert_eq!(slots.available_permits(), 3);
    task.abort();
    let _ = task.await;
    assert_eq!(slots.available_permits(), 4);
    mock.task.abort();
    let _ = (&mut mock.task).await;
    let response = request(mock.state.clone(), "POST", ROUTE, input()).await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(
        response_json(response).await,
        json!({"error": "Realtime provider request failed"})
    );
    assert_eq!(slots.available_permits(), 4);
}
