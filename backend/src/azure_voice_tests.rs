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
const ROUTE: &str = "/api/voice/azure";
const STT: &str =
    "/openai/deployments/whisper-deployment/audio/transcriptions?api-version=2024-06-01";
const CHAT: &str =
    "/openai/deployments/audio-deployment/chat/completions?api-version=2025-01-01-preview";
const WEBM: &[u8] = b"\x1a\x45\xdf\xa3recorded-audio";
const MP3: &[u8] = b"ID3mock-mp3";

fn input() -> Value {
    json!({"audio": STANDARD.encode(WEBM), "format": "webm", "name": "idea.md", "spec": "Unsaved spec", "output": {
        "id": "run-1", "status": "running", "output": "Displayed log", "truncated": false
    }, "messages": [{"role": "user", "content": "Prior question"}, {"role": "assistant", "content": "Prior answer"}]})
}

fn transcription() -> Response {
    Json(json!({"text": " What happened? ", "language": "english", "segments": [{"no_speech_prob": 0.01, "avg_logprob": -0.2}]})).into_response()
}

fn completion() -> Value {
    json!({"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": null,
        "audio": {"id": "private-audio-id", "data": STANDARD.encode(MP3), "transcript": "The build is running.", "expires_at": 123}}}]})
}

fn spoken() -> Response {
    Json(completion()).into_response()
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
    let (send, requests) = mpsc::channel(16);
    let respond = Arc::new(respond);
    let server = Router::new()
        .fallback(post(move |uri: Uri, headers: HeaderMap, body: Bytes| {
            let send = send.clone();
            let respond = respond.clone();
            async move {
                let (response, delay) = respond(&uri, &body);
                let _ = send.send((uri, headers, body)).await;
                tokio::time::sleep(delay).await;
                response
            }
        }))
        .layer(DefaultBodyLimit::max(MAX_BODY));
    let mut provider = AzureVoice::configured(
        Some(ENDPOINT),
        Some("azure-secret"),
        Some("whisper-deployment"),
        Some("audio-deployment"),
    )
    .unwrap()
    .unwrap();
    // Only tests replace the canonical HTTPS origin/client with loopback HTTP.
    provider.origin = format!("http://{}", listener.local_addr().unwrap());
    provider.client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let mut state = app(root.path());
    state.azure_voice = Some(provider);
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
fn configuration_requires_all_four_and_canonical_trusted_origin() {
    for mask in 0..16 {
        let result = AzureVoice::configured(
            (mask & 1 != 0).then_some(ENDPOINT),
            (mask & 2 != 0).then_some("azure-secret"),
            (mask & 4 != 0).then_some("whisper"),
            (mask & 8 != 0).then_some("audio"),
        );
        match mask {
            0 => assert!(result.unwrap().is_none()),
            15 => {
                let provider = result.unwrap().unwrap();
                assert!(provider.key.is_sensitive());
                assert_eq!(provider.origin, ENDPOINT);
                assert_eq!(provider.slots.available_permits(), 4);
                assert_eq!(provider.timeout, Duration::from_secs(120));
            }
            _ => assert!(result.is_err()),
        }
    }
    assert!(
        AzureVoice::configured(
            Some(&format!("{ENDPOINT}/")),
            Some("key"),
            Some("whisper-1.0_test"),
            Some("audio")
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
        "https://-test.openai.azure.com",
        "https://test-.openai.azure.com",
    ] {
        assert!(
            AzureVoice::configured(Some(endpoint), Some("key"), Some("whisper"), Some("audio"))
                .is_err(),
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
        let error =
            AzureVoice::configured(Some(ENDPOINT), Some(key), Some("whisper"), Some("audio"))
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
        assert!(
            AzureVoice::configured(Some(ENDPOINT), Some("key"), Some(deployment), Some("audio"))
                .is_err()
        );
        assert!(
            AzureVoice::configured(
                Some(ENDPOINT),
                Some("key"),
                Some("whisper"),
                Some(deployment)
            )
            .is_err()
        );
    }
}

#[test]
fn environment_is_independent_without_mutating_other_tests() {
    if let Ok(mode) = std::env::var("AZURE_VOICE_TEST_CHILD") {
        assert_eq!(AzureVoice::from_env().unwrap().is_some(), mode == "azure");
        assert_eq!(
            crate::Realtime::from_env().unwrap().is_some(),
            mode == "others"
        );
        assert_eq!(
            crate::Completion::from_env().unwrap().is_some(),
            mode == "others"
        );
        return;
    }
    for mode in ["azure", "others"] {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "azure_voice::tests::environment_is_independent_without_mutating_other_tests",
            ])
            .env_clear()
            .env("SPEC_AI_ENV_FILE", "/dev/null")
            .env("AZURE_VOICE_TEST_CHILD", mode);
        if mode == "azure" {
            command
                .env("AZURE_OPENAI_VOICE_ENDPOINT", ENDPOINT)
                .env("AZURE_OPENAI_VOICE_API_KEY", "azure-secret")
                .env("AZURE_OPENAI_WHISPER_DEPLOYMENT", "whisper")
                .env("AZURE_OPENAI_AUDIO_DEPLOYMENT", "audio");
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
async fn exact_wire_protocol_is_whisper_then_audio_never_realtime() {
    for (format, bytes, mime) in [
        ("webm", WEBM, "audio/webm"),
        ("mp4", b"\0\0\0\x18ftypM4A ".as_slice(), "audio/mp4"),
        ("wav", b"RIFF\0\0\0\0WAVE".as_slice(), "audio/wav"),
    ] {
        let mut mock = mock(vec![
            (transcription(), Duration::ZERO),
            (spoken(), Duration::ZERO),
        ])
        .await;
        let mut body = input();
        body["format"] = json!(format);
        body["audio"] = json!(STANDARD.encode(bytes));
        let response = request(mock.state.clone(), "POST", ROUTE, body).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert!(!response.headers().contains_key(header::SET_COOKIE));
        assert_eq!(
            response_json(response).await,
            json!({"transcript": "What happened?", "answer": "The build is running.", "audio": STANDARD.encode(MP3), "format": "mp3"})
        );
        let (uri, headers, body) = mock.requests.recv().await.unwrap();
        assert_eq!(uri, STT);
        assert_eq!(headers["api-key"], "azure-secret");
        assert!(!headers.contains_key(header::AUTHORIZATION));
        let boundary = headers[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .strip_prefix("multipart/form-data; boundary=")
            .unwrap();
        let mut expected = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"recording.{format}\"\r\nContent-Type: {mime}\r\n\r\n").into_bytes();
        expected.extend_from_slice(bytes);
        expected.extend_from_slice(format!("\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\nverbose_json\r\n--{boundary}--\r\n").as_bytes());
        assert_eq!(body.as_ref(), expected); // No language hint, prompt, or context in STT.
        let (uri, headers, body) = mock.requests.recv().await.unwrap();
        assert_eq!(uri, CHAT);
        assert_eq!(headers["api-key"], "azure-secret");
        assert!(!headers.contains_key(header::AUTHORIZATION));
        assert_eq!(headers[header::CONTENT_TYPE], "application/json");
        let payload: Value = serde_json::from_slice(&body).unwrap();
        let context = json!({"name": "idea.md", "spec": "Unsaved spec", "output": input()["output"], "omissions": {"specTailBytes": 0, "outputHeadBytes": 0}, "contextTruncated": false});
        assert_eq!(
            payload,
            json!({"model": "audio-deployment", "modalities": ["text", "audio"], "audio": {"voice": "alloy", "format": "mp3"}, "max_completion_tokens": 4096,
            "messages": [{"role": "system", "content": PROMPT}, {"role": "user", "content": context.to_string()},
                {"role": "user", "content": "Prior question"}, {"role": "assistant", "content": "Prior answer"}, {"role": "user", "content": "What happened?"}]})
        );
        for text in [
            "Speak and write only in English",
            "Please repeat your request in English.",
            "read-only",
            "no tools",
            "untrusted",
            "possibly unsaved",
            "not proof of execution",
            "leading single '# '",
            "complete earlier exchanges",
        ] {
            assert!(PROMPT.contains(text), "{text}");
        }
        assert!(!String::from_utf8_lossy(&body).contains("azure-secret"));
        assert!(mock.requests.try_recv().is_err());
        assert_eq!(std::fs::read_dir(&mock.state.root).unwrap().count(), 0);
        assert!(mock.state.jobs.lock().unwrap().is_empty());
        assert_eq!(
            mock.state
                .azure_voice
                .as_ref()
                .unwrap()
                .slots
                .available_permits(),
            4
        );
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
        mock.state.realtime = if openai {
            crate::Realtime::configured(Some("openai-secret"), None).unwrap()
        } else {
            None
        };
        if !azure {
            mock.state.azure_voice = None;
        }
        let config = request(mock.state.clone(), "GET", "/api/config", Value::Null).await;
        assert_eq!(config.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            response_json(config).await,
            json!({"execution": false, "completion": false, "chat": false, "realtime": openai, "azureVoice": azure})
        );
        if !azure {
            let response = request(mock.state.clone(), "POST", ROUTE, input()).await;
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(
                response_json(response).await,
                json!({"error": "Azure voice is not configured"})
            );
        }
    }
    assert_eq!(
        request(mock.state.clone(), "POST", "/api/realtime/azure", input())
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert!(mock.requests.try_recv().is_err());
}

#[tokio::test]
async fn validation_and_body_limits_precede_provider_requests() {
    let mut mock = mock(vec![]).await;
    for (pointer, value, status) in [
        ("/audio", json!("%%%"), StatusCode::BAD_REQUEST),
        ("/audio", json!(""), StatusCode::BAD_REQUEST),
        ("/audio", json!(STANDARD.encode(b"not audio")), StatusCode::BAD_REQUEST),
        ("/audio", json!("A".repeat(MAX_ENCODED_AUDIO + 1)), StatusCode::PAYLOAD_TOO_LARGE),
        ("/audio", json!(STANDARD.encode(vec![0; MAX_AUDIO + 1])), StatusCode::PAYLOAD_TOO_LARGE),
        ("/format", json!("wav"), StatusCode::BAD_REQUEST),
        ("/format", json!("mp4"), StatusCode::BAD_REQUEST),
        ("/format", json!("ogg"), StatusCode::UNPROCESSABLE_ENTITY),
        ("/name", json!("../secret"), StatusCode::BAD_REQUEST),
        ("/spec", json!("x".repeat(MAX_FILE + 1)), StatusCode::PAYLOAD_TOO_LARGE),
        ("/output/id", json!("x".repeat(129)), StatusCode::BAD_REQUEST),
        ("/output/status", json!("running\n"), StatusCode::BAD_REQUEST),
        ("/output/output", json!("x".repeat(MAX_OUTPUT + 1)), StatusCode::PAYLOAD_TOO_LARGE),
        ("/output/truncated", json!("false"), StatusCode::UNPROCESSABLE_ENTITY),
        ("/messages", json!([{"role": "user", "content": "current question injection"}]), StatusCode::BAD_REQUEST),
        ("/messages", json!([{"role": "assistant", "content": "x"}, {"role": "user", "content": "x"}]), StatusCode::BAD_REQUEST),
        ("/messages", json!([{"role": "user", "content": " "}, {"role": "assistant", "content": "x"}]), StatusCode::BAD_REQUEST),
        ("/messages", json!([{"role": "user", "content": "x\0"}, {"role": "assistant", "content": "x"}]), StatusCode::BAD_REQUEST),
        ("/messages", json!([{"role": "system", "content": "x"}, {"role": "assistant", "content": "x"}]), StatusCode::UNPROCESSABLE_ENTITY),
        ("/messages", json!([{"role": "user", "content": "x", "tools": []}, {"role": "assistant", "content": "x"}]), StatusCode::UNPROCESSABLE_ENTITY),
        ("/messages", json!([{"role": "user", "content": "x".repeat(MAX_PRIOR + 1)}, {"role": "assistant", "content": "x"}]), StatusCode::PAYLOAD_TOO_LARGE),
        ("/messages", json!((0..10).map(|i| json!({"role": if i % 2 == 0 {"user"} else {"assistant"}, "content": "x"})).collect::<Vec<_>>()), StatusCode::BAD_REQUEST),
    ] {
        let mut body = input();
        *body.pointer_mut(pointer).unwrap() = value;
        let response = request(mock.state.clone(), "POST", ROUTE, body).await;
        assert_eq!(response.status(), status, "{pointer}");
    }
    for field in ["audio", "format", "name", "spec", "output", "messages"] {
        let mut body = input();
        body.as_object_mut().unwrap().remove(field);
        assert_eq!(
            request(mock.state.clone(), "POST", ROUTE, body)
                .await
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "{field}"
        );
    }
    for field in [
        "endpoint",
        "model",
        "tools",
        "question",
        "transcript",
        "sdp",
    ] {
        let mut body = input();
        body[field] = json!("injected");
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
                .body(Body::from(" ".repeat(MAX_BODY + 1)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(mock.requests.try_recv().is_err());
}

#[tokio::test]
async fn context_is_utf8_bounded_and_request_limits_allow_escaped_context_and_max_audio() {
    for unicode in [false, true] {
        let mut mock = mock(vec![
            (transcription(), Duration::ZERO),
            (spoken(), Duration::ZERO),
        ])
        .await;
        let mut body = input();
        let mut audio = WEBM.to_vec();
        audio.resize(MAX_AUDIO, 0);
        body["audio"] = json!(STANDARD.encode(audio));
        body["spec"] = json!(if unicode {
            "\u{20ac}".repeat(MAX_FILE / 3)
        } else {
            "\u{1}".repeat(MAX_FILE)
        });
        body["output"]["output"] = json!(if unicode {
            "\u{20ac}".repeat(MAX_OUTPUT / 3)
        } else {
            "\u{1}".repeat(MAX_OUTPUT)
        });
        body["messages"] = json!((0..8).map(|i| json!({"role": if i % 2 == 0 {"user"} else {"assistant"}, "content": "\t".repeat(MAX_PRIOR - 1) + "x"})).collect::<Vec<_>>());
        let spec_len = body["spec"].as_str().unwrap().len();
        let output_len = body["output"]["output"].as_str().unwrap().len();
        assert_eq!(
            request(mock.state.clone(), "POST", ROUTE, body)
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(mock.requests.recv().await.unwrap().0, STT);
        let (_, _, bytes) = mock.requests.recv().await.unwrap();
        let payload: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(payload["messages"].as_array().unwrap().len(), 11);
        let context: Value =
            serde_json::from_str(payload["messages"][1]["content"].as_str().unwrap()).unwrap();
        let kept = if unicode {
            MAX_CONTEXT / 3 * 3
        } else {
            MAX_CONTEXT
        };
        assert_eq!(context["spec"].as_str().unwrap().len(), kept);
        assert_eq!(context["output"]["output"].as_str().unwrap().len(), kept);
        assert_eq!(
            context["omissions"],
            json!({"specTailBytes": spec_len - kept, "outputHeadBytes": output_len - kept})
        );
        assert_eq!(context["contextTruncated"], true);
    }
    let mut mock = mock(vec![
        (transcription(), Duration::ZERO),
        (spoken(), Duration::ZERO),
    ])
    .await;
    let mut body = input();
    body["output"] = Value::Null;
    body["messages"] = json!([]);
    assert_eq!(
        request(mock.state.clone(), "POST", ROUTE, body)
            .await
            .status(),
        StatusCode::OK
    );
    mock.requests.recv().await.unwrap();
    let payload: Value = serde_json::from_slice(&mock.requests.recv().await.unwrap().2).unwrap();
    assert_eq!(payload["messages"].as_array().unwrap().len(), 3);
    let context: Value =
        serde_json::from_str(payload["messages"][1]["content"].as_str().unwrap()).unwrap();
    assert!(context["output"].is_null());
    assert_eq!(context["contextTruncated"], false);
}

#[tokio::test]
async fn empty_and_clearly_silent_transcripts_never_generate() {
    for stt in [
        json!({"text": ""}),
        json!({"text": " \n\t"}),
        json!({"text": "Hallucinated text", "segments": []}),
        json!({"text": "Thank you", "segments": [{"no_speech_prob": 0.99, "avg_logprob": -1.5}]}),
    ] {
        let mut mock = mock(vec![(Json(stt).into_response(), Duration::ZERO)]).await;
        let response = request(mock.state.clone(), "POST", ROUTE, input()).await;
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            response_json(response).await,
            json!({"error": "No speech was recognized. Please record your question again."})
        );
        assert_eq!(mock.requests.recv().await.unwrap().0, STT);
        assert!(mock.requests.try_recv().is_err());
        assert_eq!(
            mock.state
                .azure_voice
                .as_ref()
                .unwrap()
                .slots
                .available_permits(),
            4
        );
    }
    for segments in [
        Value::Null,
        json!([{}]),
        json!([{"no_speech_prob": 0.99, "avg_logprob": -0.1}]),
        json!([{"no_speech_prob": 0.2, "avg_logprob": -1.5}]),
        json!([{"no_speech_prob": 0.99, "avg_logprob": -1.5}, {"no_speech_prob": 0.01, "avg_logprob": -0.1}]),
    ] {
        // Foreign-language speech remains verbatim, not forced to English during STT.
        let mut mock = mock(vec![
            (
                Json(json!({"text": "Bonjour", "language": "french", "segments": segments}))
                    .into_response(),
                Duration::ZERO,
            ),
            (spoken(), Duration::ZERO),
        ])
        .await;
        let response = request(mock.state.clone(), "POST", ROUTE, input()).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response_json(response).await["transcript"], "Bonjour");
        mock.requests.recv().await.unwrap();
        let payload: Value =
            serde_json::from_slice(&mock.requests.recv().await.unwrap().2).unwrap();
        assert_eq!(
            payload["messages"].as_array().unwrap().last().unwrap()["content"],
            "Bonjour"
        );
    }
}

#[tokio::test]
async fn both_stages_bound_and_sanitize_errors_and_refuse_redirects() {
    for stage in 0..2 {
        let limit = if stage == 0 {
            MAX_STT_RESPONSE
        } else {
            MAX_AUDIO_RESPONSE
        };
        for response in [
            (StatusCode::UNAUTHORIZED, "azure-secret").into_response(),
            (StatusCode::TOO_MANY_REQUESTS, "azure-secret").into_response(),
            (StatusCode::INTERNAL_SERVER_ERROR, "azure-secret").into_response(),
            (
                StatusCode::TEMPORARY_REDIRECT,
                [(header::LOCATION, "/leak?azure-secret")],
                "azure-secret",
            )
                .into_response(),
            "".into_response(),
            "not JSON azure-secret".into_response(),
            vec![0xff].into_response(),
            "x".repeat(limit + 1).into_response(),
            streamed("x".repeat(limit + 1).into_response()),
        ] {
            let mut responses = vec![];
            if stage == 1 {
                responses.push((transcription(), Duration::ZERO));
            }
            responses.push((response, Duration::ZERO));
            let mut mock = mock(responses).await;
            let response = request(mock.state.clone(), "POST", ROUTE, input()).await;
            assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
            assert!(!response.headers().contains_key(header::LOCATION));
            assert_eq!(
                response_json(response).await,
                json!({"error": "Azure voice provider request failed"})
            );
            for _ in 0..=stage {
                mock.requests.recv().await.unwrap();
            }
            assert!(mock.requests.try_recv().is_err());
            assert_eq!(
                mock.state
                    .azure_voice
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
async fn response_shapes_text_and_audio_are_validated() {
    for stt in [
        json!({}),
        json!({"text": 123}),
        json!({"text": "x\0"}),
        json!({"text": "x".repeat(MAX_TRANSCRIPT + 1)}),
    ] {
        let mut mock = mock(vec![(Json(stt).into_response(), Duration::ZERO)]).await;
        assert_eq!(
            request(mock.state.clone(), "POST", ROUTE, input())
                .await
                .status(),
            StatusCode::BAD_GATEWAY
        );
        mock.requests.recv().await.unwrap();
        assert!(mock.requests.try_recv().is_err());
    }
    for (pointer, value) in [
        ("/choices", json!([])),
        (
            "/choices",
            json!([completion()["choices"][0], completion()["choices"][0]]),
        ),
        ("/choices/0/finish_reason", json!("length")),
        ("/choices/0/finish_reason", json!("content_filter")),
        ("/choices/0/message/audio", Value::Null),
        ("/choices/0/message/audio/transcript", json!(" ")),
        ("/choices/0/message/audio/transcript", json!("x\0")),
        (
            "/choices/0/message/audio/transcript",
            json!("x".repeat(MAX_ANSWER + 1)),
        ),
        ("/choices/0/message/audio/data", json!("")),
        ("/choices/0/message/audio/data", json!("%%%")),
        (
            "/choices/0/message/audio/data",
            json!(STANDARD.encode(b"not mp3")),
        ),
        (
            "/choices/0/message/audio/data",
            json!(STANDARD.encode(vec![0; MAX_AUDIO + 1])),
        ),
        (
            "/choices/0/message/audio/data",
            json!("x".repeat(MAX_ENCODED_AUDIO + 1)),
        ),
    ] {
        let mut body = completion();
        *body.pointer_mut(pointer).unwrap() = value;
        let mut mock = mock(vec![
            (transcription(), Duration::ZERO),
            (Json(body).into_response(), Duration::ZERO),
        ])
        .await;
        let response = request(mock.state.clone(), "POST", ROUTE, input()).await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY, "{pointer}");
        assert_eq!(
            response_json(response).await,
            json!({"error": "Azure voice provider request failed"})
        );
        mock.requests.recv().await.unwrap();
        mock.requests.recv().await.unwrap();
        assert!(mock.requests.try_recv().is_err());
    }
}

#[tokio::test]
async fn response_byte_and_text_limits_are_inclusive_for_chunked_and_sized_bodies() {
    for chunked in [false, true] {
        let mut stt = json!({"text": "x".repeat(MAX_TRANSCRIPT), "metadata": ""});
        stt["metadata"] =
            json!("x".repeat(MAX_STT_RESPONSE - serde_json::to_vec(&stt).unwrap().len()));
        let mut body = completion();
        let mut mp3 = vec![0xff, 0xfb];
        mp3.resize(MAX_AUDIO, 0);
        body["choices"][0]["message"]["audio"]["data"] = json!(STANDARD.encode(mp3));
        body["choices"][0]["message"]["audio"]["transcript"] = json!("x".repeat(MAX_ANSWER));
        body["metadata"] = json!("");
        body["metadata"] =
            json!("x".repeat(MAX_AUDIO_RESPONSE - serde_json::to_vec(&body).unwrap().len()));
        assert_eq!(serde_json::to_vec(&stt).unwrap().len(), MAX_STT_RESPONSE);
        assert_eq!(serde_json::to_vec(&body).unwrap().len(), MAX_AUDIO_RESPONSE);
        let mut a = Json(stt).into_response();
        let mut b = Json(body).into_response();
        if chunked {
            a = streamed(a);
            b = streamed(b);
        }
        let mock = mock(vec![(a, Duration::ZERO), (b, Duration::ZERO)]).await;
        assert_eq!(
            request(mock.state.clone(), "POST", ROUTE, input())
                .await
                .status(),
            StatusCode::OK
        );
    }
}

#[tokio::test]
async fn deadline_spans_both_stages_and_cancellation_releases_permits() {
    for stage in 0..2 {
        let mut responses = vec![];
        if stage == 1 {
            responses.push((transcription(), Duration::from_millis(150)));
        }
        responses.push((spoken(), Duration::from_millis(200)));
        let mut mock = mock(responses).await;
        mock.state.azure_voice.as_mut().unwrap().timeout =
            Duration::from_millis(if stage == 0 { 50 } else { 300 });
        let response = request(mock.state.clone(), "POST", ROUTE, input()).await;
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(
            response_json(response).await,
            json!({"error": "Azure voice provider timed out"})
        );
        assert_eq!(
            mock.state
                .azure_voice
                .as_ref()
                .unwrap()
                .slots
                .available_permits(),
            4
        );
    }
    let mut mock = mock(vec![
        (transcription(), Duration::ZERO),
        (spoken(), Duration::from_secs(10)),
    ])
    .await;
    let state = mock.state.clone();
    let task = tokio::spawn(async move { request(state, "POST", ROUTE, input()).await });
    mock.requests.recv().await.unwrap();
    mock.requests.recv().await.unwrap();
    let slots = &mock.state.azure_voice.as_ref().unwrap().slots;
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
        json!({"error": "Azure voice provider request failed"})
    );
    assert_eq!(slots.available_permits(), 4);
}

#[tokio::test]
async fn four_concurrent_turns_hold_permits_across_both_requests_and_fifth_is_rejected() {
    let mut mock = mock_responding(|uri, _| {
        if uri == STT {
            (transcription(), Duration::ZERO)
        } else {
            assert_eq!(uri, CHAT);
            (spoken(), Duration::from_secs(10))
        }
    })
    .await;
    let mut tasks = vec![];
    for _ in 0..4 {
        let state = mock.state.clone();
        tasks.push(tokio::spawn(async move {
            request(state, "POST", ROUTE, input()).await
        }));
    }
    for _ in 0..8 {
        mock.requests.recv().await.unwrap();
    }
    let slots = &mock.state.azure_voice.as_ref().unwrap().slots;
    assert_eq!(slots.available_permits(), 0);
    assert_eq!(
        request(mock.state.clone(), "POST", ROUTE, input())
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert!(mock.requests.try_recv().is_err());
    for task in tasks {
        task.abort();
        let _ = task.await;
    }
    assert_eq!(slots.available_permits(), 4);
}
