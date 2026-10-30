use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt},
    process::{Child, Command},
};

fn server(root: &Path, settings: Option<&Path>) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_spec"));
    command
        .env_clear()
        .current_dir(root)
        .env("SPEC_WORKSPACE", root.join("workspace"))
        .env("SPEC_UI_DIR", root.join("ui"))
        .env("SPEC_AI_ENV_FILE", "/dev/null")
        .env("SPEC_PORT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(settings) = settings {
        command.env("SPEC_SETTINGS_FILE", settings);
    }
    command
}

async fn start(command: &mut Command) -> (Child, String, String) {
    let mut child = command.spawn().unwrap();
    let line = {
        let mut lines = tokio::io::BufReader::new(child.stdout.as_mut().unwrap()).lines();
        tokio::time::timeout(Duration::from_secs(10), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
    };
    let (url, token) = line
        .strip_prefix("Spec: ")
        .unwrap()
        .split_once("/#token=")
        .unwrap();
    (child, url.into(), token.into())
}

async fn stop(mut child: Child) {
    child.kill().await.unwrap();
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .await
        .unwrap();
    assert!(!stderr.contains("settings-test-secret"));
}

#[tokio::test]
async fn settings_api_persists_across_server_restarts_and_stays_outside_served_roots() {
    for explicit in [false, true] {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("ui")).unwrap();
        let selected = root.path().join(".server-private/profile.json");
        let path = explicit.then_some(selected.as_path());
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let (child, url, token) = start(&mut server(root.path(), path)).await;
        let response = client.put(format!("{url}/api/settings")).bearer_auth(&token).json(&json!({
            "provider":"openai", "model":"gpt-5", "endpoint":"https://api.openai.com/v1", "apiVersion":"", "apiKey":"settings-test-secret"
        })).send().await.unwrap();
        assert!(response.status().is_success());
        assert_eq!(response.headers()["cache-control"], "no-store");
        let expected: Value = response.json().await.unwrap();
        assert_eq!(expected["source"], "settings");
        assert!(!expected.to_string().contains("settings-test-secret"));
        let repository: Value = client
            .get(format!("{url}/api/repository"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(repository["model"], "openai/gpt-5");
        stop(child).await;
        let (child, url, token) = start(&mut server(root.path(), path)).await;
        let actual: Value = client
            .get(format!("{url}/api/settings"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(actual, expected);
        let config: Value = client
            .get(format!("{url}/api/config"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(config["chat"], true);
        assert_eq!(config["completion"], true);
        let files: Value = client
            .get(format!("{url}/api/files"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(files, json!([]));
        for route in [
            "/profile.json",
            "/.server-private/profile.json",
            "/api/files/profile.json",
            "/api/files/profile.json/run/log",
        ] {
            let response = client
                .get(format!("{url}{route}"))
                .bearer_auth(&token)
                .send()
                .await
                .unwrap();
            if route.ends_with("/run/log") {
                assert_eq!(response.json::<Value>().await.unwrap(), Value::Null);
            } else {
                assert!(!response.status().is_success(), "{route}");
                assert!(
                    !response
                        .text()
                        .await
                        .unwrap()
                        .contains("settings-test-secret")
                );
            }
        }
        let cleared: Value = client
            .delete(format!("{url}/api/settings"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(cleared["source"], "none");
        assert_eq!(cleared["hasApiKey"], false);
        let repository: Value = client
            .get(format!("{url}/api/repository"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(repository["model"], "azure/gpt-6-sol");
        stop(child).await;
        let (child, url, token) = start(&mut server(root.path(), path)).await;
        let config: Value = client
            .get(format!("{url}/api/config"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(config["chat"], false);
        stop(child).await;
    }
}

#[tokio::test]
async fn saved_profile_survives_restart_with_invalid_environment_but_clearing_restores_failure() {
    for invalid in [
        "missing-file",
        "malformed-file",
        "partial",
        "invalid-endpoint",
    ] {
        let root = tempfile::tempdir().unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let (child, url, token) = start(&mut server(root.path(), None)).await;
        let expected: Value = client
            .put(format!("{url}/api/settings"))
            .bearer_auth(&token)
            .json(&json!({
                "provider": "openai", "model": "gpt-5", "endpoint": "https://api.openai.com/v1",
                "apiVersion": "", "apiKey": "settings-test-secret"
            }))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        stop(child).await;

        let mut command = server(root.path(), None);
        match invalid {
            "missing-file" | "malformed-file" => {
                let file = root.path().join("ai.env");
                if invalid == "malformed-file" {
                    fs::write(&file, "AZURE_OPENAI_API_KEY='settings-test-secret\n").unwrap();
                }
                command.env("SPEC_AI_ENV_FILE", file);
            }
            _ => {
                command.env("AZURE_OPENAI_API_KEY", "settings-test-secret");
                if invalid == "invalid-endpoint" {
                    command.env("AZURE_OPENAI_ENDPOINT", "invalid");
                }
            }
        }
        let (child, url, token) = start(&mut command).await;
        let actual: Value = client
            .get(format!("{url}/api/settings"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(actual, expected, "{invalid}");
        let config: Value = client
            .get(format!("{url}/api/config"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(config["chat"], true, "{invalid}");
        assert_eq!(config["completion"], true, "{invalid}");
        let cleared: Value = client
            .delete(format!("{url}/api/settings"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(cleared["source"], "none", "{invalid}");
        stop(child).await;

        let output = tokio::time::timeout(Duration::from_secs(10), command.output())
            .await
            .unwrap()
            .unwrap();
        assert!(!output.status.success(), "{invalid}");
        assert!(!String::from_utf8_lossy(&output.stderr).contains("settings-test-secret"));
        assert!(!String::from_utf8_lossy(&output.stdout).contains("settings-test-secret"));
    }
}

#[tokio::test]
async fn settings_startup_rejects_unsafe_locations_without_printing_contents() {
    for location in [
        "workspace/settings-test-secret.out",
        "ui/settings-test-secret.json",
        ".public/settings-test-secret.json",
        ".private/settings-test-secret.json",
    ] {
        let root = tempfile::tempdir().unwrap();
        for dir in ["ui", ".public", ".private"] {
            fs::create_dir(root.path().join(dir)).unwrap();
        }
        fs::set_permissions(
            root.path().join(".private"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        fs::set_permissions(
            root.path().join(".public"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let path = root.path().join(location);
        if location.starts_with(".private") {
            fs::write(&path, "malformed settings-test-secret").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let output = tokio::time::timeout(
            Duration::from_secs(10),
            server(root.path(), Some(&path)).output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stderr).contains("settings-test-secret"));
        assert!(!String::from_utf8_lossy(&output.stdout).contains("settings-test-secret"));
    }
}
