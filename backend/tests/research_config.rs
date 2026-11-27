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

async fn start_fixture(dir: &std::path::Path) -> (tokio::process::Child, String, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_spec"))
        .env_clear()
        .current_dir(dir)
        .env("SPEC_WORKSPACE", dir.join("workspace"))
        .env("SPEC_UI_DIR", dir.join("ui"))
        .env("SPEC_SETTINGS_FILE", dir.join("private/profile.json"))
        .env("SPEC_AI_ENV_FILE", "/dev/null")
        .env("EXA_API_KEY", "fake-environment-key")
        .env("SPEC_PORT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
    let line = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let (url, token) = line
        .strip_prefix("Spec: ")
        .unwrap()
        .split_once("/#token=")
        .unwrap();
    // Keep stdout open after the readiness line: subsequent startup prints must
    // not panic on a broken pipe. Discard output rather than logging the token.
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    (child, url.to_owned(), token.to_owned())
}

#[tokio::test]
async fn settings_persist_across_restart_and_corruption_disables_only_research() {
    let dir = tempfile::tempdir().unwrap();
    let client = reqwest::Client::new();
    let (mut child, url, token) = start_fixture(dir.path()).await;
    let preferences = serde_json::json!({"enabled":true,"numResults":1,"domainMode":"exclude","domains":["EXAMPLE.org"]});
    let response = client
        .put(format!("{url}/api/settings/research"))
        .bearer_auth(&token)
        .json(&serde_json::json!({"preferences":preferences,"apiKey":"fake-saved-key"}))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    assert!(!response.text().await.unwrap().contains("fake-"));
    child.kill().await.unwrap();
    child.wait().await.unwrap();
    let (mut child, url, token) = start_fixture(dir.path()).await;
    let view: Value = client
        .get(format!("{url}/api/settings/research"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(view["keySource"], "settings");
    assert_eq!(view["preferences"]["numResults"], 1);
    assert_eq!(
        view["preferences"]["domains"],
        serde_json::json!(["example.org"])
    );
    let status: Value = client
        .get(format!("{url}/api/research"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(status["configured"], true);
    let profile: Value = client
        .get(format!("{url}/api/settings"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(profile["source"], "none");
    child.kill().await.unwrap();
    child.wait().await.unwrap();
    std::fs::write(
        dir.path().join("private/profile.json.research.json"),
        "corrupt-fake-saved-key",
    )
    .unwrap();
    let (mut child, url, token) = start_fixture(dir.path()).await;
    let status: Value = client
        .get(format!("{url}/api/research"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(status["configured"], false); // must not fall back to environment
    assert!(status["message"].as_str().unwrap().contains("repair"));
    assert!(!status.to_string().contains("fake-"));
    for method in [reqwest::Method::GET, reqwest::Method::DELETE] {
        let response = client
            .request(method, format!("{url}/api/settings/research"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 503);
        assert!(!response.text().await.unwrap().contains("fake-"));
    }
    assert!(
        client
            .get(format!("{url}/api/files"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("private/profile.json.research.json")).unwrap(),
        "corrupt-fake-saved-key"
    );
    child.kill().await.unwrap();
    child.wait().await.unwrap();
}
