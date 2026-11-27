//! Process-level tests use only fake credentials and never submit research.
use serde_json::Value;
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt},
    process::Command,
};

#[tokio::test]
async fn exa_configuration_is_optional_isolated_and_exports_override_file() {
    for (file, export, enabled) in [
        ("", None, false),
        ("EXA_API_KEY=fake-file-secret\n", None, true),
        ("EXA_API_KEY=fake-file-secret\n", Some(""), false),
        ("EXA_API_KEY='invalid fake-secret'\n", None, false),
        (
            "EXA_API_KEY='invalid fake-secret'\n",
            Some("fake-export-secret"),
            true,
        ),
        ("", Some("bad\nfake-secret"), false),
    ] {
        let root = tempfile::tempdir().unwrap();
        let settings = root.path().join("ai.env");
        std::fs::write(&settings, file).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_spec"));
        command
            .env_clear()
            .current_dir(root.path())
            .env("SPEC_WORKSPACE", root.path())
            .env("SPEC_PORT", "0")
            .env("SPEC_AI_ENV_FILE", &settings)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(export) = export {
            command.env("EXA_API_KEY", export);
        }
        let mut child = command.spawn().unwrap();
        let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
        let address = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
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
        let response = client
            .get(format!("{url}/api/research"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        let text = response.text().await.unwrap();
        assert!(!text.contains("fake-"));
        let status: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(status["configured"], enabled);
        let config: Value = client
            .get(format!("{url}/api/config"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(config["completion"], false);
        assert_eq!(config["execution"], false);
        assert!(
            client
                .get(format!("{url}/api/files"))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .status()
                .is_success()
        );
        child.kill().await.unwrap();
        let mut stderr = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .await
            .unwrap();
        assert!(
            !stderr.contains("fake-secret")
                && !stderr.contains("fake-file-secret")
                && !stderr.contains("fake-export-secret")
        );
    }
}
