use super::*;
use axum::body::Body;
use http_body_util::BodyExt;
use std::os::unix::fs::symlink;
use tower::ServiceExt;

#[path = "repository_tests.rs"]
mod repository_tests;

#[path = "continuation_tests.rs"]
mod continuation_tests;

#[path = "optimization_tests.rs"]
mod optimization_tests;

#[path = "performance_tests.rs"]
mod performance_tests;

#[path = "retained_tests.rs"]
mod retained_tests;

#[path = "analytics_tests.rs"]
mod analytics_tests;

#[path = "recovery_tests.rs"]
mod recovery_tests;

#[path = "queued_build_tests.rs"]
mod queued_build_tests;

#[test]
fn auth_token_file_format_is_strict_and_read_only() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("workspace");
    let ui = directory.path().join("ui");
    let path = directory.path().join("token");
    let token = "0123456789abcdef".repeat(4);
    for (bytes, valid) in [
        (token.as_bytes().to_vec(), true),
        (format!("{token}\n").into_bytes(), true),
        (Vec::new(), false),
        (vec![b'0'; 63], false),
        (vec![b'0'; 65], false),
        (vec![b'0'; 66], false),
        (token.to_uppercase().into_bytes(), false),
        (vec![b'g'; 64], false),
        (vec![0xff; 64], false),
        (vec![0; 64], false),
        (format!("{token}\r\n").into_bytes(), false),
        (format!("{token}\n\n").into_bytes(), false),
        (format!("{token} ").into_bytes(), false),
        (format!(" {}", &token[..63]).into_bytes(), false),
    ] {
        fs::write(&path, &bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let result = load_auth_token(Some(path.clone()), &root, &ui);
        if valid {
            assert_eq!(result.unwrap(), token);
        } else {
            assert!(
                result
                    .unwrap_err()
                    .starts_with("Could not load SPEC_AUTH_TOKEN_FILE:")
            );
        }
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn auth_token_without_file_remains_ephemeral() {
    let root = FsPath::new("/unused-workspace");
    let first = load_auth_token(None, root, root).unwrap();
    let second = load_auth_token(None, root, root).unwrap();
    assert_ne!(first, second);
    for token in [first, second] {
        assert_eq!(token.len(), 64);
        assert!(
            token
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        );
    }
}

pub(super) fn app(root: &FsPath) -> App {
    let settings = settings::Store::open(
        root.with_extension("settings").join("profile.json"),
        root,
        &root.join("ui"),
        None,
    )
    .ok()
    .unwrap();
    App {
        marketplace: Arc::new(marketplace::Store::demo(&settings)),
        root: root.to_owned(),
        token: "test-token".into(),
        remote: None,
        computeruse: Arc::default(),
        completion: None,
        settings: Arc::new(settings),
        realtime: None,
        storage: Arc::new(
            storage::Store::open(
                settings::PrivateFile::open(
                    root.with_extension("settings")
                        .join("profile.json.storage.json"),
                    root,
                    &root.join("ui"),
                )
                .ok()
                .unwrap(),
            )
            .ok()
            .unwrap(),
        ),
        azure_realtime: None,
        files: Arc::new(Mutex::new(())),
        jobs: Arc::new(Mutex::new(Vec::new())),
        recovered: Arc::new(Mutex::new(false)),
        recovery_runs: Arc::default(),
        recovery_gate: Arc::new(tokio::sync::Mutex::new(())),
        performance_state: RunState::default(),
        performance: false,
        project_search_slots: Arc::new(tokio::sync::Semaphore::new(1)),
    }
}

// Execute the actual fixed remote scripts locally, with an isolated HOME and a
// fake spec alias. No SSH daemon, remote account, or model credentials are used.
pub(super) fn remote_fixture(root: &FsPath, runner: &FsPath) -> Remote {
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\"'\"'"));
    let binary = root.join("ssh-fixture");
    fs::write(
        &binary,
        format!(
            "#!/bin/bash\nexport HOME={}\nexec /bin/bash -c \"${{!#}}\"\n",
            quote(root.to_str().unwrap())
        ),
    )
    .unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(
        root.join(".bash_aliases"),
        format!("alias spec={}\n", quote(&quote(runner.to_str().unwrap()))),
    )
    .unwrap();
    Remote {
        binary,
        target: "fixture@host".into(),
        directory: root.to_str().unwrap().into(),
        key: None,
        performance: false,
    }
}

pub(super) async fn request(
    app: App,
    method: &str,
    path: &str,
    body: serde_json::Value,
) -> Response {
    router(app)
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header(header::AUTHORIZATION, "Bearer test-token")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

pub(super) async fn json(response: Response) -> serde_json::Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

#[tokio::test]
async fn all_api_routes_require_authentication() {
    let root = tempfile::tempdir().unwrap();
    for (method, path) in [
        ("GET", "/api/files"),
        ("GET", "/api/files/a.md"),
        ("GET", "/api/files/a.md/run"),
        ("GET", "/api/files/a.md/run/log"),
        ("GET", "/api/files/a.md/retained-runs"),
        ("GET", "/api/files/a.md/retained-runs/id/log"),
        ("PUT", "/api/files/a.md"),
        ("GET", "/api/config"),
        ("GET", "/api/computeruse"),
        ("GET", "/api/computeruse/file"),
        ("POST", "/api/computeruse/push"),
        ("POST", "/api/computeruse/pull"),
        ("POST", "/api/computeruse/run"),
        ("POST", "/api/computeruse/runs/id/cancel"),
        ("POST", "/api/completions"),
        ("POST", "/api/analytics"),
        ("POST", "/api/realtime"),
        ("POST", "/api/realtime/azure"),
        ("POST", "/api/runs"),
        ("GET", "/api/runs"),
        ("GET", "/api/optimize"),
        ("POST", "/api/optimize"),
        ("GET", "/api/performance"),
        ("POST", "/api/performance"),
        ("GET", "/api/performance/runs"),
        ("GET", "/api/performance/runs/id"),
        ("POST", "/api/performance/runs/id/cancel"),
        ("POST", "/api/projects/search"),
        ("GET", "/api/repository"),
        ("POST", "/api/repository/save"),
        ("GET", "/api/runs/id"),
        ("POST", "/api/runs/id/cancel"),
        ("POST", "/api/runs/id/continue"),
    ] {
        let response = router(app(root.path()))
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "{method} {path}"
        );
    }
}

