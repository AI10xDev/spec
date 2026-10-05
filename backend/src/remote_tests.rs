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
    // Observe the directory created by the actual remote supervisor without
    // inspecting unrelated /tmp snapshots from other processes.
    let script = include_str!("remote-build.bash").replace(
        "pid=\n",
        "printf '%s' \"$directory\" > snapshot-directory\npid=\n",
    );
    let mut child = tokio::process::Command::new("bash")
        .args([
            "-c",
            &script,
            "--",
            &remote.directory,
            "100",
            include_str!("remote-alias.bash"),
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
    let directory = fs::read_to_string(root.path().join("snapshot-directory")).unwrap();
    assert!(!FsPath::new(&directory).exists());
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
                String::from_utf8_lossy(&output.stderr)
                    .contains("spec alias/function/launcher not found")
            );
        }
    }
}

#[tokio::test]
async fn remote_watchdog_and_lost_connection_clean_up_without_local_signals() {
    for disconnect in [false, true] {
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
        let script = include_str!("remote-build.bash").replace("SECONDS >= 900", "SECONDS >= 1");
        let mut child = tokio::process::Command::new("bash")
            .env("HOME", root.path())
            .args([
                "-c",
                &script,
                "--",
                root.path().to_str().unwrap(),
                "5",
                include_str!("remote-alias.bash"),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(b"hello").await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !root.path().join("descendant-pid").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let lease = if disconnect {
            drop(stdin);
            None
        } else {
            Some(stdin)
        };
        let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        drop(lease);
        assert_eq!(
            output.status.code(),
            Some(if disconnect { 125 } else { 124 })
        );
        let snapshot = fs::read_to_string(root.path().join("snapshot-path")).unwrap();
        assert!(!FsPath::new(&snapshot).parent().unwrap().exists());
        let pid = fs::read_to_string(root.path().join("descendant-pid")).unwrap();
        if let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) {
            assert_eq!(stat.split(") ").nth(1).unwrap().chars().next(), Some('Z'));
        }
    }
}
