use super::*;
use crate::tests::{app, json, remote_fixture, request};
use serde_json::json;

fn fixture(root: &FsPath, argv: Vec<String>) -> App {
    let editor = root.join("editor");
    fs::create_dir(&editor).unwrap();
    fs::set_permissions(&editor, fs::Permissions::from_mode(0o700)).unwrap();
    let mut state = app(&editor);
    state.remote = Some(remote_fixture(root, FsPath::new("/bin/false")));
    let config = Config {
        local: root.join("local ' $(false).txt"),
        remote: root.join("remote ' $(false).txt").to_str().unwrap().into(),
        argv,
    };
    config.validate(state.remote.as_ref()).ok().unwrap();
    state.computeruse = Arc::new(Bridge::new(Some(config)));
    state
}

fn command() -> Vec<String> {
    vec!["/usr/bin/cat".into(), "{instructions}".into()]
}

fn document(state: &App, name: &str, content: &str) -> Document {
    save(
        state,
        name,
        Save {
            content: content.into(),
            revision: None,
        },
    )
    .ok()
    .unwrap()
}

async fn call(
    state: &App,
    method: &str,
    route: &str,
    body: serde_json::Value,
    expected: StatusCode,
) -> serde_json::Value {
    let response = request(state.clone(), method, route, body).await;
    let status = response.status();
    let value = json(response).await;
    assert_eq!(status, expected, "{value}");
    value
}

