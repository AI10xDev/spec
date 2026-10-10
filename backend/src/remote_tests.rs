use super::*;
use tokio::io::AsyncWriteExt;

#[test]
fn remote_configuration_rejects_options_and_relative_paths() {
    let mut remote = Remote {
        binary: "/usr/bin/ssh".into(),
        target: "user@host".into(),
        directory: "/home/user/project ' with spaces".into(),
        key: None,
    };
    assert!(remote.validate().is_ok());
    for target in [
        "",
        "-oProxyCommand=evil",
        "host; touch injected",
        "host\ncommand",
        "$(command)",
    ] {
        remote.target = target.into();
        assert!(remote.validate().is_err());
    }
    remote.target = "my-ssh-host".into();
    remote.directory = "~/project".into();
    assert!(remote.validate().is_err());
    remote.directory = "/project".into();
    remote.key = Some("relative-key".into());
    assert!(remote.validate().is_err());
    remote.key = None;
    remote.binary = "ssh".into();
    assert!(remote.validate().is_err());
}

#[test]
fn remote_key_validation_distinguishes_missing_and_non_file_paths() {
    let root = tempfile::tempdir().unwrap();
    let key = root.path().join("identity with spaces");
    let mut remote = Remote {
        binary: "/usr/bin/ssh".into(),
        target: "user@host".into(),
        directory: "/project".into(),
        key: Some(key.clone()),
    };
    let error = remote.validate().unwrap_err().to_string();
    assert!(error.contains("Cannot access SPEC_SSH_KEY local file"));
    assert!(error.contains(key.to_str().unwrap()));
    assert!(error.contains("unset SPEC_SSH_KEY"));

    remote.key = Some(root.path().into());
    assert!(
        remote
            .validate()
            .unwrap_err()
            .to_string()
            .contains("not a directory or special file")
    );

    fs::write(&key, b"test identity placeholder").unwrap();
    remote.key = Some(key);
    assert!(remote.validate().is_ok());
}

#[test]
fn ssh_is_noninteractive_with_host_verification_and_no_forwarding() {
    let remote = Remote {
        binary: "/usr/bin/ssh".into(),
        target: "user@host".into(),
        directory: "/remote/project".into(),
        key: Some("/local/key with spaces".into()),
    };
    let command = remote.command(42, &Uuid::new_v4().to_string(), "a.md");
    let args: Vec<_> = command
        .as_std()
        .get_args()
        .map(|v| v.to_str().unwrap())
        .collect();
    for option in [
        "-T",
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        "ClearAllForwardings=yes",
        "ForwardAgent=no",
        "ForwardX11=no",
        "PermitLocalCommand=no",
        "ControlPath=none",
        "IdentitiesOnly=yes",
        "/local/key with spaces",
    ] {
        assert!(args.contains(&option), "{option}");
    }
    assert_eq!(args[args.len() - 3], "--");
    assert_eq!(args[args.len() - 2], "user@host");
    assert!(!args.last().unwrap().contains("/local/key"));
}

