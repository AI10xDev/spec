use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncBufReadExt, process::Command};

fn server(root: &Path, workspace: &Path, umask: u32) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_spec"));
    command
        .env_clear()
        .current_dir(root)
        .env("HOME", root)
        .env("SPEC_AI_ENV_FILE", "/dev/null")
        .env("SPEC_WORKSPACE", workspace)
        .env("SPEC_PORT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Change only the child process umask, never the parallel test process.
    unsafe {
        command.pre_exec(move || {
            nix::libc::umask(umask);
            Ok(())
        });
    }
    command
}

async fn starts(mut command: Command) {
    let mut child = command.spawn().unwrap();
    let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
    let line = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
        .await
        .unwrap()
        .unwrap();
    // Reap even when startup fails, so the regression failure leaves no server.
    let _ = child.kill().await;
    assert!(
        line.is_some_and(|line| line.starts_with("Spec: http://127.0.0.1:")),
        "server did not start"
    );
}

#[tokio::test]
async fn direct_start_creates_private_workspace_under_permissive_umasks() {
    for umask in [0o000, 0o002, 0o022] {
        let root = tempfile::tempdir().unwrap();
        let existing = root.path().join("existing");
        fs::create_dir(&existing).unwrap();
        fs::set_permissions(&existing, fs::Permissions::from_mode(0o755)).unwrap();
        let parent = existing.join("new-parent");
        let workspace = parent.join("workspace");
        starts(server(root.path(), &workspace, umask)).await;
        for directory in [&parent, &workspace] {
            assert_eq!(
                fs::metadata(directory).unwrap().permissions().mode() & 0o777,
                0o700,
                "umask {umask:o}"
            );
        }
        assert_eq!(
            fs::metadata(existing).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
}

#[tokio::test]
async fn direct_start_preserves_existing_workspace_permissions_and_rejects_unsafe_modes() {
    for mode in [0o700, 0o755, 0o775, 0o777] {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        fs::set_permissions(&workspace, fs::Permissions::from_mode(mode)).unwrap();
        let mut command = server(root.path(), &workspace, 0o022);
        if mode & 0o022 == 0 {
            starts(command).await;
        } else {
            let result = tokio::time::timeout(Duration::from_secs(5), command.output())
                .await
                .unwrap()
                .unwrap();
            assert!(!result.status.success());
            assert!(
                String::from_utf8_lossy(&result.stderr)
                    .contains("Workspace must not be writable by group/others")
            );
            assert!(!workspace.join(".spec.lock").exists());
        }
        assert_eq!(
            fs::metadata(&workspace).unwrap().permissions().mode() & 0o777,
            mode
        );
    }
}
