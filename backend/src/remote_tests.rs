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
fn ssh_is_noninteractive_with_host_verification_and_no_forwarding() {
    let remote = Remote {
        binary: "/usr/bin/ssh".into(),
        target: "user@host".into(),
        directory: "/remote/project".into(),
        key: Some("/local/key with spaces".into()),
    };
    let command = remote.command(42);
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
async fn truncated_upload_never_starts_build_and_removes_snapshot() {
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
        0
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
            .command(5)
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
    for (install, status) in [
        (".local/bin", 0),
        (".bun/bin", 0),
        ("custom engine/bin", 42),
        ("missing", 127),
    ] {
        let root = tempfile::tempdir().unwrap();
        let runner = root.path().join("run-spec.sh");
        let remote = tests::remote_fixture(root.path(), &runner);
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
            definition.push_str("export PATH=/nonexistent\n");
        }
        fs::write(aliases, definition).unwrap();
        let mut child = remote
            .command(5)
            .env("PATH", "/usr/bin:/bin")
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
        assert_eq!(output.status.code(), Some(status), "{install}");
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
        .command(5)
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
    assert_eq!(fs::read_dir(directory).unwrap().count(), 2);
    let log = fs::read(directory.join("output.log")).unwrap();
    assert_eq!(log.len(), 8 * 1024 * 1024);
    assert!(log.starts_with(b"output after disconnect\n"));
    for (path, mode) in [
        (directory.to_owned(), 0o700),
        (directory.join("status"), 0o600),
        (directory.join("output.log"), 0o600),
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
        .command(5)
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
        .command(5)
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
            .command(5)
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
