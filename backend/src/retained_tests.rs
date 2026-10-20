use super::*;
use serde_json::{Value, json};

const LIST: &str = "/api/files/a.md/retained-runs";

fn fixture() -> (tempfile::TempDir, App) {
    let root = tempfile::tempdir().unwrap();
    let mut state = app(root.path());
    fs::write(root.path().join("a.md"), "local spec").unwrap();
    state.remote = Some(remote_fixture(
        root.path(),
        &root.path().join("must-not-launch"),
    ));
    (root, state)
}

fn retained(root: &FsPath, id: &str, name: &str) -> PathBuf {
    let directory = root.join(format!(".spec-runs/run-{id}"));
    fs::create_dir_all(&directory).unwrap();
    for path in [directory.parent().unwrap(), directory.as_path()] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    for (name, contents) in [
        (format!("{name}.out"), "retained output"),
        ("status".into(), "0\n"),
    ] {
        let path = directory.join(name);
        fs::write(&path, contents).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    directory
}

async fn get(state: &App, path: &str) -> Value {
    let response = request(state.clone(), "GET", path, Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    super::json(response).await
}

#[tokio::test]
async fn retained_without_metadata_uses_exact_name_mtime_and_read_only_output() {
    let (root, state) = fixture();
    let first = Uuid::new_v4().to_string();
    let second = Uuid::new_v4().to_string();
    for (id, modified) in [(&first, 1700000000), (&second, 1700000100)] {
        let directory = retained(root.path(), id, "a.md");
        File::options()
            .write(true)
            .open(directory.join("a.md.out"))
            .unwrap()
            .set_times(
                fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(modified)),
            )
            .unwrap();
    }
    retained(root.path(), &Uuid::new_v4().to_string(), "a");
    retained(root.path(), &Uuid::new_v4().to_string(), "other.md");
    retained(root.path(), &Uuid::new_v4().to_string(), "output");
    assert_eq!(
        get(&state, LIST).await,
        json!({"runs": [
        {"id": second, "modified": 1700000100}, {"id": first, "modified": 1700000000}
    ], "truncated": false})
    );
    assert_eq!(
        get(&state, &format!("{LIST}/{first}/log")).await,
        json!({
            "id": first, "name": "a.md", "status": "completed", "output": "retained output",
            "truncated": false, "recoverable": false, "continuable": false
        })
    );
    assert_eq!(get(&state, "/api/files/a.md/run/log").await, Value::Null);
    assert!(!root.path().join(".spec-output").exists());
    assert!(state.jobs.lock().unwrap().is_empty());
    assert!(!*state.recovered.lock().unwrap());
    assert!(!root.path().join("must-not-launch").exists());
}

#[tokio::test]
async fn retained_rejects_unsafe_and_unrelated_candidates_on_list_and_read() {
    let (root, state) = fixture();
    let good = Uuid::new_v4().to_string();
    retained(root.path(), &good, "a.md");
    for kind in [
        "unrelated",
        "legacy",
        "directory-mode",
        "directory-symlink",
        "log-mode",
        "log-symlink",
        "log-hardlink",
        "log-fifo",
        "log-directory",
        "log-large",
        "missing-status",
        "status-mode",
        "status-symlink",
        "status-hardlink",
        "status-fifo",
        "status-invalid",
        "status-large",
        "lease-mode",
        "lease-symlink",
        "lease-hardlink",
    ] {
        let id = Uuid::new_v4().to_string();
        let directory = retained(root.path(), &id, "a.md");
        let log = directory.join("a.md.out");
        let status = directory.join("status");
        // A legacy log containing another spec's output must never rescue a candidate.
        fs::write(directory.join("output.log"), "wrong spec").unwrap();
        fs::set_permissions(
            directory.join("output.log"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        match kind {
            "unrelated" => fs::rename(&log, directory.join("other.md.out")).unwrap(),
            "legacy" => fs::remove_file(&log).unwrap(),
            "directory-mode" => {
                fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap()
            }
            "directory-symlink" => {
                let target = root.path().join(&id);
                fs::rename(&directory, &target).unwrap();
                symlink(target, &directory).unwrap();
            }
            "log-mode" | "status-mode" => fs::set_permissions(
                if kind == "log-mode" { &log } else { &status },
                fs::Permissions::from_mode(0o640),
            )
            .unwrap(),
            "log-symlink" | "status-symlink" => {
                let path = if kind == "log-symlink" { &log } else { &status };
                fs::remove_file(path).unwrap();
                symlink(directory.join("output.log"), path).unwrap();
            }
            "log-hardlink" | "status-hardlink" => fs::hard_link(
                if kind == "log-hardlink" {
                    &log
                } else {
                    &status
                },
                directory.join("linked"),
            )
            .unwrap(),
            "log-fifo" | "status-fifo" => {
                let path = if kind == "log-fifo" { &log } else { &status };
                fs::remove_file(path).unwrap();
                nix::unistd::mkfifo(
                    path,
                    nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
                )
                .unwrap();
            }
            "log-directory" => {
                fs::remove_file(&log).unwrap();
                fs::create_dir(&log).unwrap();
                fs::set_permissions(&log, fs::Permissions::from_mode(0o600)).unwrap();
            }
            "log-large" => File::options()
                .write(true)
                .open(&log)
                .unwrap()
                .set_len(8388609)
                .unwrap(),
            "missing-status" => fs::remove_file(&status).unwrap(),
            "status-invalid" => fs::write(&status, "256\n").unwrap(),
            "status-large" => fs::write(&status, "0\nignored").unwrap(),
            "lease-mode" | "lease-symlink" | "lease-hardlink" => {
                let lease = directory.join("lease");
                fs::rename(&status, &lease).unwrap();
                match kind {
                    "lease-mode" => {
                        fs::set_permissions(&lease, fs::Permissions::from_mode(0o644)).unwrap()
                    }
                    "lease-symlink" => {
                        fs::remove_file(&lease).unwrap();
                        symlink(directory.join("output.log"), &lease).unwrap();
                    }
                    _ => fs::hard_link(&lease, directory.join("linked")).unwrap(),
                }
            }
            _ => unreachable!(),
        }
        let response = request(
            state.clone(),
            "GET",
            &format!("{LIST}/{id}/log"),
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY, "{kind}");
    }
    retained(root.path(), "NOT-A-UUID", "a.md");
    retained(root.path(), "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", "a.md");
    let listed = get(&state, LIST).await;
    assert_eq!(listed["runs"].as_array().unwrap().len(), 1);
    assert_eq!(listed["runs"][0]["id"], good);
    assert_eq!(listed["truncated"], false);
}

#[tokio::test]
async fn retained_vanished_selection_never_substitutes_or_updates_missing_latest() {
    let (root, state) = fixture();
    let missing = Uuid::new_v4().to_string();
    let selected = Uuid::new_v4().to_string();
    let job = persisted_job(&missing, state.remote.as_ref().unwrap().identity(), true);
    recovery::persist(&state, &job).ok().unwrap();
    recovery::set_latest(&state, &job).ok().unwrap();
    state.jobs.lock().unwrap().push(job);
    let before = serde_json::to_value(&*state.jobs.lock().unwrap()).unwrap();
    let record = root.path().join(format!(".spec-output/{missing}.json"));
    let saved = fs::read(&record).unwrap();
    let directory = retained(root.path(), &selected, "a.md");
    assert_eq!(get(&state, LIST).await["runs"][0]["id"], selected);
    assert_eq!(
        get(&state, &format!("{LIST}/{selected}/log")).await["id"],
        selected
    );
    for vanished in ["log", "directory"] {
        if vanished == "log" {
            fs::rename(directory.join("a.md.out"), directory.join("output.log")).unwrap();
        } else {
            fs::remove_dir_all(&directory).unwrap();
        }
        let response = request(
            state.clone(),
            "GET",
            &format!("{LIST}/{selected}/log"),
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert!(super::json(response).await.get("output").is_none());
        let latest = get(&state, "/api/files/a.md/run/log").await;
        assert_eq!(latest["id"], missing);
        assert_eq!(latest["output"], "saved output");
        assert_eq!(latest["recoverable"], true);
        assert!(
            latest["status"]
                .as_str()
                .unwrap()
                .contains("remote run directory missing")
        );
    }
    assert_eq!(
        recovery::latest(&state, "a.md").ok().unwrap().unwrap(),
        missing
    );
    assert_eq!(fs::read(record).unwrap(), saved);
    assert_eq!(
        serde_json::to_value(&*state.jobs.lock().unwrap()).unwrap(),
        before
    );
    assert_eq!(
        fs::read_dir(root.path().join(".spec-output"))
            .unwrap()
            .count(),
        2
    );
    assert!(!*state.recovered.lock().unwrap());
    assert!(!root.path().join("must-not-launch").exists());
}

#[tokio::test]
async fn retained_validates_local_file_uuid_and_remote_provenance_before_ssh() {
    let (root, mut state) = fixture();
    let id = Uuid::new_v4().to_string();
    let remote = state.remote.clone().unwrap();
    fs::write(
        &remote.binary,
        format!(
            "#!/bin/bash\ntouch '{}/contacted'\nexit 99\n",
            root.path().display()
        ),
    )
    .unwrap();
    for (name, expected) in [
        ("absent.md", StatusCode::NOT_FOUND),
        (".hidden", StatusCode::BAD_REQUEST),
        ("directory", StatusCode::BAD_REQUEST),
        ("linked", StatusCode::INTERNAL_SERVER_ERROR),
    ] {
        if name == "directory" {
            fs::create_dir(root.path().join(name)).unwrap();
        }
        if name == "linked" {
            symlink(root.path().join("a.md"), root.path().join(name)).unwrap();
        }
        for suffix in [String::new(), format!("/{id}/log")] {
            assert_eq!(
                request(
                    state.clone(),
                    "GET",
                    &format!("/api/files/{name}/retained-runs{suffix}"),
                    Value::Null
                )
                .await
                .status(),
                expected
            );
        }
    }
    for id in ["invalid", "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"] {
        assert_eq!(
            request(
                state.clone(),
                "GET",
                &format!("{LIST}/{id}/log"),
                Value::Null
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
    let job = persisted_job(&id, remote.identity(), true);
    recovery::persist(&state, &job).ok().unwrap();
    recovery::set_latest(&state, &job).ok().unwrap();
    for field in ["disabled", "target", "directory", "binary", "key"] {
        state.remote = Some(remote.clone());
        match field {
            "disabled" => state.remote = None,
            "target" => state.remote.as_mut().unwrap().target = "other@host".into(),
            "directory" => state.remote.as_mut().unwrap().directory.push_str("/other"),
            "binary" => state.remote.as_mut().unwrap().binary = root.path().join("other-ssh"),
            "key" => state.remote.as_mut().unwrap().key = Some(root.path().join("other-key")),
            _ => unreachable!(),
        }
        for endpoint in [LIST.to_owned(), format!("{LIST}/{id}/log")] {
            assert_eq!(
                request(state.clone(), "GET", &endpoint, Value::Null)
                    .await
                    .status(),
                if field == "disabled" {
                    StatusCode::SERVICE_UNAVAILABLE
                } else {
                    StatusCode::BAD_GATEWAY
                }
            );
        }
    }
    assert!(!root.path().join("contacted").exists());
}

#[tokio::test]
async fn retained_unsafe_or_missing_root_fails_closed() {
    for kind in ["missing", "mode", "symlink"] {
        let (root, state) = fixture();
        let id = Uuid::new_v4().to_string();
        retained(root.path(), &id, "a.md");
        let parent = root.path().join(".spec-runs");
        match kind {
            "missing" => fs::remove_dir_all(&parent).unwrap(),
            "mode" => fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap(),
            "symlink" => {
                let target = root.path().join("elsewhere");
                fs::rename(&parent, &target).unwrap();
                symlink(target, &parent).unwrap();
            }
            _ => unreachable!(),
        }
        for endpoint in [LIST.to_owned(), format!("{LIST}/{id}/log")] {
            assert_eq!(
                request(state.clone(), "GET", &endpoint, Value::Null)
                    .await
                    .status(),
                StatusCode::BAD_GATEWAY,
                "{kind}"
            );
        }
    }
}

#[tokio::test]
async fn retained_bounds_enumeration_and_log_output_and_observes_leases() {
    let (root, state) = fixture();
    for _ in 0..129 {
        retained(root.path(), &Uuid::new_v4().to_string(), "a.md");
    }
    let listed = get(&state, LIST).await;
    assert_eq!(listed["runs"].as_array().unwrap().len(), 128);
    assert_eq!(listed["truncated"], true);
    let id = listed["runs"][0]["id"].as_str().unwrap();
    let directory = root.path().join(format!(".spec-runs/run-{id}"));
    fs::write(
        directory.join("a.md.out"),
        [b"discarded".as_slice(), &vec![b'x'; MAX_OUTPUT]].concat(),
    )
    .unwrap();
    let output = get(&state, &format!("{LIST}/{id}/log")).await;
    assert_eq!(output["output"], "x".repeat(MAX_OUTPUT));
    assert_eq!(output["truncated"], true);
    fs::rename(directory.join("status"), directory.join("lease")).unwrap();
    let lease = File::open(directory.join("lease")).unwrap();
    let lease =
        nix::fcntl::Flock::lock(lease, nix::fcntl::FlockArg::LockExclusiveNonblock).unwrap();
    let output = get(&state, &format!("{LIST}/{id}/log")).await;
    assert_eq!(output["status"], "running");
    assert_eq!(output["recoverable"], false);
    assert_eq!(output["continuable"], false);
    assert!(!directory.join("cancel").exists());
    drop(lease);
    assert_eq!(
        get(&state, &format!("{LIST}/{id}/log")).await["status"],
        "unknown (remote status unavailable)"
    );
    fs::remove_dir_all(root.path().join(".spec-runs")).unwrap();
    fs::create_dir(root.path().join(".spec-runs")).unwrap();
    fs::set_permissions(
        root.path().join(".spec-runs"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    for index in 0..4097 {
        fs::write(root.path().join(format!(".spec-runs/invalid-{index}")), "").unwrap();
    }
    assert_eq!(
        get(&state, LIST).await,
        json!({"runs": [], "truncated": true})
    );
}

#[tokio::test]
async fn retained_transport_rejects_oversized_responses_without_waiting_for_other_pipe() {
    let (root, state) = fixture();
    for stream in ["", " >&2"] {
        fs::write(
            &state.remote.as_ref().unwrap().binary,
            format!("#!/bin/bash\nhead -c 2000000 /dev/zero{stream}\nsleep 30\n"),
        )
        .unwrap();
        let response = tokio::time::timeout(
            Duration::from_secs(3),
            request(state.clone(), "GET", LIST, Value::Null),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert!(
            super::json(response).await["error"]
                .as_str()
                .unwrap()
                .contains("exceeded limit")
        );
    }
    assert!(!root.path().join(".spec-output").exists());
}

#[tokio::test]
async fn retained_optimization_requires_private_exact_initial_build_invocation() {
    for linked_workspace in [false, true] {
        let (root, mut state) = fixture();
        fs::write(root.path().join("optimization"), "hello").unwrap();
        if linked_workspace {
            let link = root.path().join("workspace-link");
            symlink(root.path(), &link).unwrap();
            state.remote.as_mut().unwrap().directory = link.to_str().unwrap().into();
        }
        let remote = state.remote.as_ref().unwrap();
        fs::write(
            root.path().join(".bash_aliases"),
            "spec() { cat -- \"$2\"; }\n",
        )
        .unwrap();
        let good = Uuid::new_v4().to_string();
        // Use the actual launcher to prove its ordinary initial-build metadata qualifies.
        let mut child = remote
            .command(5, &good, "optimization")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(b"hello").await.unwrap();
        let output = tokio::time::timeout(Duration::from_secs(10), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        drop(stdin);
        assert!(output.status.success(), "{output:?}");
        let endpoint = "/api/files/optimization/retained-runs";
        assert_eq!(
            get(&state, &format!("{endpoint}/{good}/log")).await["output"],
            "hello"
        );

        for kind in [
            "optimizer",
            "continuation",
            "workspace",
            "kind",
            "name",
            "log",
            "trailing",
            "large",
            "mode",
            "symlink",
            "hardlink",
            "fifo",
        ] {
            let id = Uuid::new_v4().to_string();
            let directory = retained(root.path(), &id, "optimization");
            let record = directory.join("invocation");
            let mut fields = [
                remote.directory.clone(),
                "build".into(),
                "optimization".into(),
                format!("{}/.spec-runs/run-{id}/optimization.out", remote.directory),
                String::new(),
            ];
            match kind {
                "workspace" => fields[0].push_str("/other"),
                "kind" => fields[1] = "optimize".into(),
                "name" => fields[2] = "other".into(),
                "log" => {
                    fields[3] = format!(
                        "{}/.spec-runs/run-{good}/optimization.out",
                        remote.directory
                    )
                }
                "trailing" => fields[4] = "extra".into(),
                _ => {}
            }
            fs::write(&record, fields.join("\0")).unwrap();
            fs::set_permissions(&record, fs::Permissions::from_mode(0o600)).unwrap();
            match kind {
                "optimizer" | "continuation" => {
                    fs::remove_file(&record).unwrap();
                    // Neither optimizer reports nor continuation session IDs prove an initial build.
                    fs::write(
                        directory.join(if kind == "optimizer" {
                            "report.jsonl"
                        } else {
                            "session-id"
                        }),
                        "metadata",
                    )
                    .unwrap();
                }
                "large" => File::options()
                    .write(true)
                    .open(&record)
                    .unwrap()
                    .set_len(16385)
                    .unwrap(),
                "mode" => fs::set_permissions(&record, fs::Permissions::from_mode(0o644)).unwrap(),
                "symlink" => {
                    let target = directory.join("actual-invocation");
                    fs::rename(&record, &target).unwrap();
                    symlink(target, &record).unwrap();
                }
                "hardlink" => fs::hard_link(&record, directory.join("linked-invocation")).unwrap(),
                "fifo" => {
                    fs::remove_file(&record).unwrap();
                    nix::unistd::mkfifo(
                        &record,
                        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
                    )
                    .unwrap();
                }
                _ => {}
            }
            assert_eq!(
                request(
                    state.clone(),
                    "GET",
                    &format!("{endpoint}/{id}/log"),
                    Value::Null
                )
                .await
                .status(),
                StatusCode::BAD_GATEWAY,
                "{kind}"
            );
        }
        let listed = get(&state, endpoint).await;
        assert_eq!(listed["runs"].as_array().unwrap().len(), 1);
        assert_eq!(listed["runs"][0]["id"], good);
        assert_eq!(listed["truncated"], false);
        // Revalidate the proof on selection, not just during enumeration.
        fs::remove_file(
            root.path()
                .join(format!(".spec-runs/run-{good}/invocation")),
        )
        .unwrap();
        assert_eq!(
            request(
                state.clone(),
                "GET",
                &format!("{endpoint}/{good}/log"),
                Value::Null
            )
            .await
            .status(),
            StatusCode::BAD_GATEWAY
        );
        assert!(!root.path().join(".spec-output").exists());
        assert!(state.jobs.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn retained_workspace_symlink_preserves_identity_but_storage_symlinks_fail() {
    let (root, mut state) = fixture();
    let id = Uuid::new_v4().to_string();
    retained(root.path(), &id, "a.md");
    let link = root.path().join("configured-workspace");
    symlink(root.path(), &link).unwrap();
    state.remote.as_mut().unwrap().directory = link.to_str().unwrap().into();
    let identity = state.remote.as_ref().unwrap().identity();
    let job = persisted_job(&id, identity.clone(), false);
    recovery::persist(&state, &job).ok().unwrap();
    recovery::set_latest(&state, &job).ok().unwrap();
    assert_eq!(get(&state, LIST).await["runs"][0]["id"], id);
    assert_eq!(
        get(&state, &format!("{LIST}/{id}/log")).await["output"],
        "retained output"
    );
    assert_eq!(state.remote.as_ref().unwrap().identity(), identity);
    assert_eq!(
        state.remote.as_ref().unwrap().directory,
        link.to_str().unwrap()
    );
    let parent = root.path().join(".spec-runs");
    let target = root.path().join("elsewhere");
    fs::rename(&parent, &target).unwrap();
    symlink(target, parent).unwrap();
    for endpoint in [LIST.to_owned(), format!("{LIST}/{id}/log")] {
        assert_eq!(
            request(state.clone(), "GET", &endpoint, Value::Null)
                .await
                .status(),
            StatusCode::BAD_GATEWAY
        );
    }
}

#[test]
fn retained_terminal_snapshot_samples_log_size_and_mtime_after_status() {
    for (size, historical) in [
        (64, true),
        (MAX_OUTPUT + 1, true),
        (8388609, true),
        (64, false),
    ] {
        let (root, _state) = fixture();
        let id = Uuid::new_v4().to_string();
        let directory = retained(root.path(), &id, "a.md");
        fs::remove_file(directory.join("status")).unwrap();
        // Finish precisely when the reader opens status, after it has opened and
        // validated the log. No timing sleeps or production test hooks are needed.
        let result = std::process::Command::new("python3")
            .args([
                "-I",
                "-c",
                r#"
import os, sys
script = sys.argv.pop(1)
size = int(sys.argv.pop(1))
run_id = sys.argv.pop(1)
directory = os.path.join(sys.argv[1], '.spec-runs', 'run-' + run_id)
original_open = os.open
def finish(path, *args, **kwargs):
    if path == 'status':
        log = os.path.join(directory, 'a.md.out')
        with open(log, 'ab') as stream:
            stream.write(b'x' * (size - stream.tell()))
        os.utime(log, (1700000100, 1700000100))
        status = os.path.join(directory, 'status')
        with open(status, 'wb') as stream:
            stream.write(b'0\n')
        os.chmod(status, 0o600)
    return original_open(path, *args, **kwargs)
os.open = finish
exec(script)
"#,
                include_str!("remote-retained.py"),
                &size.to_string(),
                &id,
                root.path().to_str().unwrap(),
                "a.md",
                if historical { &id } else { "" },
            ])
            .output()
            .unwrap();
        if size > 8388608 {
            assert_eq!(result.status.code(), Some(125));
            assert!(String::from_utf8_lossy(&result.stderr).contains("exceeds size limit"));
            continue;
        }
        assert!(result.status.success(), "{result:?}");
        let output: Value = serde_json::from_slice(&result.stdout).unwrap();
        if historical {
            assert_eq!(output["status"], "completed");
            assert_eq!(
                output["output"].as_str().unwrap().len(),
                size.min(MAX_OUTPUT)
            );
            assert!(output["output"].as_str().unwrap().ends_with("xxx"));
            assert_eq!(output["truncated"], size > MAX_OUTPUT);
        } else {
            assert_eq!(output["runs"][0]["modified"], 1700000100);
        }
    }
}