async fn finished(state: &App) -> serde_json::Value {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let value = call(
                state,
                "GET",
                "/api/computeruse",
                json!(null),
                StatusCode::OK,
            )
            .await;
            if value["run"]["status"] != "running" {
                return value["run"].clone();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn computeruse_push_pull_exact_text_cas_and_no_callback() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(
        root.path(),
        vec![
            "/usr/bin/touch".into(),
            root.path().join("launched").to_str().unwrap().into(),
            "{instructions}".into(),
        ],
    );
    let name = "a ' $(touch NOT_EXECUTED); &.md";
    let content = "  exact\r\n$(touch NOT_EXECUTED)\n`false` ' \" \\ \t\n\n";
    let doc = document(&state, name, content);
    let missing = call(
        &state,
        "GET",
        "/api/computeruse/file",
        json!(null),
        StatusCode::OK,
    )
    .await;
    assert_eq!(missing, json!({"content":"", "revision":null}));
    call(
        &state,
        "POST",
        "/api/computeruse/pull",
        json!({"name":"new.md", "revision":null}),
        StatusCode::NOT_FOUND,
    )
    .await;
    let pushed = call(
        &state,
        "POST",
        "/api/computeruse/push",
        json!({"name":name,"revision":doc.revision,"remote_revision":null}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(pushed, json!({"content":content,"revision":doc.revision}));
    let config = state.computeruse.config.as_ref().unwrap();
    assert_eq!(fs::read_to_string(&config.local).unwrap(), content);
    assert_eq!(fs::read_to_string(&config.remote).unwrap(), content);
    call(
        &state,
        "POST",
        "/api/computeruse/run",
        json!({"name":name,"revision":"stale","remote_revision":doc.revision}),
        StatusCode::CONFLICT,
    )
    .await;
    call(
        &state,
        "POST",
        "/api/computeruse/run",
        json!({"name":name,"revision":doc.revision,"remote_revision":null}),
        StatusCode::CONFLICT,
    )
    .await;
    assert!(!root.path().join("launched").exists());
    assert!(state.computeruse.current.lock().unwrap().is_none());
    let remote_content = "new remote\r\n\ntext";
    fs::write(&config.remote, remote_content).unwrap();
    call(
        &state,
        "POST",
        "/api/computeruse/pull",
        json!({"name":name,"revision":null}),
        StatusCode::CONFLICT,
    )
    .await;
    assert_eq!(fs::read_to_string(&config.local).unwrap(), content);
    let pulled = call(
        &state,
        "POST",
        "/api/computeruse/pull",
        json!({"name":name,"revision":doc.revision}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(
        pulled,
        json!({"name":name,"content":remote_content,"revision":digest(remote_content)})
    );
    assert_eq!(
        read(&state.root, name).ok().unwrap().content,
        remote_content
    );
    assert_eq!(fs::read_to_string(&config.local).unwrap(), remote_content);
    assert!(!root.path().join("launched").exists());
    assert!(state.jobs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn computeruse_run_frozen_snapshot_duplicate_admission_and_completion() {
    let root = tempfile::tempdir().unwrap();
    let runner = root.path().join("runner");
    fs::write(&runner, "#!/usr/bin/python3\nimport pathlib, sys, time\np = pathlib.Path(sys.argv[1])\nwith (p.parent.parent / 'launches').open('a') as f: f.write('1')\nassert p.stat().st_mode & 0o777 == 0o400\nassert p.parent.stat().st_mode & 0o777 == 0o700\nprint(str(p), flush=True)\ntime.sleep(.5)\nsys.stdout.buffer.write(p.read_bytes())\nsys.stdout.buffer.flush()\n").unwrap();
    fs::set_permissions(&runner, fs::Permissions::from_mode(0o700)).unwrap();
    let state = fixture(
        root.path(),
        vec![runner.to_str().unwrap().into(), "{instructions}".into()],
    );
    let doc = document(&state, "a.md", "frozen\r\n");
    let body = json!({"name":doc.name,"revision":doc.revision,"remote_revision":null});
    let result = call(
        &state,
        "POST",
        "/api/computeruse/run",
        body.clone(),
        StatusCode::OK,
    )
    .await;
    assert_eq!(result["run"]["status"], "running");
    call(
        &state,
        "POST",
        "/api/computeruse/run",
        body,
        StatusCode::CONFLICT,
    )
    .await;
    save(
        &state,
        "a.md",
        Save {
            content: "later editor".into(),
            revision: Some(doc.revision.clone()),
        },
    )
    .ok()
    .unwrap();
    let config = state.computeruse.config.as_ref().unwrap();
    fs::write(&config.local, "later mirror").unwrap();
    fs::write(&config.remote, "later remote").unwrap();
    let run = finished(&state).await;
    assert_eq!(run["id"], result["run"]["id"]);
    assert_eq!(run["status"], "completed");
    let output = run["output"].as_str().unwrap();
    assert!(output.ends_with("frozen\r\n"), "{output}");
    assert_eq!(
        fs::read_to_string(state.root.join("launches")).unwrap(),
        "1"
    );
    assert!(!FsPath::new(output.lines().next().unwrap()).exists());
    assert!(state.jobs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn computeruse_cancellation_descendants_output_and_shutdown() {
    let root = tempfile::tempdir().unwrap();
    let runner = root.path().join("runner");
    fs::write(&runner, "#!/usr/bin/python3\nimport os, signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nprint('x' * 400000, flush=True)\nif os.fork() == 0:\n print('descendant=' + str(os.getpid()), flush=True)\n time.sleep(60)\nelse:\n print('leader=' + str(os.getpid()), flush=True)\n time.sleep(60)\n").unwrap();
    fs::set_permissions(&runner, fs::Permissions::from_mode(0o700)).unwrap();
    let state = fixture(
        root.path(),
        vec![runner.to_str().unwrap().into(), "{instructions}".into()],
    );
    let doc = document(&state, "a.md", "test");
    for shutdown in [false, true] {
        let revision = if shutdown {
            Some(doc.revision.clone())
        } else {
            None
        };
        let result = call(
            &state,
            "POST",
            "/api/computeruse/run",
            json!({"name":doc.name,"revision":doc.revision,"remote_revision":revision}),
            StatusCode::OK,
        )
        .await;
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let ready = {
                    let current = state.computeruse.current.lock().unwrap();
                    let output = &current.as_ref().unwrap().view.output;
                    output.contains("leader=") && output.contains("descendant=")
                };
                if ready {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        if shutdown {
            detach_and_wait(&state).await;
        } else {
            call(
                &state,
                "POST",
                &format!(
                    "/api/computeruse/runs/{}/cancel",
                    result["run"]["id"].as_str().unwrap()
                ),
                json!({}),
                StatusCode::OK,
            )
            .await;
        }
        let view = finished(&state).await;
        assert_eq!(view["status"], "cancelled");
        assert_eq!(view["truncated"], true);
        assert!(view["output"].as_str().unwrap().len() <= MAX_OUTPUT);
        for line in view["output"]
            .as_str()
            .unwrap()
            .lines()
            .filter(|line| line.starts_with("leader=") || line.starts_with("descendant="))
        {
            let pid = line.split('=').nth(1).unwrap();
            // An orphan can briefly remain as a zombie until the container's init reaps it.
            if let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) {
                assert_eq!(stat.split_whitespace().nth(2), Some("Z"), "{stat}");
            }
        }
    }
    call(
        &state,
        "POST",
        "/api/computeruse/run",
        json!({"name":doc.name,"revision":doc.revision,"remote_revision":doc.revision}),
        StatusCode::SERVICE_UNAVAILABLE,
    )
    .await;
}

#[tokio::test]
async fn computeruse_disabled_and_unsafe_local_or_remote_files() {
    let root = tempfile::tempdir().unwrap();
    let disabled = app(root.path());
    assert_eq!(
        call(
            &disabled,
            "GET",
            "/api/computeruse",
            json!(null),
            StatusCode::OK
        )
        .await,
        json!({"configured":false,"local_path":null,"remote_path":null,"run":null})
    );
    for path in [
        "/api/computeruse/push",
        "/api/computeruse/run",
        "/api/computeruse/pull",
    ] {
        call(
            &disabled,
            "POST",
            path,
            json!({"name":"a.md","revision":"test"}),
            StatusCode::SERVICE_UNAVAILABLE,
        )
        .await;
    }
    let state = fixture(root.path(), command());
    let doc = document(&state, "a.md", "safe");
    let config = state.computeruse.config.as_ref().unwrap();
    let outside = root.path().join("outside");
    fs::write(&outside, "never overwrite").unwrap();
    for path in [&config.local, &PathBuf::from(&config.remote)] {
        std::os::unix::fs::symlink(&outside, path).unwrap();
        call(
            &state,
            "POST",
            "/api/computeruse/run",
            json!({"name":doc.name,"revision":doc.revision,"remote_revision":null}),
            StatusCode::BAD_REQUEST,
        )
        .await;
        fs::remove_file(path).unwrap();
    }
    assert_eq!(fs::read_to_string(outside).unwrap(), "never overwrite");
    assert!(state.computeruse.current.lock().unwrap().is_none());
}

#[test]
fn computeruse_config_and_parent_validation() {
    let root = tempfile::tempdir().unwrap();
    let remote = remote_fixture(root.path(), FsPath::new("/bin/false"));
    let config = Config {
        local: root.path().join("shared"),
        remote: "/safe/shared".into(),
        argv: command(),
    };
    assert!(config.validate(Some(&remote)).is_ok());
    assert!(config.validate(None).is_err());
    for argv in [
        vec![],
        vec!["cat", "{instructions}"],
        vec!["/usr/bin/cat"],
        vec!["/usr/bin/cat", "--file={instructions}"],
        vec!["/usr/bin/cat", "{instructions}", "{instructions}"],
    ] {
        let mut bad = config.clone();
        bad.argv = argv.into_iter().map(str::to_owned).collect();
        assert!(bad.validate(Some(&remote)).is_err());
    }
    let unsafe_dir = root.path().join("unsafe");
    fs::create_dir(&unsafe_dir).unwrap();
    fs::set_permissions(&unsafe_dir, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(LocalFile::open(&unsafe_dir.join("file")).is_err());
    let link = root.path().join("link");
    std::os::unix::fs::symlink(root.path(), &link).unwrap();
    assert!(LocalFile::open(&link.join("file")).is_err());
    assert!(path_parts(FsPath::new("/tmp/../file")).is_err());
}

#[tokio::test]
async fn computeruse_remote_errors_are_bounded_and_never_launch_or_change_mirror() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path(), command());
    let doc = document(&state, "a.md", "saved");
    let config = state.computeruse.config.as_ref().unwrap();
    fs::write(&config.local, "keep mirror").unwrap();
    for script in [
        "#!/usr/bin/python3\nimport sys\nsys.stderr.write('x' * 20000)\nsys.stderr.flush()\nimport time; time.sleep(60)\n",
        "#!/usr/bin/python3\nimport sys\nsys.stdout.write('x' * (13 * 1024 * 1024))\nsys.stdout.flush()\nimport time; time.sleep(60)\n",
        "#!/usr/bin/python3\nprint('not JSON')\n",
        "#!/usr/bin/python3\nprint('{\"content\":\"bad hash\",\"revision\":\"wrong\"}')\n",
        "#!/usr/bin/python3\nimport json, hashlib\nprint(json.dumps({'content':'different', 'revision': hashlib.sha256(b'different').hexdigest()}))\n",
        "#!/usr/bin/python3\nraise SystemExit(1)\n",
    ] {
        fs::write(&state.remote.as_ref().unwrap().binary, script).unwrap();
        tokio::time::timeout(
            Duration::from_secs(5),
            call(
                &state,
                "POST",
                "/api/computeruse/run",
                json!({"name":doc.name,"revision":doc.revision,"remote_revision":null}),
                StatusCode::BAD_GATEWAY,
            ),
        )
        .await
        .unwrap();
        assert!(state.computeruse.current.lock().unwrap().is_none());
        assert_eq!(fs::read_to_string(&config.local).unwrap(), "keep mirror");
        assert!(!fs::read_dir(&state.root).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".computeruse-")
        }));
    }
}

#[tokio::test]
async fn computeruse_inflight_sync_rejects_duplicates_without_blocking_editor_save() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path(), command());
    let doc = document(&state, "a.md", "saved");
    let binary = &state.remote.as_ref().unwrap().binary;
    let original = fs::read_to_string(binary).unwrap();
    let transferring = root.path().join("transferring");
    fs::write(
        binary,
        original.replace(
            "exec /bin/bash",
            &format!(
                "touch '{}'\nsleep 0.3\nexec /bin/bash",
                transferring.display()
            ),
        ),
    )
    .unwrap();
    let body = json!({"name":doc.name,"revision":doc.revision,"remote_revision":null});
    let worker = tokio::spawn(request(
        state.clone(),
        "POST",
        "/api/computeruse/push",
        body.clone(),
    ));
    loop {
        if transferring.exists() {
            break;
        }
        tokio::task::yield_now().await;
    }
    call(
        &state,
        "POST",
        "/api/computeruse/run",
        body,
        StatusCode::CONFLICT,
    )
    .await;
    call(
        &state,
        "PUT",
        "/api/files/a.md",
        json!({"content":"later", "revision":doc.revision}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(worker.await.unwrap().status(), StatusCode::OK);
    assert_eq!(read(&state.root, "a.md").ok().unwrap().content, "later");
}

#[tokio::test]
async fn computeruse_failed_local_child_reports_failure_without_queueing() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(
        root.path(),
        vec!["/usr/bin/false".into(), "{instructions}".into()],
    );
    let doc = document(&state, "a.md", "test");
    call(
        &state,
        "POST",
        "/api/computeruse/run",
        json!({"name":doc.name,"revision":doc.revision,"remote_revision":null}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(finished(&state).await["status"], "failed");
    assert!(state.jobs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn computeruse_transfer_timeout_never_launches() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path(), command());
    let doc = document(&state, "a.md", "saved");
    fs::write(
        &state.remote.as_ref().unwrap().binary,
        "#!/usr/bin/python3\nimport time\ntime.sleep(60)\n",
    )
    .unwrap();
    tokio::time::timeout(
        Duration::from_secs(35),
        call(
            &state,
            "POST",
            "/api/computeruse/run",
            json!({"name":doc.name,"revision":doc.revision,"remote_revision":null}),
            StatusCode::GATEWAY_TIMEOUT,
        ),
    )
    .await
    .unwrap();
    assert!(state.computeruse.current.lock().unwrap().is_none());
    assert!(!state.computeruse.config.as_ref().unwrap().local.exists());
}

#[tokio::test]
async fn computeruse_local_mirror_cas_and_pull_new_editor() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path(), command());
    let config = state.computeruse.config.as_ref().unwrap();
    let local = LocalFile::open(&config.local).ok().unwrap();
    let prepared = local.prepare("new").ok().unwrap();
    fs::write(&config.local, "external edit").unwrap();
    assert!(matches!(
        local.commit(prepared, &mut false),
        Err(Error(StatusCode::CONFLICT, _))
    ));
    assert_eq!(fs::read_to_string(&config.local).unwrap(), "external edit");
    fs::write(&config.remote, "new editor\r\n").unwrap();
    let pulled = call(
        &state,
        "POST",
        "/api/computeruse/pull",
        json!({"name":"new.md","revision":null}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(
        pulled,
        json!({"name":"new.md","content":"new editor\r\n","revision":digest("new editor\r\n")})
    );
    assert_eq!(
        read(&state.root, "new.md").ok().unwrap().content,
        "new editor\r\n"
    );
    assert!(state.computeruse.current.lock().unwrap().is_none());
}

#[tokio::test]
async fn computeruse_push_reports_partial_and_uncertain_remote_writes() {
    for fault in ["mirror-conflict", "mirror-unsafe", "lost-ack"] {
        let root = tempfile::tempdir().unwrap();
        let state = fixture(root.path(), command());
        let doc = document(&state, "a.md", "saved exact\r\n");
        let config = state.computeruse.config.as_ref().unwrap();
        fs::write(&config.local, "old mirror").unwrap();
        let outside = root.path().join("outside");
        fs::write(&outside, "outside").unwrap();
        // Run the actual remote helper locally, then fault the next stage or lose its ack.
        fs::write(&state.remote.as_ref().unwrap().binary, format!(r#"#!/usr/bin/python3
import pathlib, subprocess, sys
result = subprocess.run(['/bin/bash', '-c', sys.argv[-1]], stdin=sys.stdin.buffer, capture_output=True)
assert result.returncode == 0
local = pathlib.Path({local})
fault = {fault}
if fault == 'mirror-conflict':
    local.write_text('external edit')
elif fault == 'mirror-unsafe':
    local.unlink()
    local.symlink_to({outside})
else:
    raise SystemExit(1)
sys.stdout.buffer.write(result.stdout)
"#, local=json!(config.local), fault=json!(fault), outside=json!(outside))).unwrap();
        let response = call(
            &state,
            "POST",
            "/api/computeruse/run",
            json!({"name":doc.name,"revision":doc.revision,"remote_revision":null}),
            match fault {
                "mirror-conflict" => StatusCode::CONFLICT,
                "mirror-unsafe" => StatusCode::BAD_REQUEST,
                _ => StatusCode::BAD_GATEWAY,
            },
        )
        .await;
        let error = response["error"].as_str().unwrap();
        assert!(error.contains("Synchronization incomplete"), "{error}");
        assert!(
            error.contains(if fault == "lost-ack" {
                "remote write was not confirmed and the remote file may have changed"
            } else {
                "remote file updated; local mirror not replaced by this operation"
            }),
            "{error}"
        );
        assert!(error.contains("No callback executed"), "{error}");
        assert!(error.contains("GET /api/computeruse/file"), "{error}");
        assert!(error.contains("reload the editor"), "{error}");
        assert_eq!(fs::read_to_string(&config.remote).unwrap(), doc.content);
        assert_eq!(read(&state.root, "a.md").ok().unwrap().content, doc.content);
        assert_eq!(
            fs::read_to_string(&config.local).unwrap(),
            match fault {
                "mirror-conflict" => "external edit",
                "mirror-unsafe" => "outside",
                _ => "old mirror",
            }
        );
        assert!(state.computeruse.current.lock().unwrap().is_none());
    }
}

#[tokio::test]
async fn computeruse_pull_reports_mirror_updated_when_editor_replace_fails() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path(), command());
    let doc = document(&state, "a.md", "original editor");
    let config = state.computeruse.config.as_ref().unwrap();
    fs::write(&config.remote, "remote text\r\n").unwrap();
    fs::write(&config.local, "old mirror").unwrap();
    let editor = state.root.join("a.md");
    let backup = state.root.join("backup.md");
    *state.computeruse.after_mirror.lock().unwrap() = Some(Box::new(move || {
        fs::rename(&editor, &backup).unwrap();
        fs::create_dir(editor).unwrap();
    }));
    let response = call(
        &state,
        "POST",
        "/api/computeruse/pull",
        json!({"name":doc.name,"revision":doc.revision}),
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
    let error = response["error"].as_str().unwrap();
    assert!(error.contains("remote file not modified by pull; local mirror updated; editor not replaced by this operation"), "{error}");
    assert!(error.contains("No callback executed"), "{error}");
    assert!(error.contains("GET /api/computeruse/file"), "{error}");
    assert!(error.contains("reload the editor"), "{error}");
    assert_eq!(
        fs::read_to_string(&config.local).unwrap(),
        "remote text\r\n"
    );
    assert_eq!(
        fs::read_to_string(&config.remote).unwrap(),
        "remote text\r\n"
    );
    assert_eq!(
        fs::read_to_string(state.root.join("backup.md")).unwrap(),
        doc.content
    );
    assert!(state.computeruse.current.lock().unwrap().is_none());
}

#[tokio::test]
async fn computeruse_capture_preserves_split_utf8_and_flushes_invalid_eof() {
    struct Chunks(VecDeque<Vec<u8>>);
    impl AsyncRead for Chunks {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
            buffer: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            if let Some(chunk) = self.0.pop_front() {
                buffer.put_slice(&chunk);
            }
            std::task::Poll::Ready(Ok(()))
        }
    }
    let bridge = Arc::new(Bridge::default());
    *bridge.current.lock().unwrap() = Some(LocalRun {
        view: RunView {
            id: "test".into(),
            name: "test".into(),
            status: "running".into(),
            output: String::new(),
            truncated: false,
        },
        stop: watch::channel(false).0,
        done: watch::channel(false).1,
    });
    for (chunks, expected) in [
        (
            vec![
                vec![0xc3],
                vec![0xa9, 0xe2],
                vec![0x98],
                vec![0x83, 0xf0, 0x9f],
                vec![0x98],
                vec![0x80],
            ],
            "\u{e9}\u{2603}\u{1f600}",
        ),
        (
            vec![vec![0xff, b'a', 0xe2], vec![0x98]],
            "\u{fffd}a\u{fffd}",
        ),
        (vec![vec![0xe2], vec![b'a']], "\u{fffd}a"),
    ] {
        bridge
            .current
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .view
            .output
            .clear();
        capture(bridge.clone(), Chunks(chunks.into())).await;
        assert_eq!(
            bridge.current.lock().unwrap().as_ref().unwrap().view.output,
            expected
        );
    }
}

#[tokio::test]
async fn computeruse_inflight_run_shutdown_and_disconnected_waiter_are_ordered() {
    for (closing, disconnect) in [(true, false), (true, true), (false, true)] {
        let root = tempfile::tempdir().unwrap();
        let state = fixture(root.path(), command());
        let doc = document(&state, "a.md", "saved");
        let waiting = root.path().join("waiting");
        let release = root.path().join("release");
        let binary = &state.remote.as_ref().unwrap().binary;
        let original = fs::read_to_string(binary).unwrap();
        fs::write(
            binary,
            original.replace(
                "exec /bin/bash",
                &format!(
                    "touch '{}'\nwhile [ ! -e '{}' ]; do sleep .01; done\nexec /bin/bash",
                    waiting.display(),
                    release.display()
                ),
            ),
        )
        .unwrap();
        let worker = tokio::spawn(request(
            state.clone(),
            "POST",
            "/api/computeruse/run",
            json!({"name":doc.name,"revision":doc.revision,"remote_revision":null}),
        ));
        tokio::time::timeout(Duration::from_secs(5), async {
            while !waiting.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        if disconnect {
            worker.abort();
        }
        let shutdown = if closing {
            let mut controls = Vec::new();
            for jobs in [&state.jobs, &state.performance_state.jobs] {
                let (stop, control) = watch::channel(RunControl::Running);
                jobs.lock().unwrap().push(Job {
                    id: "normal".into(),
                    name: "normal".into(),
                    status: "running".into(),
                    output: VecDeque::new(),
                    truncated: false,
                    remote_identity: String::new(),
                    recover: true,
                    repository_save: false,
                    optimization: false,
                    memory: None,
                    stop,
                    attached: false,
                    dirty: false,
                    persistence_error: None,
                });
                controls.push(control);
            }
            let app = state.clone();
            let shutdown = tokio::spawn(async move {
                detach_and_wait(&app).await;
            });
            // Both normal namespaces detach while bridge synchronization is still blocked.
            for mut control in controls {
                tokio::time::timeout(
                    Duration::from_secs(2),
                    control.wait_for(|c| *c == RunControl::Detach),
                )
                .await
                .unwrap()
                .unwrap();
            }
            assert!(state.computeruse.closed.load(Ordering::SeqCst));
            assert!(!shutdown.is_finished());
            Some(shutdown)
        } else {
            None
        };
        fs::write(&release, "").unwrap();
        if disconnect {
            assert!(worker.await.unwrap_err().is_cancelled());
        } else {
            let response = worker.await.unwrap();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            let response = json(response).await;
            assert!(
                response["error"]
                    .as_str()
                    .unwrap()
                    .contains("remote file and local mirror updated")
            );
            assert!(
                response["error"]
                    .as_str()
                    .unwrap()
                    .contains("No callback executed")
            );
        }
        if let Some(shutdown) = shutdown {
            tokio::time::timeout(Duration::from_secs(5), shutdown)
                .await
                .unwrap()
                .unwrap();
            assert!(state.computeruse.current.lock().unwrap().is_none());
        } else {
            tokio::time::timeout(Duration::from_secs(5), async {
                while state.computeruse.current.lock().unwrap().is_none() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(finished(&state).await["status"], "completed");
        }
        let config = state.computeruse.config.as_ref().unwrap();
        assert_eq!(fs::read_to_string(&config.remote).unwrap(), doc.content);
        assert_eq!(fs::read_to_string(&config.local).unwrap(), doc.content);
    }
}