#[tokio::test]
async fn save_list_reload_and_conflict_preserve_content() {
    let root = tempfile::tempdir().unwrap();
    let state = app(root.path());
    let response = request(
        state.clone(),
        "PUT",
        "/api/files/idea.md",
        serde_json::json!({"content":"hello 🌱\n", "revision":null}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let doc = json(response).await;
    let conflict = request(
        state.clone(),
        "PUT",
        "/api/files/idea.md",
        serde_json::json!({"content":"overwrite", "revision":null}),
    )
    .await;
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    let updated = request(
        state.clone(),
        "PUT",
        "/api/files/idea.md",
        serde_json::json!({"content":"next", "revision":doc["revision"]}),
    )
    .await;
    assert_eq!(updated.status(), StatusCode::OK);
    // Simulate restarting the application: disk is the durable history source.
    let fresh = app(root.path());
    let loaded = json(
        request(
            fresh.clone(),
            "GET",
            "/api/files/idea.md",
            serde_json::Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(loaded["content"], "next");
    let files = json(request(fresh, "GET", "/api/files", serde_json::Value::Null).await).await;
    assert_eq!(files[0]["name"], "idea.md");
    assert_eq!(
        fs::metadata(root.path().join("idea.md"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn unsafe_names_and_content_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let state = app(root.path());
    for name in [
        "../secret",
        "/tmp/secret",
        ".env",
        "a/b",
        "a\\b",
        "a\nb",
        "",
        " padded.md",
        "C:secret",
    ] {
        assert!(
            save(
                &state,
                name,
                Save {
                    content: "x".into(),
                    revision: None
                }
            )
            .is_err(),
            "{name}"
        );
    }
    assert!(
        save(
            &state,
            "binary",
            Save {
                content: "a\0b".into(),
                revision: None
            }
        )
        .is_err()
    );
    assert!(
        save(
            &state,
            "large",
            Save {
                content: "x".repeat(MAX_FILE + 1),
                revision: None
            }
        )
        .is_err()
    );
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn symlinks_and_nonregular_files_are_never_read_or_overwritten() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    fs::write(outside.path(), "private").unwrap();
    symlink(outside.path(), root.path().join("link.md")).unwrap();
    let state = app(root.path());
    assert!(read(root.path(), "link.md").is_err());
    assert!(
        save(
            &state,
            "link.md",
            Save {
                content: "overwrite".into(),
                revision: None
            }
        )
        .is_err()
    );
    assert_eq!(fs::read_to_string(outside.path()).unwrap(), "private");
    nix::unistd::mkfifo(&root.path().join("pipe"), nix::sys::stat::Mode::S_IRUSR).unwrap();
    assert!(read(root.path(), "pipe").is_err());
}

#[test]
fn externally_changed_files_are_not_overwritten() {
    let root = tempfile::tempdir().unwrap();
    let state = app(root.path());
    let original = save(
        &state,
        "a.md",
        Save {
            content: "first".into(),
            revision: None,
        },
    )
    .ok()
    .unwrap();
    fs::write(root.path().join("a.md"), "external").unwrap();
    assert!(matches!(
        save(
            &state,
            "a.md",
            Save {
                content: "stale".into(),
                revision: Some(original.revision)
            }
        ),
        Err(Error(StatusCode::CONFLICT, _))
    ));
    assert_eq!(
        fs::read_to_string(root.path().join("a.md")).unwrap(),
        "external"
    );
}

#[tokio::test]
async fn encoded_traversal_is_rejected() {
    let root = tempfile::tempdir().unwrap();
    for path in [
        "/api/files/%2e%2e%2fsecret",
        "/api/files/%2Fetc%2Fpasswd",
        "/api/files/.env",
    ] {
        let response = request(app(root.path()), "GET", path, serde_json::Value::Null).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn execution_is_disabled_by_default() {
    let root = tempfile::tempdir().unwrap();
    let response = request(
        app(root.path()),
        "POST",
        "/api/runs",
        serde_json::json!({"name":"a.md", "revision":"x"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[test]
fn output_buffers_are_bounded() {
    let root = tempfile::tempdir().unwrap();
    let state = app(root.path());
    let (stop, _) = watch::channel(RunControl::Running);
    state.jobs.lock().unwrap().push(Job {
        id: "id".into(),
        name: "a".into(),
        status: "running".into(),
        output: VecDeque::new(),
        truncated: false,
        stop,
        remote_identity: "0".repeat(64),
        recover: true,
        repository_save: false,
        optimization: false,
        memory: None,
        attached: true,
        dirty: false,
        persistence_error: None,
    });
    append(&state, "id", &vec![b'x'; MAX_OUTPUT + 50]);
    append(&state, "id", b"last");
    let jobs = state.jobs.lock().unwrap();
    assert_eq!(jobs[0].output.len(), MAX_OUTPUT);
    assert!(jobs[0].truncated);
    assert!(
        jobs[0]
            .output
            .iter()
            .copied()
            .collect::<Vec<_>>()
            .ends_with(b"last")
    );
}

#[tokio::test]
async fn build_size_limit_does_not_limit_saving() {
    let root = tempfile::tempdir().unwrap();
    let mut state = app(root.path());
    // If validation regresses, spawning this nonexistent launcher will fail differently.
    state.remote = Some(remote_fixture(
        root.path(),
        &root.path().join("missing-launcher"),
    ));
    let doc = save(
        &state,
        "large.md",
        Save {
            content: "x".repeat(MAX_BUILD_SPEC + 1),
            revision: None,
        },
    )
    .ok()
    .unwrap();
    let response = request(
        state.clone(),
        "POST",
        "/api/runs",
        serde_json::json!({"name":"large.md", "revision":doc.revision}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(
        json(response).await["error"]
            .as_str()
            .unwrap()
            .contains("120 KiB")
    );
    assert!(state.jobs.lock().unwrap().is_empty());
    assert_eq!(
        read(root.path(), "large.md").ok().unwrap().content,
        doc.content
    );
}

#[tokio::test]
async fn build_exit_status_and_snapshot_cleanup() {
    for exit_code in [0, 7] {
        let root = tempfile::Builder::new()
            .prefix("spec ' $(no-injection) ")
            .tempdir()
            .unwrap();
        let runner = root.path().join("spec launcher");
        fs::write(
            &runner,
            format!(
                "#!/bin/sh\n[ \"$#\" = 2 ] && [ \"$1\" = build ] && [ \"$SPEC_BUILD_AUTO\" = 1 ] || exit 90\nprintf '%s' \"$2\" > snapshot-path\ncat -- \"$2\" >/dev/null\nprintf 'stderr output' >&2\nexit {exit_code}\n"
            ),
        )
        .unwrap();
        fs::set_permissions(&runner, fs::Permissions::from_mode(0o700)).unwrap();
        let mut state = app(root.path());
        state.remote = Some(remote_fixture(root.path(), &runner));
        let doc = save(
            &state,
            "a.md",
            Save {
                // The exact size limit must remain accepted.
                content: "x".repeat(MAX_BUILD_SPEC),
                revision: None,
            },
        )
        .ok()
        .unwrap();
        let response = request(
            state.clone(),
            "POST",
            "/api/runs",
            serde_json::json!({"name":"a.md", "revision":doc.revision}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if state.jobs.lock().unwrap()[0].status != "running" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let snapshot =
            PathBuf::from(fs::read_to_string(root.path().join("snapshot-path")).unwrap());
        assert!(!snapshot.exists());
        assert_eq!(
            fs::read_to_string(snapshot.parent().unwrap().join("status"))
                .unwrap()
                .trim(),
            exit_code.to_string()
        );
        let jobs = state.jobs.lock().unwrap();
        assert_eq!(
            jobs[0].status,
            if exit_code == 0 {
                "completed"
            } else {
                "failed (exit status: 7)"
            }
        );
        let output = jobs[0].output.iter().copied().collect::<Vec<_>>();
        assert!(String::from_utf8_lossy(&output).contains("stderr output"));
    }
}

#[tokio::test]
async fn run_streams_snapshot_and_can_be_cancelled() {
    let root = tempfile::tempdir().unwrap();
    // A local deterministic process fixture, never a model/provider call.
    let mut runner = tempfile::NamedTempFile::new().unwrap();
    runner
        .write_all(
            br#"#!/bin/sh
[ "$#" = 2 ] && [ "$1" = build ] && [ "$SPEC_BUILD_AUTO" = 1 ] && [ "$SPEC_BUILD_FOREGROUND" = 1 ] || exit 90
printf '%s' "$2" > snapshot-path
while [ ! -f ready ]; do sleep 0.02; done
cat -- "$2"
printf '\nfixture-output\n'
sleep 60 &
printf '%s' "$!" > descendant-pid
wait
"#,
        )
        .unwrap();
    runner
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o700))
        .unwrap();
    let runner = runner.into_temp_path();
    let mut state = app(root.path());
    state.remote = Some(remote_fixture(root.path(), &runner));
    let doc = save(
        &state,
        "a.md",
        Save {
            content: "snapshot\n$(touch injected); `touch injected`\n--help\n".into(),
            revision: None,
        },
    )
    .ok()
    .unwrap();
    let response = request(
        state.clone(),
        "POST",
        "/api/runs",
        serde_json::json!({"name":"a.md", "revision":doc.revision}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let id = json(response).await["id"].as_str().unwrap().to_owned();
    let duplicate = request(
        state.clone(),
        "POST",
        "/api/runs",
        serde_json::json!({"name":"a.md", "revision":doc.revision}),
    )
    .await;
    assert_eq!(duplicate.status(), StatusCode::CONFLICT);
    let error = json(duplicate).await["error"].as_str().unwrap().to_owned();
    assert!(error.contains("for this file"));
    assert!(error.contains(&id));
    assert!(!error.contains("limit"));
    fs::write(root.path().join("a.md"), "changed after launch").unwrap();
    fs::write(root.path().join("ready"), "").unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let response = json(
                request(
                    state.clone(),
                    "GET",
                    &format!("/api/runs/{id}"),
                    serde_json::Value::Null,
                )
                .await,
            )
            .await;
            if response["output"]
                .as_str()
                .unwrap()
                .contains(&format!("{}\nfixture-output", doc.content))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let snapshot = PathBuf::from(fs::read_to_string(root.path().join("snapshot-path")).unwrap());
    assert_eq!(fs::read_to_string(&snapshot).unwrap(), doc.content);
    assert_eq!(
        fs::metadata(&snapshot).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(snapshot.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert!(!root.path().join("injected").exists());
    request(
        state.clone(),
        "POST",
        &format!("/api/runs/{id}/cancel"),
        serde_json::json!({}),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if state.jobs.lock().unwrap()[0].status == "cancelled" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let descendant = fs::read_to_string(root.path().join("descendant-pid")).unwrap();
    // A killed child may briefly be a zombie awaiting init's reaper.
    if let Ok(stat) = fs::read_to_string(format!("/proc/{descendant}/stat")) {
        assert_eq!(stat.split(") ").nth(1).unwrap().chars().next(), Some('Z'));
    }
    assert!(!snapshot.exists());
    assert_eq!(
        fs::read_to_string(snapshot.parent().unwrap().join("status")).unwrap(),
        "130\n"
    );
}

pub(super) async fn wait_for_file(path: &FsPath) {
    tokio::time::timeout(Duration::from_secs(8), async {
        while !path.is_file() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn restart_recovers_running_and_disconnected_completed_runs_without_relaunch() {
    for cancel_run in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let runner = root.path().join("runner");
        fs::write(
            &runner,
            r#"#!/bin/bash
id=${2%/snapshot.md}
id=${id##*/run-}
# Both durable local records must precede the first actual launch.
[[ -s .spec-output/$id.json ]] || exit 91
[[ $(cat .spec-output/latest-*) == "$id" ]] || exit 92
printf 'launch\n' >> launches
cat "$2" > received
: > began
printf 'before disconnect\n'
while [[ ! -f resume ]]; do sleep 0.02; done
printf 'while detached\n' >&2
: > resumed
while [[ ! -f finish ]]; do sleep 0.02; done
printf 'after disconnect\n'
exit 7
"#,
        )
        .unwrap();
        fs::set_permissions(&runner, fs::Permissions::from_mode(0o700)).unwrap();
        let mut state = app(root.path());
        let remote = remote_fixture(root.path(), &runner);
        state.remote = Some(remote.clone());
        let doc = save(
            &state,
            "a.md",
            Save {
                content: "immutable snapshot".into(),
                revision: None,
            },
        )
        .ok()
        .unwrap();
        let response = request(
            state.clone(),
            "POST",
            "/api/runs",
            serde_json::json!({"name":"a.md", "revision":doc.revision}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let id = json(response).await["id"].as_str().unwrap().to_owned();
        wait_for_file(&root.path().join("began")).await;
        let directory = root.path().join(format!(".spec-runs/run-{id}"));
        let stored = root.path().join(format!(".spec-output/{id}.json"));
        assert!(directory.join("a.md.out").is_file());
        assert!(!directory.join("output.log").exists());
        for (path, mode) in [
            (root.path().join(".spec-output"), 0o700),
            (stored.clone(), 0o600),
        ] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                mode
            );
        }
        fs::write(root.path().join("a.md"), "edited after launch").unwrap();
        assert_eq!(
            fs::read_to_string(directory.join("snapshot.md")).unwrap(),
            doc.content
        );
        // Detach the old backend exactly as shutdown does, then discard its job map.
        state.jobs.lock().unwrap()[0]
            .stop
            .send(RunControl::Detach)
            .unwrap();
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let _guard = recovery::run_gate(&state, &id).await;
                if !state.jobs.lock().unwrap()[0].attached {
                    break;
                }
                drop(_guard);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        // Wait for the old task's final recovery write before simulating a new process.
        {
            let _guard = recovery::run_gate(&state, &id).await;
        }
        drop(state);
        // Produce fresh output with no backend attached, not just a cached checkpoint.
        fs::write(root.path().join("resume"), "").unwrap();
        wait_for_file(&root.path().join("resumed")).await;
        let mut fresh = app(root.path());
        fresh.remote = Some(remote.clone());
        if cancel_run {
            let recovered = json(
                request(
                    fresh.clone(),
                    "GET",
                    "/api/files/a.md/run",
                    serde_json::Value::Null,
                )
                .await,
            )
            .await;
            assert_eq!(recovered["id"], id);
            assert_eq!(recovered["status"], "running");
            assert_eq!(recovered["recoverable"], true);
            assert!(
                recovered["output"]
                    .as_str()
                    .unwrap()
                    .contains("before disconnect")
            );
            assert!(
                recovered["output"]
                    .as_str()
                    .unwrap()
                    .contains("while detached")
            );
            let revision = read(root.path(), "a.md").ok().unwrap().revision;
            assert_eq!(
                request(
                    fresh.clone(),
                    "POST",
                    "/api/runs",
                    serde_json::json!({"name":"a.md", "revision":revision})
                )
                .await
                .status(),
                StatusCode::CONFLICT
            );
            assert_eq!(
                request(
                    fresh.clone(),
                    "POST",
                    &format!("/api/runs/{id}/cancel"),
                    serde_json::json!({})
                )
                .await
                .status(),
                StatusCode::OK
            );
        } else {
            // The build completes while no backend is attached or polling it.
            fs::write(root.path().join("finish"), "").unwrap();
        }
        wait_for_file(&directory.join("status")).await;
        let response = request(
            fresh.clone(),
            "GET",
            &format!("/api/runs/{id}"),
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let recovered = json(response).await;
        assert_eq!(recovered["recoverable"], false);
        assert_eq!(
            recovered["status"],
            if cancel_run {
                "cancelled"
            } else {
                "failed (exit status: 7)"
            }
        );
        assert!(
            recovered["output"]
                .as_str()
                .unwrap()
                .contains("before disconnect")
        );
        if !cancel_run {
            assert!(
                recovered["output"]
                    .as_str()
                    .unwrap()
                    .contains("after disconnect")
            );
        }
        assert_eq!(
            fs::read_to_string(root.path().join("launches")).unwrap(),
            "launch\n"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("received")).unwrap(),
            doc.content
        );
        assert_eq!(
            fs::read_to_string(root.path().join("a.md")).unwrap(),
            "edited after launch"
        );
        assert!(!directory.join("snapshot.md").exists());
        // Terminal output survives another restart, even with SSH disabled and logs gone.
        fs::remove_dir_all(directory).unwrap();
        let offline = app(root.path());
        let latest = json(
            request(
                offline.clone(),
                "GET",
                "/api/files/a.md/run",
                serde_json::Value::Null,
            )
            .await,
        )
        .await;
        assert_eq!(latest, recovered);
        assert_eq!(
            json(
                request(
                    offline,
                    "GET",
                    &format!("/api/runs/{id}"),
                    serde_json::Value::Null
                )
                .await
            )
            .await,
            recovered
        );
    }
}

#[tokio::test]
async fn sixteen_runs_are_admitted_and_completion_frees_capacity() {
    let root = tempfile::tempdir().unwrap();
    let runner = root.path().join("runner");
    fs::write(
        &runner,
        "#!/bin/sh\nwhile [ ! -f ready ]; do sleep 0.02; done\n",
    )
    .unwrap();
    fs::set_permissions(&runner, fs::Permissions::from_mode(0o700)).unwrap();
    let mut state = app(root.path());
    state.remote = Some(remote_fixture(root.path(), &runner));
    // Restore unresolved records without launching processes or contacting SSH.
    for index in 0..15 {
        let mut job = persisted_job(&Uuid::new_v4().to_string(), "0".repeat(64), true);
        job.name = format!("pending-{index}.md");
        recovery::persist(&state, &job).ok().unwrap();
    }
    let mut documents = Vec::new();
    for name in ["a.md", "b.md"] {
        documents.push(
            save(
                &state,
                name,
                Save {
                    content: "fixture".into(),
                    revision: None,
                },
            )
            .ok()
            .unwrap(),
        );
    }
    let body = |index: usize| {
        serde_json::json!({
            "name": documents[index].name,
            "revision": documents[index].revision,
        })
    };
    let response = request(state.clone(), "POST", "/api/runs", body(0)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let id = json(response).await["id"].as_str().unwrap().to_owned();
    assert_eq!(
        state
            .jobs
            .lock()
            .unwrap()
            .iter()
            .filter(|job| job.recover)
            .count(),
        16
    );

    let duplicate = request(state.clone(), "POST", "/api/runs", body(0)).await;
    assert_eq!(duplicate.status(), StatusCode::CONFLICT);
    let error = json(duplicate).await["error"].as_str().unwrap().to_owned();
    assert!(error.contains("for this file"));
    assert!(error.contains(&id));
    assert!(!error.contains("limit"));

    let full = request(state.clone(), "POST", "/api/runs", body(1)).await;
    assert_eq!(full.status(), StatusCode::CONFLICT);
    assert!(
        json(full).await["error"]
            .as_str()
            .unwrap()
            .contains("16-run limit")
    );

    fs::write(root.path().join("ready"), "").unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if state
                .jobs
                .lock()
                .unwrap()
                .iter()
                .any(|job| job.id == id && !job.recover)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();

    let response = request(state.clone(), "POST", "/api/runs", body(1)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let id = json(response).await["id"].as_str().unwrap().to_owned();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if state
                .jobs
                .lock()
                .unwrap()
                .iter()
                .any(|job| job.id == id && !job.recover)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

fn persisted_job(id: &str, identity: String, recover: bool) -> Job {
    Job {
        id: id.into(),
        name: "a.md".into(),
        status: if recover { "running" } else { "completed" }.into(),
        output: VecDeque::from(b"saved output".to_vec()),
        truncated: false,
        remote_identity: identity,
        recover,
        repository_save: false,
        optimization: false,
        memory: None,
        stop: detached_control(),
        attached: false,
        dirty: false,
        persistence_error: None,
    }
}

#[tokio::test]
async fn latest_is_null_without_a_run_and_tracks_newest_while_old_ids_remain_readable() {
    let root = tempfile::tempdir().unwrap();
    let state = app(root.path());
    assert_eq!(
        json(
            request(
                state.clone(),
                "GET",
                "/api/files/a.md/run",
                serde_json::Value::Null
            )
            .await
        )
        .await,
        serde_json::Value::Null
    );
    let first = Uuid::new_v4().to_string();
    let second = Uuid::new_v4().to_string();
    for id in [&first, &second] {
        let job = persisted_job(id, "0".repeat(64), false);
        recovery::persist(&state, &job).ok().unwrap();
        recovery::set_latest(&state, &job).ok().unwrap();
    }
    let fresh = app(root.path());
    let latest = json(
        request(
            fresh.clone(),
            "GET",
            "/api/files/a.md/run",
            serde_json::Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(latest["id"], second);
    assert_eq!(latest["output"], "saved output");
    let old = json(
        request(
            fresh,
            "GET",
            &format!("/api/runs/{first}"),
            serde_json::Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(old["id"], first);
    assert_eq!(old["status"], "completed");
}

#[tokio::test]
async fn ssh_exit_255_remains_recoverable_until_nohup_confirms_completion() {
    let root = tempfile::tempdir().unwrap();
    let mut state = app(root.path());
    let remote = remote_fixture(root.path(), &root.path().join("unused"));
    fs::write(
        &remote.binary,
        "#!/bin/sh\nprintf 'ssh: connection closed by remote host\\n' >&2\nsleep 0.05\nexit 255\n",
    )
    .unwrap();
    state.remote = Some(remote.clone());
    fs::write(root.path().join("a.md"), "fixture").unwrap();
    let revision = read(root.path(), "a.md").ok().unwrap().revision;
    let response = request(
        state.clone(),
        "POST",
        "/api/runs",
        serde_json::json!({"name":"a.md", "revision":revision}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let id = json(response).await["id"].as_str().unwrap().to_owned();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if state
                .jobs
                .lock()
                .unwrap()
                .iter()
                .any(|job| job.id == id && !job.attached && job.status.starts_with("unavailable"))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let output = json(
        request(
            state.clone(),
            "GET",
            "/api/files/a.md/run/log",
            serde_json::Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(output["recoverable"], true);
    assert!(
        output["status"]
            .as_str()
            .unwrap()
            .contains("SSH log recovery exited with status 255")
    );
    let log = output["output"].as_str().unwrap();
    assert!(log.contains("ssh: connection closed by remote host"));
    assert!(log.contains("[detached (SSH exit status: 255; remote completion unconfirmed)]"));
    assert!(!log.contains("[failed (exit status: 255)]"));
    assert!(recovery::load(&state, &id).ok().unwrap().recover);

    fs::write(
        &remote.binary,
        "#!/bin/sh\nprintf 'SPEC-RUN-1 0 0\\nbuild completed while SSH was disconnected'\n",
    )
    .unwrap();
    let output = json(
        request(
            state.clone(),
            "GET",
            "/api/files/a.md/run/log",
            serde_json::Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(output["status"], "completed");
    assert_eq!(output["recoverable"], false);
    assert_eq!(
        output["output"],
        "build completed while SSH was disconnected"
    );
    assert!(!recovery::load(&state, &id).ok().unwrap().recover);
}

#[tokio::test]
async fn output_log_distinguishes_transport_255_from_authoritative_remote_255() {
    let root = tempfile::tempdir().unwrap();
    let mut state = app(root.path());
    let remote = remote_fixture(root.path(), &root.path().join("must-not-launch"));
    let id = Uuid::new_v4().to_string();
    let job = persisted_job(&id, remote.identity(), true);
    recovery::persist(&state, &job).ok().unwrap();
    recovery::set_latest(&state, &job).ok().unwrap();
    state.remote = Some(remote.clone());
    // Even a valid-looking header cannot override an unsuccessful SSH read.
    fs::write(&remote.binary, "#!/bin/sh\nprintf 'SPEC-RUN-1 0 0\\nuntrusted completion'\nprintf 'Permission denied (publickey)' >&2\nexit 255\n").unwrap();
    let output = json(
        request(
            state.clone(),
            "GET",
            "/api/files/a.md/run/log",
            serde_json::Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(output["output"], "saved output");
    assert_eq!(output["recoverable"], true);
    assert!(
        output["status"]
            .as_str()
            .unwrap()
            .starts_with("unavailable (SSH log recovery exited with status 255")
    );
    assert!(
        output["status"]
            .as_str()
            .unwrap()
            .contains("Permission denied (publickey)")
    );

    fs::write(
        &remote.binary,
        "#!/bin/sh\nprintf 'SPEC-RUN-1 255 0\\nremote command actually failed'\n",
    )
    .unwrap();
    let output = json(
        request(
            state.clone(),
            "GET",
            "/api/files/a.md/run/log",
            serde_json::Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(output["status"], "failed (exit status: 255)");
    assert_eq!(output["recoverable"], false);
    assert_eq!(output["output"], "remote command actually failed");
    assert!(!recovery::load(&state, &id).ok().unwrap().recover);
    assert!(!root.path().join("must-not-launch").exists());
}

#[tokio::test]
async fn terminal_log_read_resolves_admission_across_remote_failure_and_restart() {
    let root = tempfile::tempdir().unwrap();
    let mut state = app(root.path());
    let remote = remote_fixture(root.path(), &root.path().join("unused"));
    fs::write(
        &remote.binary,
        "#!/bin/sh\nprintf 'SPEC-RUN-1 0 0\\nverified remote output'\n",
    )
    .unwrap();
    let id = Uuid::new_v4().to_string();
    let job = persisted_job(&id, remote.identity(), true);
    state.remote = Some(remote.clone());
    recovery::persist(&state, &job).ok().unwrap();
    recovery::set_latest(&state, &job).ok().unwrap();

    let response = request(
        state.clone(),
        "GET",
        "/api/files/a.md/run/log",
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let output = json(response).await;
    assert_eq!(output["status"], "completed");
    assert_eq!(output["recoverable"], false);
    assert_eq!(output["output"], "verified remote output");
    assert!(
        !recovery::load(&state, &id).ok().unwrap().recover,
        "verified terminal log must resolve persisted admission state"
    );
    // The disk-view output must not replace the separately retained stream buffer.
    assert_eq!(recovery::load(&state, &id).ok().unwrap().output, job.output);
    fs::write(&remote.binary, "#!/bin/sh\nexit 99\n").unwrap();
    drop(state);
    let mut fresh = app(root.path());
    fresh.remote = Some(remote);
    assert_eq!(
        json(request(fresh.clone(), "GET", "/api/runs", serde_json::Value::Null).await).await,
        serde_json::json!([])
    );
    let output = json(
        request(
            fresh.clone(),
            "GET",
            &format!("/api/runs/{id}"),
            serde_json::Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(output["status"], "completed");
    assert_eq!(output["recoverable"], false);
    let response = request(
        fresh,
        "POST",
        "/api/optimize",
        serde_json::json!({"project":".","spec":null}),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "confirmed old completion must not require another successful SSH read"
    );
}

#[tokio::test]
async fn output_log_reads_disk_without_replacing_cached_or_attached_output() {
    let root = tempfile::tempdir().unwrap();
    let mut state = app(root.path());
    state.remote = Some(remote_fixture(
        root.path(),
        &root.path().join("must-not-launch"),
    ));
    let endpoint = "/api/files/a.md/run/log";
    assert_eq!(
        json(request(state.clone(), "GET", endpoint, serde_json::Value::Null).await).await,
        serde_json::Value::Null
    );
    let id = Uuid::new_v4().to_string();
    let job = persisted_job(&id, state.remote.as_ref().unwrap().identity(), false);
    recovery::persist(&state, &job).ok().unwrap();
    recovery::set_latest(&state, &job).ok().unwrap();
    let directory = root.path().join(format!(".spec-runs/run-{id}"));
    fs::create_dir_all(&directory).unwrap();
    for path in [directory.parent().unwrap(), directory.as_path()] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let log = directory.join("a.md.out");
    for (path, contents) in [
        (&log, "fresh disk output"),
        (&directory.join("status"), "0\n"),
    ] {
        fs::write(path, contents).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    for attached in [false, true] {
        let mut live_job = persisted_job(&id, job.remote_identity.clone(), attached);
        live_job.attached = attached;
        let control = live_job.stop.subscribe();
        state.jobs.lock().unwrap().clear();
        state.jobs.lock().unwrap().push(live_job);
        let response = request(state.clone(), "GET", endpoint, serde_json::Value::Null).await;
        assert_eq!(response.status(), StatusCode::OK);
        let output = json(response).await;
        assert_eq!(output["id"], id);
        assert_eq!(output["output"], "fresh disk output");
        assert_eq!(output["status"], "completed");
        assert_eq!(output["recoverable"], false);
        if attached {
            assert!(*control.borrow() == RunControl::Detach);
            assert!(state.jobs.lock().unwrap()[0].attached);
            let response = request(
                state.clone(),
                "POST",
                "/api/optimize",
                serde_json::json!({"project":".","spec":null}),
            )
            .await;
            assert_eq!(
                response.status(),
                StatusCode::CONFLICT,
                "wait for live local attachment teardown after remote completion"
            );
        }
        assert_eq!(state.jobs.lock().unwrap()[0].output, job.output);
        assert_eq!(recovery::load(&state, &id).ok().unwrap().output, job.output);
    }
    fs::write(&log, vec![b'x'; MAX_OUTPUT + 1]).unwrap();
    let output = json(request(state.clone(), "GET", endpoint, serde_json::Value::Null).await).await;
    assert_eq!(output["truncated"], true);
    assert_eq!(output["output"].as_str().unwrap().len(), MAX_OUTPUT);
    fs::remove_file(&log).unwrap();
    for linked in [false, true] {
        if linked {
            symlink(directory.join("status"), &log).unwrap();
        }
        let response = request(state.clone(), "GET", endpoint, serde_json::Value::Null).await;
        assert_eq!(response.status(), StatusCode::OK);
        let output = json(response).await;
        assert_eq!(output["output"], "saved output");
        assert!(
            output["status"]
                .as_str()
                .unwrap()
                .starts_with("unavailable")
        );
        assert_eq!(
            output["recoverable"], false,
            "missing logs must not undo previously verified completion"
        );
        assert_eq!(state.jobs.lock().unwrap()[0].output, job.output);
    }
}

#[tokio::test]
async fn terminal_log_read_survives_real_local_attachment_finalization() {
    let root = tempfile::tempdir().unwrap();
    let mut state = app(root.path());
    let remote = remote_fixture(root.path(), &root.path().join("unused"));
    // The attachment stays alive until Detach; independent status reads confirm
    // a terminal remote run. No real model, SSH daemon or build is invoked.
    fs::write(
        &remote.binary,
        r#"#!/bin/bash
if [[ ${!#} == *SPEC-RUN-1* ]]; then
    printf 'SPEC-RUN-1 0 0\nverified completion'
else
    printf 'attached stream\n'
    cat >/dev/null
    sleep 60
fi
"#,
    )
    .unwrap();
    state.remote = Some(remote.clone());
    fs::write(root.path().join("a.md"), "fixture").unwrap();
    let revision = read(root.path(), "a.md").ok().unwrap().revision;
    let response = request(
        state.clone(),
        "POST",
        "/api/runs",
        serde_json::json!({"name":"a.md", "revision":revision}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let id = json(response).await["id"].as_str().unwrap().to_owned();
    let response = request(
        state.clone(),
        "GET",
        "/api/files/a.md/run/log",
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json(response).await["status"], "completed");
    fs::write(&remote.binary, "#!/bin/sh\nexit 99\n").unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !state
                .jobs
                .lock()
                .unwrap()
                .iter()
                .find(|job| job.id == id)
                .unwrap()
                .attached
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let job = recovery::load(&state, &id).ok().unwrap();
    assert!(!job.recover);
    assert_eq!(
        job.status, "completed",
        "local Detach must not overwrite remote terminal evidence"
    );
    assert_eq!(
        json(request(state, "GET", "/api/runs", serde_json::Value::Null).await).await,
        serde_json::json!([])
    );
}

#[tokio::test]
async fn terminal_log_read_persistence_failure_does_not_clear_pending_state() {
    let root = tempfile::tempdir().unwrap();
    let mut state = app(root.path());
    let remote = remote_fixture(root.path(), &root.path().join("unused"));
    let id = Uuid::new_v4().to_string();
    let job = persisted_job(&id, remote.identity(), true);
    recovery::persist(&state, &job).ok().unwrap();
    recovery::set_latest(&state, &job).ok().unwrap();
    fs::write(
        &remote.binary,
        format!(
            "#!/bin/sh\nchmod 755 '{}'\nprintf 'SPEC-RUN-1 0 0\\nverified completion'\n",
            root.path().join(".spec-output").display()
        ),
    )
    .unwrap();
    state.remote = Some(remote);
    let response = request(
        state.clone(),
        "GET",
        "/api/files/a.md/run/log",
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(state.jobs.lock().unwrap()[0].recover);
    fs::set_permissions(
        root.path().join(".spec-output"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    assert!(recovery::load(&state, &id).ok().unwrap().recover);
}

#[tokio::test]
async fn cancel_closed_attachment_uses_remote_control_and_reports_failure() {
    for unknown in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let mut state = app(root.path());
        let remote = remote_fixture(root.path(), &root.path().join("unused"));
        fs::write(&remote.binary, if unknown { "#!/bin/sh\nexit 125\n" } else { "#!/bin/bash\n[[ ${!#} == *\" cancel '\"* ]] || exit 99\nprintf 'SPEC-RUN-1 130 0\\ncancelled remotely'\n" }).unwrap();
        let id = Uuid::new_v4().to_string();
        let mut job = persisted_job(&id, remote.identity(), true);
        job.attached = true;
        assert!(job.stop.is_closed());
        recovery::persist(&state, &job).ok().unwrap();
        state.jobs.lock().unwrap().push(job);
        state.remote = Some(remote);
        let response = request(
            state.clone(),
            "POST",
            &format!("/api/runs/{id}/cancel"),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(
            response.status(),
            if unknown {
                StatusCode::BAD_GATEWAY
            } else {
                StatusCode::OK
            }
        );
        let jobs = state.jobs.lock().unwrap();
        assert!(!jobs[0].attached);
        assert_eq!(jobs[0].recover, unknown);
        if !unknown {
            assert_eq!(jobs[0].status, "cancelled");
        }
    }
}

#[tokio::test]
async fn output_log_missing_run_preserves_cached_output_and_unresolved_status() {
    let root = tempfile::tempdir().unwrap();
    let mut state = app(root.path());
    state.remote = Some(remote_fixture(
        root.path(),
        &root.path().join("must-not-launch"),
    ));
    let id = Uuid::new_v4().to_string();
    let job = persisted_job(&id, state.remote.as_ref().unwrap().identity(), true);
    recovery::persist(&state, &job).ok().unwrap();
    recovery::set_latest(&state, &job).ok().unwrap();
    let parent = root.path().join(".spec-runs");
    fs::create_dir(&parent).unwrap();
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
    for attached in [false, true] {
        let _control;
        if attached {
            let mut live = persisted_job(&id, job.remote_identity.clone(), true);
            live.attached = true;
            _control = live.stop.subscribe();
            live.output = b"newer attached output".to_vec().into();
            live.truncated = true;
            state.jobs.lock().unwrap().clear();
            state.jobs.lock().unwrap().push(live);
        }
        for _ in 0..2 {
            let response = request(
                state.clone(),
                "GET",
                "/api/files/a.md/run/log",
                serde_json::Value::Null,
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            let output = json(response).await;
            assert_eq!(output["id"], id);
            assert_eq!(
                output["output"],
                if attached {
                    "newer attached output"
                } else {
                    "saved output"
                }
            );
            assert_eq!(output["truncated"], attached);
            assert_eq!(output["recoverable"], true);
            assert!(
                output["status"]
                    .as_str()
                    .unwrap()
                    .contains("remote run directory missing")
            );
            assert!(output["status"].as_str().unwrap().contains(&id));
            assert_eq!(recovery::load(&state, &id).ok().unwrap().output, job.output);
        }
    }
    assert!(!parent.join(format!("run-{id}")).exists());
    assert!(!root.path().join("must-not-launch").exists());
    assert_eq!(state.jobs.lock().unwrap()[0].status, "running");
}

#[tokio::test]
async fn changed_remote_identity_never_contacts_ssh_or_loses_cached_output() {
    let root = tempfile::tempdir().unwrap();
    let mut state = app(root.path());
    let remote = remote_fixture(root.path(), &root.path().join("unused"));
    let id = Uuid::new_v4().to_string();
    let job = persisted_job(&id, remote.identity(), true);
    recovery::persist(&state, &job).ok().unwrap();
    recovery::set_latest(&state, &job).ok().unwrap();
    fs::write(
        &remote.binary,
        format!(
            "#!/bin/bash\ntouch '{}/contacted'\nexit 99\n",
            root.path().display()
        ),
    )
    .unwrap();
    for field in ["target", "directory", "key", "binary", "disabled"] {
        let mut changed = remote.clone();
        match field {
            "target" => changed.target = "other@host".into(),
            "directory" => changed.directory.push_str("/other"),
            "key" => changed.key = Some("/different/key".into()),
            "binary" => changed.binary = root.path().join("different-ssh"),
            _ => {}
        }
        state = app(root.path());
        state.remote = if field == "disabled" {
            None
        } else {
            Some(changed)
        };
        let out = json(
            request(
                state.clone(),
                "GET",
                "/api/files/a.md/run",
                serde_json::Value::Null,
            )
            .await,
        )
        .await;
        assert!(
            out["status"]
                .as_str()
                .unwrap()
                .contains("configuration does not match")
        );
        assert_eq!(out["output"], "saved output");
        assert_eq!(
            request(
                state.clone(),
                "GET",
                "/api/files/a.md/run/log",
                serde_json::Value::Null
            )
            .await
            .status(),
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(
            request(
                state.clone(),
                "POST",
                &format!("/api/runs/{id}/cancel"),
                serde_json::json!({})
            )
            .await
            .status(),
            StatusCode::BAD_GATEWAY
        );
        assert!(!root.path().join("contacted").exists());
    }
}

#[tokio::test]
async fn local_run_storage_rejects_unsafe_paths_permissions_and_oversized_records() {
    for kind in [
        "directory-symlink",
        "directory-mode",
        "record-symlink",
        "record-mode",
        "record-fifo",
        "record-hardlink",
        "record-large",
        "record-corrupt",
        "pointer-symlink",
        "missing-record",
    ] {
        let root = tempfile::tempdir().unwrap();
        let state = app(root.path());
        let id = Uuid::new_v4().to_string();
        let job = persisted_job(&id, "0".repeat(64), false);
        recovery::persist(&state, &job).ok().unwrap();
        recovery::set_latest(&state, &job).ok().unwrap();
        let directory = root.path().join(".spec-output");
        let record = directory.join(format!("{id}.json"));
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::write(outside.path(), "untouched").unwrap();
        match kind {
            "directory-symlink" => {
                fs::rename(&directory, root.path().join("elsewhere")).unwrap();
                symlink(root.path().join("elsewhere"), &directory).unwrap();
            }
            "directory-mode" => {
                fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap()
            }
            "record-mode" => {
                fs::set_permissions(&record, fs::Permissions::from_mode(0o644)).unwrap()
            }
            "record-large" => File::options()
                .write(true)
                .open(&record)
                .unwrap()
                .set_len((MAX_OUTPUT * 8) as u64)
                .unwrap(),
            "record-corrupt" => fs::write(&record, "{").unwrap(),
            "pointer-symlink" => {
                let pointer = directory.join(format!("latest-{:x}", Sha256::digest(b"a.md")));
                fs::remove_file(&pointer).unwrap();
                symlink(outside.path(), pointer).unwrap();
            }
            _ => {
                fs::remove_file(&record).unwrap();
                match kind {
                    "record-symlink" => symlink(outside.path(), &record).unwrap(),
                    "record-hardlink" => fs::hard_link(outside.path(), &record).unwrap(),
                    "record-fifo" => {
                        nix::unistd::mkfifo(&record, nix::sys::stat::Mode::S_IRUSR).unwrap()
                    }
                    _ => {}
                }
            }
        }
        let response = request(
            app(root.path()),
            "GET",
            "/api/files/a.md/run",
            serde_json::Value::Null,
        )
        .await;
        assert_ne!(response.status(), StatusCode::OK, "{kind}");
        if kind != "missing-record" && kind != "pointer-symlink" {
            assert!(
                recovery::persist(&state, &job).is_err()
                    || ["record-large", "record-corrupt"].contains(&kind),
                "{kind}"
            );
        }
        assert_eq!(fs::read_to_string(outside.path()).unwrap(), "untouched");
    }
}

#[tokio::test]
async fn checkpoint_failures_are_visible_and_retryable_and_output_is_bounded() {
    let root = tempfile::tempdir().unwrap();
    let state = app(root.path());
    let id = Uuid::new_v4().to_string();
    let job = persisted_job(&id, "0".repeat(64), false);
    recovery::persist(&state, &job).ok().unwrap();
    recovery::set_latest(&state, &job).ok().unwrap();
    state.jobs.lock().unwrap().push(job);
    append(&state, &id, &vec![b'x'; MAX_OUTPUT + 100]);
    append(&state, &id, b"last");
    let directory = root.path().join(".spec-output");
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
    recovery::checkpoint(&state, &id);
    assert!(state.jobs.lock().unwrap()[0].persistence_error.is_some());
    assert_eq!(
        request(
            state.clone(),
            "GET",
            &format!("/api/runs/{id}"),
            serde_json::Value::Null
        )
        .await
        .status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        request(
            state,
            "GET",
            &format!("/api/runs/{id}"),
            serde_json::Value::Null
        )
        .await
        .status(),
        StatusCode::OK
    );
    let recovered = json(
        request(
            app(root.path()),
            "GET",
            "/api/files/a.md/run",
            serde_json::Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(recovered["output"].as_str().unwrap().len(), MAX_OUTPUT);
    assert!(recovered["output"].as_str().unwrap().ends_with("last"));
    assert_eq!(recovered["truncated"], true);
}

#[tokio::test]
async fn storage_failure_prevents_ssh_spawn_and_does_not_modify_spec() {
    let root = tempfile::tempdir().unwrap();
    let mut state = app(root.path());
    let remote = remote_fixture(root.path(), &root.path().join("unused"));
    fs::write(
        &remote.binary,
        format!("#!/bin/bash\ntouch '{}/spawned'\n", root.path().display()),
    )
    .unwrap();
    state.remote = Some(remote);
    let doc = save(
        &state,
        "a.md",
        Save {
            content: "unchanged input".into(),
            revision: None,
        },
    )
    .ok()
    .unwrap();
    let storage = root.path().join(".spec-output");
    fs::create_dir(&storage).unwrap();
    fs::set_permissions(&storage, fs::Permissions::from_mode(0o755)).unwrap();
    let response = request(
        state.clone(),
        "POST",
        "/api/runs",
        serde_json::json!({"name":"a.md", "revision":doc.revision}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(!root.path().join("spawned").exists());
    assert!(state.jobs.lock().unwrap().is_empty());
    assert_eq!(
        fs::read_to_string(root.path().join("a.md")).unwrap(),
        doc.content
    );
    assert_eq!(
        fs::metadata(storage).unwrap().permissions().mode() & 0o777,
        0o755
    );
}
