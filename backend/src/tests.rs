use super::*;
use axum::body::Body;
use http_body_util::BodyExt;
use std::os::unix::fs::symlink;
use tower::ServiceExt;

pub(super) fn app(root: &FsPath) -> App {
    App {
        root: root.to_owned(),
        token: "test-token".into(),
        remote: None,
        completion: None,
        files: Arc::new(Mutex::new(())),
        jobs: Arc::new(Mutex::new(Vec::new())),
        recovered: Arc::new(Mutex::new(false)),
        recovery_gate: Arc::new(tokio::sync::Mutex::new(())),
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
        ("PUT", "/api/files/a.md"),
        ("GET", "/api/config"),
        ("POST", "/api/completions"),
        ("POST", "/api/runs"),
        ("GET", "/api/runs/id"),
        ("POST", "/api/runs/id/cancel"),
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
                let _guard = state.recovery_gate.lock().await;
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
            let _guard = state.recovery_gate.lock().await;
        }
        drop(state);
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

fn persisted_job(id: &str, identity: String, recover: bool) -> Job {
    Job {
        id: id.into(),
        name: "a.md".into(),
        status: if recover { "running" } else { "completed" }.into(),
        output: VecDeque::from(b"saved output".to_vec()),
        truncated: false,
        remote_identity: identity,
        recover,
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
