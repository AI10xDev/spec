use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::Path,
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn server(root: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_spec"));
    command
        .env_clear()
        .current_dir(root)
        .env("HOME", root)
        .env("SPEC_WORKSPACE", root.join("workspace"))
        .env("SPEC_UI_DIR", root.join("ui"))
        .env("SPEC_SETTINGS_FILE", root.join("settings/profile.json"))
        .env("SPEC_AI_ENV_FILE", "/dev/null")
        .env("SPEC_PORT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

fn private_file(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

#[tokio::test]
async fn auth_file_survives_restarts_without_startup_token_output() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("token");
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    for bytes in [TOKEN.to_owned(), format!("{TOKEN}\n")] {
        private_file(&path, bytes.as_bytes());
        for _ in 0..2 {
            let mut child = server(root.path())
                .env("SPEC_AUTH_TOKEN_FILE", &path)
                .spawn()
                .unwrap();
            let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
            let line = tokio::time::timeout(Duration::from_secs(10), stdout.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let url = line.strip_prefix("Spec: ").unwrap();
            assert!(url.starts_with("http://127.0.0.1:"));
            assert!(!url.contains('#'));
            for (token, status) in [(Some(TOKEN), 200), (None, 401), (Some("wrong-token"), 401)] {
                let mut request = client.get(format!("{url}api/config"));
                if let Some(token) = token {
                    request = request.bearer_auth(token);
                }
                let response = request.send().await.unwrap();
                assert_eq!(response.status().as_u16(), status);
                assert_eq!(response.headers()["cache-control"], "no-store");
            }
            child.kill().await.unwrap();
            let mut output = line;
            while let Some(line) = stdout.next_line().await.unwrap() {
                output.push_str(&line);
            }
            let remaining = child.wait_with_output().await.unwrap();
            output.push_str(&String::from_utf8(remaining.stderr).unwrap());
            assert!(output.contains("external auth configuration"));
            assert!(!output.contains(TOKEN));
            assert!(!output.contains("#token="));
            assert_eq!(fs::read(&path).unwrap(), bytes.as_bytes());
        }
    }
}

#[tokio::test]
async fn auth_file_invalid_configuration_fails_closed_without_creating_or_leaking() {
    for case in [
        "empty-path",
        "relative",
        "raw-token",
        "missing",
        "missing-parent",
        "empty-file",
        "malformed",
        "nonprivate-file",
        "nonprivate-parent",
        "symlink-file",
        "symlink-parent",
        "hardlink",
        "directory",
        "workspace",
        "ui",
        "ui-alias",
        "workspace-alias",
    ] {
        let root = tempfile::tempdir().unwrap();
        let private = root.path().join("private");
        fs::create_dir(&private).unwrap();
        fs::set_permissions(&private, fs::Permissions::from_mode(0o700)).unwrap();
        let mut path = private.join("token");
        private_file(&path, TOKEN.as_bytes());
        let mut command = server(root.path());
        match case {
            "empty-path" => path = "".into(),
            "relative" => path = "private/token".into(),
            "raw-token" => path = TOKEN.into(),
            "missing" => path = private.join("missing"),
            "missing-parent" => path = root.path().join("absent/token"),
            "empty-file" => private_file(&path, b""),
            "malformed" => private_file(&path, b"auth-fixture-secret-invalid"),
            "nonprivate-file" => {
                fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            }
            "nonprivate-parent" => {
                fs::set_permissions(&private, fs::Permissions::from_mode(0o755)).unwrap();
            }
            "symlink-file" => {
                let link = private.join("link");
                symlink(&path, &link).unwrap();
                path = link;
            }
            "symlink-parent" => {
                let link = root.path().join("link");
                symlink(&private, &link).unwrap();
                path = link.join("token");
            }
            "hardlink" => fs::hard_link(&path, private.join("link")).unwrap(),
            "directory" => path = private.clone(),
            "workspace" | "ui" => {
                let served = root.path().join(case);
                fs::rename(&private, &served).unwrap();
                path = served.join("token");
            }
            "ui-alias" | "workspace-alias" => {
                let alias = root.path().join("alias");
                symlink(&private, &alias).unwrap();
                command.env(
                    if case == "ui-alias" {
                        "SPEC_UI_DIR"
                    } else {
                        "SPEC_WORKSPACE"
                    },
                    alias,
                );
            }
            _ => unreachable!(),
        }
        let output = tokio::time::timeout(
            Duration::from_secs(10),
            command.env("SPEC_AUTH_TOKEN_FILE", &path).output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!output.status.success(), "{case}");
        assert!(output.stdout.is_empty(), "{case}");
        let error = String::from_utf8(output.stderr).unwrap();
        assert!(
            error.contains("Could not load SPEC_AUTH_TOKEN_FILE:"),
            "{case}: {error}"
        );
        assert!(!error.contains(TOKEN), "{case}");
        assert!(!error.contains("auth-fixture-secret-invalid"), "{case}");
        assert!(!error.contains(root.path().to_str().unwrap()), "{case}");
        assert!(!root.path().join("absent").exists());
        assert!(!private.join("missing").exists());
        assert!(!root.path().join("settings").exists());
    }
}

#[tokio::test]
async fn auth_without_file_keeps_local_token_url_and_ignores_raw_env_token() {
    let root = tempfile::tempdir().unwrap();
    let mut previous = String::new();
    for _ in 0..2 {
        let mut child = server(root.path())
            .env("SPEC_AUTH_TOKEN", TOKEN)
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
        let line = tokio::time::timeout(Duration::from_secs(10), stdout.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let (url, token) = line
            .strip_prefix("Spec: ")
            .unwrap()
            .split_once("/#token=")
            .unwrap();
        assert!(url.starts_with("http://127.0.0.1:"));
        assert_eq!(token.len(), 64);
        assert_ne!(token, TOKEN);
        assert_ne!(token, previous);
        previous = token.into();
        child.kill().await.unwrap();
    }
}