#[tokio::test]
async fn truncated_upload_never_starts_build_and_persists_rejection() {
    let root = tempfile::tempdir().unwrap();
    let runner = root.path().join("unused");
    let remote = tests::remote_fixture(root.path(), &runner);
    let mut child = tokio::process::Command::new("bash")
        .args([
            "-c",
            include_str!("remote-build.bash"),
            "--",
            &remote.directory,
            "100",
            include_str!("remote-alias.bash"),
            include_str!("remote-supervisor.bash"),
            &Uuid::new_v4().to_string(),
            "a.md",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"short upload").await.unwrap();
    drop(stdin);
    let result = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.status.code(), Some(125));
    assert!(String::from_utf8_lossy(&result.stderr).contains("incomplete snapshot"));
    assert_eq!(
        fs::read_dir(root.path().join(".spec-runs"))
            .unwrap()
            .count(),
        1
    );
    let directory = fs::read_dir(root.path().join(".spec-runs"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert!(!directory.join("snapshot.md").exists());
    assert_eq!(
        fs::read_to_string(directory.join("status")).unwrap(),
        "125\n"
    );
}

#[tokio::test]
async fn remote_function_is_supported_and_missing_spec_is_reported() {
    for defined in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let remote = tests::remote_fixture(root.path(), &root.path().join("unused"));
        fs::write(root.path().join(".bash_aliases"), if defined {
            "spec() { test \"$1\" = build && test \"$SPEC_BUILD_FOREGROUND\" = 1 && test \"$SPEC_BUILD_AUTO\" = 1 || return 90; cat -- \"$2\"; }\n"
        } else {
            "PATH=/nonexistent\n"
        }).unwrap();
        let mut child = remote
            .command(5, &Uuid::new_v4().to_string(), "a.md")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(b"hello").await.unwrap();
        let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        drop(stdin);
        if defined {
            assert!(output.status.success());
            assert_eq!(output.stdout, b"hello");
        } else {
            assert_eq!(output.status.code(), Some(127));
            assert!(
                String::from_utf8_lossy(&output.stdout)
                    .contains("spec alias/function/launcher not found")
            );
        }
    }
}

#[tokio::test]
async fn remote_engine_path_and_auto_settings_reach_children_without_login_profiles() {
    let runtime = std::process::Command::new("bash")
        .args(["-c", "type -P bun || type -P node"])
        .output()
        .unwrap();
    assert!(
        runtime.status.success(),
        "remote tests require Bun or Node.js"
    );
    let runtime = String::from_utf8(runtime.stdout).unwrap();
    for (install, status) in [
        (".local/bin", 0),
        (".bun/bin", 0),
        ("custom engine/bin", 42),
        ("missing", 127),
    ] {
        let root = tempfile::tempdir().unwrap();
        let runner = root.path().join("run-spec.sh");
        let remote = tests::remote_fixture(root.path(), &runner);
        // Keep the instruction runtime available while isolating engine lookup.
        let runtime_bin = root.path().join("instruction-runtime");
        fs::create_dir(&runtime_bin).unwrap();
        let runtime_name = FsPath::new(runtime.trim()).file_name().unwrap();
        std::os::unix::fs::symlink(runtime.trim(), runtime_bin.join(runtime_name)).unwrap();
        for utility in ["mktemp", "rm"] {
            std::os::unix::fs::symlink(format!("/usr/bin/{utility}"), runtime_bin.join(utility))
                .unwrap();
        }
        // Model the reported failure: the alias calls a script, which needs an
        // executable (not a shell alias) in its inherited PATH.
        fs::write(
            &runner,
            "#!/bin/bash\n[[ $1 == build && $SPEC_BUILD_FOREGROUND == 1 && $SPEC_BUILD_AUTO == 1 ]] || exit 90\nopencode-source \"$2\"\n",
        )
        .unwrap();
        fs::set_permissions(&runner, fs::Permissions::from_mode(0o700)).unwrap();
        for profile in [".bashrc", ".bash_profile", ".profile"] {
            fs::write(root.path().join(profile), "exit 91\n").unwrap();
        }
        if install != "missing" {
            let bin = root.path().join(install);
            fs::create_dir_all(&bin).unwrap();
            let engine = bin.join("opencode-source");
            fs::write(
                &engine,
                format!(
                    r#"#!/bin/bash
[[ $SPEC_BUILD_FOREGROUND == 1 && $SPEC_BUILD_AUTO == 1 ]] || exit 92
[[ $OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS == 1 && $OPENCODE_QUESTION_AUTO_RECOMMEND == 1 ]] || exit 93
[[ ! -v SPEC_SESSION_DIR && ! -v KIBI_SPEC_SESSION ]] || exit 94
cat -- "$1"
exit {status}
"#
                ),
            )
            .unwrap();
            fs::set_permissions(engine, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let aliases = root.path().join(".bash_aliases");
        let mut definition = fs::read_to_string(&aliases).unwrap();
        // Policy must be exported after sourcing aliases, even when they unset
        // it or opt back into interactive sessions.
        if install == ".local/bin" {
            definition.push_str("unset SPEC_BUILD_FOREGROUND SPEC_BUILD_AUTO OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS OPENCODE_QUESTION_AUTO_RECOMMEND\n");
        } else {
            definition.push_str("export SPEC_BUILD_FOREGROUND=0 SPEC_BUILD_AUTO=0 OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS=0 OPENCODE_QUESTION_AUTO_RECOMMEND=0\n");
        }
        definition.push_str("export SPEC_SESSION_DIR=/unused/session KIBI_SPEC_SESSION=1\n");
        if install == "custom engine/bin" {
            definition.push_str("export PATH=\"$HOME/custom engine/bin:$PATH\"\n");
        } else if install == "missing" {
            // Isolate from any engines installed on the test host, and verify
            // that trusted alias-file PATH overrides are not overwritten.
            definition.push_str("export PATH=\"$HOME/instruction-runtime\"\n");
        }
        fs::write(aliases, definition).unwrap();
        let mut child = remote
            .command(5, &Uuid::new_v4().to_string(), "a.md")
            .env("PATH", format!("{}:/usr/bin:/bin", runtime_bin.display()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(b"hello").await.unwrap();
        let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        drop(stdin);
        assert_eq!(output.status.code(), Some(status), "{install}: {output:?}");
        if install == "missing" {
            let stderr = String::from_utf8_lossy(&output.stdout);
            assert!(stderr.contains("opencode-source: command not found"));
            assert!(stderr.contains("export its directory in PATH in ~/.bash_aliases"));
        } else {
            assert_eq!(output.stdout, b"hello", "{install}");
            assert!(
                String::from_utf8_lossy(&output.stderr).contains("[remote] session:"),
                "{install}"
            );
        }
    }
}

#[tokio::test]
async fn detached_builds_survive_eof_hup_and_attachment_kill_then_watchdog_cleans_descendants() {
    for disconnect in ["connected", "eof", "unknown", "hup", "kill"] {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join(".bash_aliases"),
            r#"
spec() {
    printf '%s' "$2" > snapshot-path
    sleep 60 &
    printf '%s' "$!" > descendant-pid
    wait
}
"#,
        )
        .unwrap();
        // Shorten only the test watchdog; production remains 15 minutes.
        let supervisor =
            include_str!("remote-supervisor.bash").replace("SECONDS >= 900", "SECONDS >= 3");
        let attachment = include_str!("remote-build.bash").replace(
            "reader=$!",
            "reader=$!\nprintf '%s' \"$reader\" > control-reader-pid",
        );
        let mut child = tokio::process::Command::new("bash")
            .env("HOME", root.path())
            .args([
                "-c",
                &attachment,
                "--",
                root.path().to_str().unwrap(),
                "5",
                include_str!("remote-alias.bash"),
                &supervisor,
                &Uuid::new_v4().to_string(),
                "a.md",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(b"hello").await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !root.path().join("descendant-pid").exists()
                || !fs::read_to_string(root.path().join("control-reader-pid"))
                    .is_ok_and(|pid| !pid.is_empty())
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let reader = fs::read_to_string(root.path().join("control-reader-pid")).unwrap();
        let snapshot =
            PathBuf::from(fs::read_to_string(root.path().join("snapshot-path")).unwrap());
        let directory = snapshot.parent().unwrap();
        if disconnect == "unknown" {
            stdin.write_all(b"?").await.unwrap();
        }
        let lease = if disconnect == "eof" {
            drop(stdin);
            None
        } else {
            Some(stdin)
        };
        if disconnect == "hup" {
            nix::sys::signal::kill(Pid::from_raw(child.id().unwrap() as i32), Signal::SIGHUP)
                .unwrap();
        } else if disconnect == "kill" {
            child.start_kill().unwrap();
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(snapshot.exists(), "{disconnect}");
        assert!(!directory.join("status").exists(), "{disconnect}");
        let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        // Keep stdin open while checking cleanup, including attachment SIGKILL.
        tokio::time::timeout(Duration::from_secs(2), async {
            while let Ok(stat) = fs::read_to_string(format!("/proc/{reader}/stat")) {
                if stat.split(") ").nth(1).unwrap().starts_with('Z') {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        drop(lease);
        if disconnect == "connected" {
            assert_eq!(output.status.code(), Some(124));
        } else if disconnect != "kill" {
            assert_eq!(output.status.code(), Some(125));
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            while !directory.join("status").exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            fs::read_to_string(directory.join("status")).unwrap(),
            "124\n"
        );
        assert!(!snapshot.exists());
        let pid = fs::read_to_string(root.path().join("descendant-pid")).unwrap();
        if let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) {
            assert_eq!(stat.split(") ").nth(1).unwrap().chars().next(), Some('Z'));
        }
    }
}

#[tokio::test]
async fn disconnected_completion_retains_private_bounded_log_and_reaps_leftover_children() {
    let root = tempfile::tempdir().unwrap();
    let remote = tests::remote_fixture(root.path(), &root.path().join("unused"));
    fs::write(
        root.path().join(".bash_aliases"),
        r#"
spec() {
    printf '%s' "$2" > snapshot-path
    while [[ ! -f finish ]]; do sleep 0.02; done
    printf 'output after disconnect\n'
    head -c 9000000 /dev/zero
    printf 'finished writing\n' > wrote-all
    sleep 60 &
    printf '%s' "$!" > descendant-pid
    return 7
}
"#,
    )
    .unwrap();
    let mut child = remote
        .command(5, &Uuid::new_v4().to_string(), "a.md")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"hello").await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !root.path().join("snapshot-path").exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    drop(stdin);
    let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(output.status.code(), Some(125));
    let snapshot = PathBuf::from(fs::read_to_string(root.path().join("snapshot-path")).unwrap());
    let directory = snapshot.parent().unwrap();
    assert!(String::from_utf8_lossy(&output.stderr).contains(directory.to_str().unwrap()));
    fs::write(root.path().join("finish"), "").unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !directory.join("status").exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(fs::read_to_string(directory.join("status")).unwrap(), "7\n");
    assert!(root.path().join("wrote-all").exists());
    assert!(!snapshot.exists());
    assert_eq!(fs::read_dir(directory).unwrap().count(), 3);
    let log = fs::read(directory.join("a.md.out")).unwrap();
    assert_eq!(log.len(), 8 * 1024 * 1024);
    assert!(log.starts_with(b"output after disconnect\n"));
    for (path, mode) in [
        (directory.to_owned(), 0o700),
        (directory.join("status"), 0o600),
        (directory.join("a.md.out"), 0o600),
    ] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            mode
        );
    }
    let pid = fs::read_to_string(root.path().join("descendant-pid")).unwrap();
    if let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) {
        assert_eq!(stat.split(") ").nth(1).unwrap().chars().next(), Some('Z'));
    }
}

#[tokio::test]
async fn cancellation_survives_blocked_attachment_output() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join(".bash_aliases"),
        r#"
spec() {
    printf '%s' "$2" > snapshot-path
    sleep 60 &
    printf '%s' "$!" > descendant-pid
    head -c 8388608 /dev/zero
    : > wrote-all
    wait
}
"#,
    )
    .unwrap();
    // Bound remote cleanup even if the test fails before it can send cancellation.
    let supervisor =
        include_str!("remote-supervisor.bash").replace("SECONDS >= 900", "SECONDS >= 10");
    let mut child = tokio::process::Command::new("bash")
        .env("HOME", root.path())
        .args([
            "-c",
            include_str!("remote-build.bash"),
            "--",
            root.path().to_str().unwrap(),
            "5",
            include_str!("remote-alias.bash"),
            &supervisor,
            &Uuid::new_v4().to_string(),
            "a.md",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let attachment = child.id().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        stdin.write_all(b"hello").await?;
        loop {
            // Do not merely sleep and hope stdout is blocked: observe the actual
            // forwarding dd waiting for pipe space before delivering C.
            let children =
                fs::read_to_string(format!("/proc/{attachment}/task/{attachment}/children"))?;
            if root.path().join("wrote-all").exists()
                && children.split_whitespace().any(|pid| {
                    fs::read_to_string(format!("/proc/{pid}/comm"))
                        .is_ok_and(|name| name.trim() == "dd")
                        && fs::read_to_string(format!("/proc/{pid}/wchan"))
                            .is_ok_and(|state| state.trim().ends_with("pipe_write"))
                })
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        stdin.write_all(b"C").await?;
        let snapshot = PathBuf::from(fs::read_to_string(root.path().join("snapshot-path"))?);
        let directory = snapshot.parent().unwrap();
        while !directory.join("status").exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let status = fs::read_to_string(directory.join("status"))?;
        let descendant = fs::read_to_string(root.path().join("descendant-pid"))?;
        let descendant_stopped = fs::read_to_string(format!("/proc/{descendant}/stat"))
            .map(|stat| stat.split(") ").nth(1).unwrap().starts_with('Z'))
            .unwrap_or(true);
        Ok::<_, std::io::Error>((status, snapshot.exists(), descendant_stopped))
    })
    .await;
    // Release backpressure and reap the attachment before any assertion can panic.
    // Keep stdin open through exit so EOF cannot hide a leaked control reader.
    drop(child.stdout.take());
    let exit = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
    drop(stdin);
    exit.unwrap().unwrap();
    let (status, snapshot_exists, descendant_stopped) = result.unwrap().unwrap();
    assert_eq!(status, "130\n");
    assert!(!snapshot_exists);
    assert!(descendant_stopped);
}

#[tokio::test]
async fn early_explicit_cancel_is_not_eof_or_snapshot_data() {
    let root = tempfile::tempdir().unwrap();
    let remote = tests::remote_fixture(root.path(), &root.path().join("unused"));
    fs::write(root.path().join(".bash_aliases"), "spec() { sleep 60; }\n").unwrap();
    let mut child = remote
        .command(5, &Uuid::new_v4().to_string(), "a.md")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"helloC").await.unwrap();
    let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    drop(stdin);
    assert_eq!(output.status.code(), Some(130));
    let directory = fs::read_dir(root.path().join(".spec-runs"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(
        fs::read_to_string(directory.join("status")).unwrap(),
        "130\n"
    );
    assert!(!directory.join("snapshot.md").exists());
}

#[tokio::test]
async fn retention_prunes_only_old_finished_sessions_and_rejects_unsafe_parent() {
    let root = tempfile::tempdir().unwrap();
    let remote = tests::remote_fixture(root.path(), &root.path().join("unused"));
    fs::write(root.path().join(".bash_aliases"), "spec() { return 0; }\n").unwrap();
    let sessions = root.path().join(".spec-runs");
    fs::create_dir(&sessions).unwrap();
    fs::set_permissions(&sessions, fs::Permissions::from_mode(0o700)).unwrap();
    for name in ["old", "recent", "unfinished"] {
        fs::create_dir(sessions.join(name)).unwrap();
    }
    fs::write(sessions.join("old/status"), "0\n").unwrap();
    fs::write(sessions.join("recent/status"), "0\n").unwrap();
    let old = std::time::SystemTime::now() - Duration::from_secs(8 * 24 * 60 * 60);
    File::options()
        .write(true)
        .open(sessions.join("old/status"))
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(old))
        .unwrap();
    let mut child = remote
        .command(5, &Uuid::new_v4().to_string(), "a.md")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"hello").await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    drop(stdin);
    assert!(!sessions.join("old").exists());
    assert!(sessions.join("recent/status").exists());
    assert!(sessions.join("unfinished").exists());

    // Refuse unsafe existing storage without changing its permissions or contents.
    for symlink in [false, true] {
        if symlink {
            fs::set_permissions(&sessions, fs::Permissions::from_mode(0o700)).unwrap();
            fs::rename(&sessions, root.path().join("elsewhere")).unwrap();
            std::os::unix::fs::symlink(root.path().join("elsewhere"), &sessions).unwrap();
        } else {
            fs::set_permissions(&sessions, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let result = remote
            .command(5, &Uuid::new_v4().to_string(), "a.md")
            .stdin(Stdio::null())
            .output()
            .await
            .unwrap();
        assert_eq!(result.status.code(), Some(125));
        assert!(String::from_utf8_lossy(&result.stderr).contains("owned, private"));
        assert_eq!(
            fs::metadata(&sessions).unwrap().permissions().mode() & 0o777,
            if symlink { 0o700 } else { 0o755 }
        );
    }
}

#[tokio::test]
async fn recovery_is_nonlaunching_bounded_and_requires_known_status() {
    let root = tempfile::tempdir().unwrap();
    let remote = tests::remote_fixture(root.path(), &root.path().join("unused"));
    fs::write(root.path().join(".bash_aliases"), "touch sourced-aliases\n").unwrap();
    let id = Uuid::new_v4().to_string();
    let parent = root.path().join(".spec-runs");
    let directory = parent.join(format!("run-{id}"));
    fs::create_dir(&parent).unwrap();
    fs::create_dir(&directory).unwrap();
    for dir in [&parent, &directory] {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let log = directory.join("output.log");
    let status = directory.join("status");
    let mut content = vec![b'x'; MAX_OUTPUT + 50];
    content.extend_from_slice(b"final output");
    fs::write(&log, &content).unwrap();
    fs::set_permissions(&log, fs::Permissions::from_mode(0o600)).unwrap();
    // A missing status/lease is not evidence of success or a living supervisor.
    let (state, bytes, truncated) = remote.snapshot(&id, false, "a.md").await.unwrap();
    assert!(state.starts_with("unknown"));
    assert_eq!(bytes.len(), MAX_OUTPUT);
    assert!(bytes.ends_with(b"final output"));
    assert!(truncated);
    assert!(remote.snapshot(&id, true, "a.md").await.is_err());
    assert!(!directory.join("cancel").exists());
    let lease = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(directory.join("lease"))
        .unwrap();
    let (state, _, _) = remote.snapshot(&id, false, "a.md").await.unwrap();
    assert!(state.starts_with("unknown"));
    let lock = nix::fcntl::Flock::lock(lease, nix::fcntl::FlockArg::LockExclusiveNonblock).unwrap();
    assert_eq!(
        remote.snapshot(&id, false, "a.md").await.unwrap().0,
        "running"
    );
    let outside = tempfile::NamedTempFile::new().unwrap();
    fs::write(outside.path(), "do not truncate").unwrap();
    std::os::unix::fs::symlink(outside.path(), directory.join("cancel")).unwrap();
    assert!(remote.snapshot(&id, true, "a.md").await.is_err());
    assert_eq!(
        fs::read_to_string(outside.path()).unwrap(),
        "do not truncate"
    );
    fs::remove_file(directory.join("cancel")).unwrap();
    assert_eq!(
        remote.snapshot(&id, true, "a.md").await.unwrap().0,
        "running"
    );
    assert!(directory.join("cancel").is_file());
    drop(lock);
    for code in [
        "0\n", "7\n", "124\n", "130\n", "garbage", "", "256\n", "0\n0\n",
    ] {
        fs::write(&status, code).unwrap();
        fs::set_permissions(&status, fs::Permissions::from_mode(0o600)).unwrap();
        let result = remote.snapshot(&id, false, "a.md").await;
        if let Some(expected) = match code {
            "0\n" => Some("completed"),
            "7\n" => Some("failed (exit status: 7)"),
            "124\n" => Some("timed out"),
            "130\n" => Some("cancelled"),
            _ => None,
        } {
            assert_eq!(result.unwrap().0, expected);
        } else {
            assert!(result.is_err(), "{code:?}");
        }
    }
    assert!(!root.path().join("sourced-aliases").exists());
    for bad_id in ["../outside", "x; touch injected", "", "/tmp/run", "a"] {
        assert!(remote.snapshot(bad_id, false, "a.md").await.is_err());
    }
    assert!(!root.path().join("injected").exists());
}

#[tokio::test]
async fn recovery_rejects_remote_symlinks_nonregular_files_and_public_storage() {
    for kind in [
        "parent",
        "directory",
        "log",
        "status",
        "lease",
        "fifo",
        "public",
        "large",
        "named-log",
        "named-dangling",
        "named-fifo",
        "named-directory",
        "named-public",
        "named-hardlink",
        "named-large",
    ] {
        let root = tempfile::tempdir().unwrap();
        let remote = tests::remote_fixture(root.path(), &root.path().join("unused"));
        let id = Uuid::new_v4().to_string();
        let parent = root.path().join(".spec-runs");
        let directory = parent.join(format!("run-{id}"));
        fs::create_dir(&parent).unwrap();
        fs::create_dir(&directory).unwrap();
        for dir in [&parent, &directory] {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::write(directory.join("output.log"), "safe output").unwrap();
        fs::set_permissions(
            directory.join("output.log"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::write(outside.path(), "0\n").unwrap();
        if kind.starts_with("named-") {
            // A safe legacy log must not hide an unsafe expected named log.
            fs::write(directory.join("status"), "0\n").unwrap();
            fs::set_permissions(directory.join("status"), fs::Permissions::from_mode(0o600))
                .unwrap();
        }
        match kind {
            "parent" | "directory" => {
                let path = if kind == "parent" {
                    &parent
                } else {
                    &directory
                };
                fs::rename(path, root.path().join("elsewhere")).unwrap();
                std::os::unix::fs::symlink(root.path().join("elsewhere"), path).unwrap();
            }
            "public" => fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap(),
            "large" => File::options()
                .write(true)
                .open(directory.join("output.log"))
                .unwrap()
                .set_len(8388609)
                .unwrap(),
            "named-directory" => fs::create_dir(directory.join("a.md.out")).unwrap(),
            "named-hardlink" => fs::hard_link(outside.path(), directory.join("a.md.out")).unwrap(),
            "named-public" | "named-large" => {
                let file = directory.join("a.md.out");
                fs::write(&file, "named output").unwrap();
                fs::set_permissions(
                    &file,
                    fs::Permissions::from_mode(if kind == "named-public" { 0o644 } else { 0o600 }),
                )
                .unwrap();
                if kind == "named-large" {
                    File::options()
                        .write(true)
                        .open(file)
                        .unwrap()
                        .set_len(8388609)
                        .unwrap();
                }
            }
            _ => {
                let file = directory.join(match kind {
                    "status" => "status",
                    "lease" => "lease",
                    "named-log" | "named-dangling" | "named-fifo" => "a.md.out",
                    _ => "output.log",
                });
                if file.exists() {
                    fs::remove_file(&file).unwrap();
                }
                if kind == "fifo" || kind == "named-fifo" {
                    nix::unistd::mkfifo(&file, nix::sys::stat::Mode::S_IRUSR).unwrap();
                } else if kind == "named-dangling" {
                    std::os::unix::fs::symlink(root.path().join("missing"), &file).unwrap();
                } else {
                    std::os::unix::fs::symlink(outside.path(), &file).unwrap();
                }
            }
        }
        assert!(remote.snapshot(&id, false, "a.md").await.is_err(), "{kind}");
        assert!(remote.snapshot(&id, true, "a.md").await.is_err(), "{kind}");
        assert_eq!(fs::read_to_string(outside.path()).unwrap(), "0\n");
    }
}

#[tokio::test]
async fn named_logs_preserve_and_quote_original_filenames_and_recover_without_metadata() {
    for name in [
        "a.md",
        "-a ' \" $(touch injected) `touch injected` ; & $name [*].md",
        "extensionless",
    ] {
        let root = tempfile::tempdir().unwrap();
        let remote = tests::remote_fixture(root.path(), &root.path().join("unused"));
        fs::write(
            root.path().join(".bash_aliases"),
            "spec() { cat -- \"$2\"; }\n",
        )
        .unwrap();
        let id = Uuid::new_v4().to_string();
        let mut child = remote
            .command(5, &id, name)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(b"hello").await.unwrap();
        let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        drop(stdin);
        assert!(output.status.success(), "{name:?}: {output:?}");
        assert_eq!(output.stdout, b"hello");
        let directory = root.path().join(format!(".spec-runs/run-{id}"));
        let log = directory.join(format!("{name}.out"));
        assert_eq!(fs::read(&log).unwrap(), b"hello");
        assert_eq!(
            fs::metadata(&log).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let mut files: Vec<_> = fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        files.sort();
        let mut expected = vec![format!("{name}.out"), "lease".into(), "status".into()];
        expected.sort();
        assert_eq!(files, expected);
        assert_eq!(
            remote.snapshot(&id, false, name).await.unwrap(),
            ("completed".into(), b"hello".to_vec(), false)
        );
        fs::write(directory.join("output.log"), "legacy output").unwrap();
        fs::set_permissions(
            directory.join("output.log"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        assert_eq!(remote.snapshot(&id, false, name).await.unwrap().1, b"hello");
        fs::remove_file(&log).unwrap();
        assert_eq!(
            remote.snapshot(&id, false, name).await.unwrap().1,
            b"legacy output"
        );
        assert!(!root.path().join("injected").exists());
    }
}

#[tokio::test]
async fn invalid_spec_names_cannot_launch_or_recover_even_through_direct_scripts() {
    let root = tempfile::tempdir().unwrap();
    let remote = tests::remote_fixture(root.path(), &root.path().join("unused"));
    fs::write(
        root.path().join(".bash_aliases"),
        "spec() { touch launched; }\n",
    )
    .unwrap();
    let parent = root.path().join(".spec-runs");
    let id = Uuid::new_v4().to_string();
    let directory = parent.join(format!("run-{id}"));
    fs::create_dir(&parent).unwrap();
    fs::create_dir(&directory).unwrap();
    for dir in [&parent, &directory] {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).unwrap();
    }
    for (file, content) in [("output.log", "legacy output"), ("status", "0\n")] {
        fs::write(directory.join(file), content).unwrap();
        fs::set_permissions(directory.join(file), fs::Permissions::from_mode(0o600)).unwrap();
    }
    for name in [
        "",
        ".",
        "..",
        "../escape",
        "/tmp/escape",
        "nested/file.md",
        "nested\\file.md",
        "bad\nname.md",
    ] {
        for direct in [false, true] {
            let launch_id = Uuid::new_v4().to_string();
            let mut command = if direct {
                let mut command = tokio::process::Command::new("bash");
                command.env("HOME", root.path()).args([
                    "-c",
                    include_str!("remote-build.bash"),
                    "--",
                    &remote.directory,
                    "0",
                    include_str!("remote-alias.bash"),
                    include_str!("remote-supervisor.bash"),
                    &launch_id,
                    name,
                ]);
                command
            } else {
                remote.command(0, &launch_id, name)
            };
            let mut child = command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            // Keep the attachment alive so EOF cannot masquerade as rejection.
            let stdin = child.stdin.take().unwrap();
            let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
                .await
                .unwrap()
                .unwrap();
            drop(stdin);
            assert_eq!(
                output.status.code(),
                Some(125),
                "{name:?}, direct={direct}: {output:?}"
            );
            assert!(!parent.join(format!("run-{launch_id}")).exists());
            assert!(!root.path().join("launched").exists());
        }
        for cancel in [false, true] {
            assert!(
                remote.snapshot(&id, cancel, name).await.is_err(),
                "{name:?}"
            );
            let output = tokio::process::Command::new("bash")
                .args([
                    "-c",
                    include_str!("remote-recover.bash"),
                    "--",
                    &remote.directory,
                    &id,
                    if cancel { "cancel" } else { "snapshot" },
                    name,
                ])
                .output()
                .await
                .unwrap();
            assert_eq!(output.status.code(), Some(125), "{name:?}: {output:?}");
            assert!(output.stdout.is_empty(), "{name:?}");
        }
    }
    assert!(!directory.join("cancel").exists());
    assert_eq!(
        fs::read_to_string(directory.join("output.log")).unwrap(),
        "legacy output"
    );
}

#[tokio::test]
async fn stable_remote_id_refuses_duplicate_launch_even_after_completion() {
    let root = tempfile::tempdir().unwrap();
    let remote = tests::remote_fixture(root.path(), &root.path().join("unused"));
    fs::write(
        root.path().join(".bash_aliases"),
        "spec() { printf 'launch\\n' >> launches; printf 'original output'; }\n",
    )
    .unwrap();
    let id = Uuid::new_v4().to_string();
    for duplicate in [false, true] {
        let mut child = remote
            .command(5, &id, "a.md")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let _ = stdin.write_all(b"hello").await;
        let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        drop(stdin);
        assert_eq!(output.status.code(), Some(if duplicate { 125 } else { 0 }));
    }
    assert_eq!(
        fs::read_to_string(root.path().join("launches")).unwrap(),
        "launch\n"
    );
    let (status, output, _) = remote.snapshot(&id, false, "a.md").await.unwrap();
    assert_eq!(status, "completed");
    assert_eq!(output, b"original output");
}

#[tokio::test]
async fn recovery_rejects_missing_malformed_and_oversized_ssh_responses() {
    let root = tempfile::tempdir().unwrap();
    let remote = tests::remote_fixture(root.path(), &root.path().join("unused"));
    for script in [
        "exit 0",
        "printf 'SPEC-RUN-1 invalid 0\\n'",
        "printf 'SPEC-RUN-1 256 0\\n'",
        "printf 'SPEC-RUN-1 0 maybe\\n'",
        "head -c 300000 /dev/zero",
        "head -c 5000 /dev/zero >&2",
        "printf 'SPEC-RUN-1 0 0\\n'; exit 255",
    ] {
        fs::write(&remote.binary, format!("#!/bin/bash\n{script}\n")).unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            remote.snapshot(&Uuid::new_v4().to_string(), false, "a.md"),
        )
        .await
        .unwrap();
        assert!(result.is_err(), "{script}");
    }
}

#[test]
fn remote_alias_completion_instructions_are_scoped_merged_and_private() {
    let mut runtimes_tested = 0;
    for runtime in ["bun", "node"] {
        let found = std::process::Command::new("bash")
            .args(["-c", &format!("type -P {runtime}")])
            .output()
            .unwrap();
        if !found.status.success() {
            eprintln!("{runtime} not installed; testing the other runtime only");
            continue;
        }
        runtimes_tested += 1;
        let executable = String::from_utf8(found.stdout).unwrap();
        for (content, status, error) in [
            (None, 0, None),
            (Some("{}"), 7, None),
            (Some(r#"{"instructions":[]}"#), 0, None),
            (
                Some(
                    r#"{"$schema":"https://opencode.ai/config.json","instructions":["AGENTS.md","/custom/a ' file.md"],"model":"provider/model","provider":{"provider":{"options":{"apiKey":"keep-secret"}}},"permission":{"edit":"ask"},"agent":{"build":{"prompt":"keep default customization"}},"custom":{"nested":[true,1,null]}}"#,
                ),
                42,
                None,
            ),
            (Some("{"), 125, Some("valid JSON")),
            (Some(""), 125, Some("valid JSON")),
            (Some("null"), 125, Some("JSON object")),
            (Some("[]"), 125, Some("JSON object")),
            (Some(r#"{"instructions":null}"#), 125, Some("string array")),
            (
                Some(r#"{"instructions":"AGENTS.md"}"#),
                125,
                Some("string array"),
            ),
            (Some(r#"{"instructions":[1]}"#), 125, Some("string array")),
        ] {
            let root = tempfile::tempdir().unwrap();
            let bin = root.path().join("runtime bin");
            fs::create_dir(&bin).unwrap();
            std::os::unix::fs::symlink(executable.trim(), bin.join(runtime)).unwrap();
            for utility in ["mktemp", "rm"] {
                std::os::unix::fs::symlink(format!("/usr/bin/{utility}"), bin.join(utility))
                    .unwrap();
            }
            let run = root.path().join("run ' \" $literal ; space");
            fs::create_dir(&run).unwrap();
            fs::set_permissions(&run, fs::Permissions::from_mode(0o700)).unwrap();
            let snapshot = run.join("snapshot ' $.md");
            let spec = "pending\n  # completed\n#\n## Heading\n### Subheading\ninline # hash\n#tag\n```sh\n# code\n```\n~~~\n# code\n~~~\n    # indented code\nreopened\n";
            fs::write(&snapshot, spec).unwrap();
            let config_setup = content.map_or_else(
                || "unset OPENCODE_CONFIG_CONTENT".to_owned(),
                |value| {
                    format!(
                        "OPENCODE_CONFIG_CONTENT='{}'",
                        value.replace('\'', "'\"'\"'")
                    )
                },
            );
            fs::write(
                root.path().join(".bash_aliases"),
                format!(
                    r#"export PATH="$HOME/runtime bin"
{config_setup}
alias spec=fixture_build
fixture_build() {{
    printf launched > "$HOME/launched"
    "$TEST_RUNTIME" -e '
const fs = require("node:fs");
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const path = config.instructions[config.instructions.length - 1];
process.stdout.write(JSON.stringify({{
    args: process.argv.slice(1), config, path,
    instructions: fs.readFileSync(path, "utf8"),
    mode: fs.statSync(path).mode & 0o777,
    snapshot: fs.readFileSync(process.argv[2], "utf8"),
    configFile: process.env.OPENCODE_CONFIG
}}));
' "$@"
    exit {status}
}}
"#
                ),
            )
            .unwrap();
            let output = std::process::Command::new("/bin/bash")
                .args([
                    "--noprofile",
                    "--norc",
                    "-c",
                    include_str!("remote-alias.bash"),
                    "--",
                ])
                .arg(&snapshot)
                .arg(run.join("ready"))
                .env("HOME", root.path())
                .env("PATH", "/nonexistent")
                .env("TEST_RUNTIME", executable.trim())
                .env("OPENCODE_CONFIG_CONTENT", "aliases must be sourced first")
                .env("OPENCODE_CONFIG", "/unchanged/config.json")
                .output()
                .unwrap();
            assert_eq!(
                output.status.code(),
                Some(status),
                "{runtime}: {:?}",
                output
            );
            assert_eq!(fs::read_to_string(&snapshot).unwrap(), spec);
            assert_eq!(
                fs::read_dir(&run).unwrap().count(),
                2,
                "instruction file leaked"
            );
            if let Some(error) = error {
                assert!(String::from_utf8_lossy(&output.stderr).contains(error));
                assert!(!root.path().join("launched").exists());
                assert!(output.stdout.is_empty());
                continue;
            }
            let observed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(observed["args"], serde_json::json!(["build", snapshot]));
            assert_eq!(observed["snapshot"], spec);
            assert_eq!(observed["mode"], 0o600);
            assert_eq!(observed["configFile"], "/unchanged/config.json");
            let path = PathBuf::from(observed["path"].as_str().unwrap());
            assert!(path.is_absolute());
            assert_eq!(path.parent().unwrap(), run);
            assert!(!path.exists());
            let mut expected: serde_json::Value =
                serde_json::from_str(content.unwrap_or("{}")).unwrap();
            let mut instructions = expected["instructions"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            instructions.push(serde_json::json!(path));
            expected["instructions"] = serde_json::json!(instructions);
            assert_eq!(observed["config"], expected);
            let text = observed["instructions"].as_str().unwrap();
            for rule in [
                "after optional indentation",
                "completed, not pending",
                "Preserve completed text as context",
                "Do not implement completed requirements again",
                "reopened by removing the completion marker",
                "only to the marked line",
                "completed blank line",
                "remain Markdown",
                "Inline hashes",
                "fenced code blocks",
                "indented\ncode blocks",
                "inline code",
            ] {
                assert!(text.contains(rule), "missing convention: {rule}");
            }
        }
    }
    assert!(
        runtimes_tested > 0,
        "remote alias tests require Bun or Node.js on PATH"
    );
}

#[test]
fn remote_alias_reports_missing_instruction_runtime_before_launch() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join(".bash_aliases"),
        "PATH=/nonexistent\nspec() { printf launched > \"$HOME/launched\"; }\n",
    )
    .unwrap();
    let output = std::process::Command::new("/bin/bash")
        .args(["-c", include_str!("remote-alias.bash"), "--"])
        .arg(root.path().join("snapshot.md"))
        .arg(root.path().join("ready"))
        .env("HOME", root.path())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(127));
    assert!(String::from_utf8_lossy(&output.stderr).contains("require Bun or Node.js on PATH"));
    assert!(!root.path().join("launched").exists());
}
