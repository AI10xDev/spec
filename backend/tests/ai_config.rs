use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncBufReadExt, process::Command};

const SETTINGS: &str = "export AZURE_OPENAI_ENDPOINT='https://azure.test/openai/v1'\nAZURE_OPENAI_API_KEY=mock-secret\nDEPLOYMENT_NAME=test-model\n";

fn server(directory: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_spec"));
    command
        .env_clear()
        .current_dir(directory)
        .env("SPEC_WORKSPACE", directory)
        .env("SPEC_PORT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

async fn assert_config(mut command: Command, enabled: bool) {
    let mut child = command.spawn().unwrap();
    let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
    let address = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .expect("server should start");
    let (url, token) = address
        .strip_prefix("Spec: ")
        .unwrap()
        .split_once("/#token=")
        .unwrap();
    let response = reqwest::Client::new()
        .get(format!("{url}/api/config"))
        .bearer_auth(token)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let config: Value = response.json().await.unwrap();
    assert_eq!(
        config,
        json!({
            "execution": false,
            "completion": enabled,
            "chat": enabled,
            "realtime": false,
            "azureRealtime": false,
        })
    );
    child.kill().await.unwrap();
}

#[tokio::test]
async fn repository_dotenv_enables_both_features_from_backend_directory() {
    let root = tempfile::tempdir().unwrap();
    let backend = root.path().join("backend");
    std::fs::create_dir(&backend).unwrap();
    std::fs::write(root.path().join(".env"), SETTINGS).unwrap();
    assert_config(server(&backend), true).await;
}

#[tokio::test]
async fn explicit_file_and_exported_overrides_enable_both_features() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("ai.env");
    std::fs::write(
        &file,
        SETTINGS.replace("https://azure.test/openai/v1", "invalid"),
    )
    .unwrap();
    let mut command = server(root.path());
    command
        .env("SPEC_AI_ENV_FILE", &file)
        .env("AZURE_OPENAI_ENDPOINT", "https://override.test/openai/v1");
    assert_config(command, true).await;
}

#[tokio::test]
async fn empty_file_disables_both_features() {
    let root = tempfile::tempdir().unwrap();
    let mut command = server(root.path());
    command.env("SPEC_AI_ENV_FILE", "/dev/null");
    assert_config(command, false).await;
}

#[tokio::test]
async fn missing_partial_and_malformed_files_fail_without_exposing_keys() {
    for (settings, expected) in [
        (None, "Could not read SPEC_AI_ENV_FILE"),
        (
            Some("AZURE_OPENAI_API_KEY=mock-secret\n"),
            "Set AZURE_OPENAI_ENDPOINT",
        ),
        (
            Some("AZURE_OPENAI_API_KEY='mock-secret\n"),
            "Invalid AI settings file",
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("ai.env");
        if let Some(settings) = settings {
            std::fs::write(&file, settings).unwrap();
        }
        let output = tokio::time::timeout(
            Duration::from_secs(10),
            server(root.path()).env("SPEC_AI_ENV_FILE", &file).output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!output.status.success());
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.contains(expected), "{stderr}");
        assert!(!stderr.contains("mock-secret"));
        assert!(
            !String::from_utf8(output.stdout)
                .unwrap()
                .contains("mock-secret")
        );
    }
}
