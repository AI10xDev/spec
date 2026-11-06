use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncBufReadExt, process::Command};

fn server(root: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_spec"));
    command
        .env_clear()
        .current_dir(root)
        .env("SPEC_WORKSPACE", root.join("editor"))
        .env("SPEC_PORT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

#[tokio::test]
async fn computeruse_absent_is_disabled_partial_and_invalid_fail_startup() {
    let root = tempfile::tempdir().unwrap();
    let mut child = server(root.path()).spawn().unwrap();
    let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
    let address = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let (url, token) = address
        .strip_prefix("Spec: ")
        .unwrap()
        .split_once("/#token=")
        .unwrap();
    let client = reqwest::Client::new();
    let response: serde_json::Value = client
        .get(format!("{url}/api/computeruse"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        response,
        serde_json::json!({"configured":false,"local_path":null,"remote_path":null,"run":null})
    );
    child.kill().await.unwrap();

    for case in [
        "partial",
        "no-remote",
        "invalid-json",
        "relative",
        "no-placeholder",
        "duplicate",
        "embedded",
        "not-executable",
    ] {
        let mut command = server(root.path());
        command.env("SPEC_COMPUTERUSE_LOCAL_FILE", root.path().join("local"));
        if case != "partial" {
            command
                .env("SPEC_COMPUTERUSE_REMOTE_FILE", "/operator/remote.txt")
                .env(
                    "SPEC_COMPUTERUSE_COMMAND",
                    "[\"/usr/bin/cat\",\"{instructions}\"]",
                );
        }
        if case != "no-remote" {
            command
                .env("SPEC_SSH_TARGET", "fixture")
                .env("SPEC_SSH_WORKSPACE", "/operator/workspace");
        }
        match case {
            "invalid-json" => {
                command.env("SPEC_COMPUTERUSE_COMMAND", "not JSON");
            }
            "relative" => {
                command.env("SPEC_COMPUTERUSE_LOCAL_FILE", "relative.txt");
            }
            "no-placeholder" => {
                command.env("SPEC_COMPUTERUSE_COMMAND", "[\"/usr/bin/cat\"]");
            }
            "duplicate" => {
                command.env(
                    "SPEC_COMPUTERUSE_COMMAND",
                    "[\"/usr/bin/cat\",\"{instructions}\",\"{instructions}\"]",
                );
            }
            "embedded" => {
                command.env(
                    "SPEC_COMPUTERUSE_COMMAND",
                    "[\"/usr/bin/cat\",\"--file={instructions}\"]",
                );
            }
            "not-executable" => {
                command.env(
                    "SPEC_COMPUTERUSE_COMMAND",
                    "[\"/does/not/exist\",\"{instructions}\"]",
                );
            }
            _ => {}
        }
        let output = tokio::time::timeout(Duration::from_secs(5), command.output())
            .await
            .unwrap()
            .unwrap();
        assert!(!output.status.success(), "{case}");
        assert!(
            !String::from_utf8_lossy(&output.stdout).contains("Spec: "),
            "{case}"
        );
    }
}

#[tokio::test]
async fn computeruse_valid_config_starts_without_contacting_remote_or_callback() {
    let root = tempfile::tempdir().unwrap();
    let mut command = server(root.path());
    command
        .env("SPEC_SSH_TARGET", "not-contacted.invalid")
        .env("SPEC_SSH_WORKSPACE", "/operator/workspace")
        .env("SPEC_COMPUTERUSE_LOCAL_FILE", root.path().join("local"))
        .env("SPEC_COMPUTERUSE_REMOTE_FILE", "/operator/remote")
        .env(
            "SPEC_COMPUTERUSE_COMMAND",
            "[\"/usr/bin/false\",\"{instructions}\"]",
        );
    let mut child = command.spawn().unwrap();
    let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
    let address = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let (url, token) = address
        .strip_prefix("Spec: ")
        .unwrap()
        .split_once("/#token=")
        .unwrap();
    let response: serde_json::Value = reqwest::Client::new()
        .get(format!("{url}/api/computeruse"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["configured"], true);
    assert!(response["run"].is_null());
    assert!(!root.path().join("local").exists());
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id().unwrap() as i32),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}
