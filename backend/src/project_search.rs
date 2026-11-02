use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    query: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Project {
    name: String,
    path: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchResult {
    projects: Vec<Project>,
    truncated: bool,
    agent: String,
    root: String,
}

pub async fn search(
    State(app): State<App>,
    Json(input): Json<Query>,
) -> Result<Json<SearchResult>> {
    let query = input.query.trim();
    if query.is_empty()
        || query.len() > 100
        || query.chars().any(char::is_control)
        || query.contains(['/', '\\'])
        || matches!(query, "." | "..")
    {
        return Err(invalid(
            "Search needs a printable project name of 1-100 UTF-8 bytes, not a path",
        ));
    }
    let remote = app.remote.as_ref().ok_or_else(|| {
        Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Remote execution is disabled".into(),
        )
    })?;
    let _permit = app
        .project_search_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            Error(
                StatusCode::TOO_MANY_REQUESTS,
                "A project search is already active. Wait for it to finish before retrying.".into(),
            )
        })?;
    // Credentials are framed on stdin, never in SSH argv, logs, or run storage.
    let payload = serde_json::to_vec(&serde_json::json!({
        "query": query,
        "profile": app.settings.profile(),
        "provider_script": include_str!("remote-provider.bash"),
    }))
    .map_err(|_| invalid("Cannot encode project search settings"))?;
    if payload.len() > 256 * 1024 {
        return Err(invalid("Project search settings exceed the request limit"));
    }
    let mut child = remote
        .project_search_command()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| {
            Error(
                StatusCode::BAD_GATEWAY,
                "Could not start remote project search".into(),
            )
        })?;
    struct Group(u32);
    impl Drop for Group {
        fn drop(&mut self) {
            let _ = killpg(Pid::from_raw(self.0 as i32), Signal::SIGKILL);
        }
    }
    let _group = Group(child.id().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let response = tokio::time::timeout(Duration::from_secs(55), async {
        async fn bounded(stream: impl AsyncRead + Unpin, limit: usize) -> std::result::Result<Vec<u8>, &'static str> {
            let mut bytes = Vec::new();
            stream.take((limit + 1) as u64).read_to_end(&mut bytes).await
                .map_err(|_| "Could not read project search response")?;
            if bytes.len() > limit {
                return Err("Project search response exceeded its size limit");
            }
            Ok(bytes)
        }
        let ((), out, _) = tokio::try_join!(
            async {
                stdin.write_all(&payload).await.map_err(|_| "Could not upload project search settings")?;
                stdin.shutdown().await.map_err(|_| "Could not finish project search upload")?;
                drop(stdin);
                Ok(())
            },
            bounded(stdout, 128 * 1024),
            bounded(stderr, 4096),
        )?;
        let status = child.wait().await.map_err(|_| "Could not read project search exit status")?;
        if !status.success() {
            // Raw remote/provider diagnostics can contain credentials or config.
            return Err("Explore project search failed. Check the remote workspace, OpenCode installation and AI provider settings; the remote search has a 45-second deadline.");
        }
        let result: SearchResult = serde_json::from_slice(&out).map_err(|_| "Invalid project search response")?;
        let valid_path = |value: &str| value.starts_with('/') && value.len() <= 4096
            && !value.chars().any(char::is_control)
            && !FsPath::new(value).components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::CurDir));
        if result.agent != "explore" || result.projects.len() > 20 || !valid_path(&result.root) {
            return Err("Invalid project search response");
        }
        let mut paths = std::collections::HashSet::new();
        for project in &result.projects {
            if !valid_path(&project.path)
                || !FsPath::new(&project.path).starts_with(&result.root)
                || project.path == result.root
                || FsPath::new(&project.path).file_name().and_then(|s| s.to_str()) != Some(project.name.as_str())
                || project.name.is_empty()
                || project.name.starts_with('.')
                || !paths.insert(&project.path)
            {
                return Err("Invalid project search result path");
            }
        }
        Ok(result)
    }).await.unwrap_or(Err("Remote project search timed out"));
    if response.is_err() {
        let _ = killpg(Pid::from_raw(_group.0 as i32), Signal::SIGKILL);
        let _ = child.kill().await;
    }
    response
        .map(Json)
        .map_err(|error| Error(StatusCode::BAD_GATEWAY, error.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{app, json, remote_fixture, request};
    use serde_json::{Value, json as body};

    fn fixture(root: &FsPath) -> App {
        let mut state = app(root);
        let mut remote = remote_fixture(root, &root.join("unused"));
        let workspace = root.join("workspace's directory");
        fs::create_dir(&workspace).unwrap();
        remote.directory = workspace.to_str().unwrap().into();
        state.remote = Some(remote);
        let tools = root.join(".local/bin");
        fs::create_dir_all(&tools).unwrap();
        let engine = tools.join("opencode-source");
        fs::write(&engine, r#"#!/usr/bin/python3
import json, os, pathlib, sys
assert sys.argv[1:3] == ['run', '--agent'] and sys.argv[3] == 'explore'
assert '--pure' in sys.argv and '--auto' not in sys.argv
config = json.loads(os.environ['OPENCODE_CONFIG_CONTENT'])
assert config['agent']['explore']['mode'] == 'primary'
assert config['agent']['explore']['permission'] == {'*':'deny'}
assert config['permission'] == {'*':'deny'}
if 'model' in config:
    assert config['agent']['explore']['model'] == 'spec-execution/chosen'
    assert os.environ['SPEC_EXECUTION_API_KEY'] == 'fixture-secret-not-live'
prompt = sys.stdin.read()
inventory = json.loads(prompt.split('\n')[-1])['inventory']
pathlib.Path(os.environ['HOME'], 'explore-called').write_text('called')
print(json.dumps({'type':'text','part':{'type':'text','text':json.dumps({'paths':inventory[:20]})}}))
"#).unwrap();
        fs::set_permissions(engine, fs::Permissions::from_mode(0o700)).unwrap();
        state
    }

    #[tokio::test]
    async fn search_uses_remote_explore_and_selected_profile_without_starting_jobs() {
        let root = tempfile::tempdir().unwrap();
        let state = fixture(root.path());
        for name in ["demo-one", "Demo two", "other", ".demo-hidden"] {
            fs::create_dir(root.path().join(name)).unwrap();
        }
        std::os::unix::fs::symlink(root.path().join("demo-one"), root.path().join("demo-link"))
            .unwrap();
        for selected in [false, true] {
            if selected {
                let response = request(state.clone(), "PUT", "/api/settings", body!({
                    "provider":"huggingface", "model":"chosen", "endpoint":"http://localhost:8080/v1",
                    "apiVersion":"", "apiKey":"fixture-secret-not-live"
                })).await;
                assert_eq!(
                    response.status(),
                    StatusCode::OK,
                    "{}",
                    json(response).await
                );
            }
            let response = request(
                state.clone(),
                "POST",
                "/api/projects/search",
                body!({"query":" demo "}),
            )
            .await;
            assert_eq!(
                response.status(),
                StatusCode::OK,
                "{}",
                json(response).await
            );
            let result = json(response).await;
            assert_eq!(result["agent"], "explore");
            assert_eq!(result["root"], root.path().to_str().unwrap());
            assert_eq!(result["truncated"], false);
            assert_eq!(result["projects"].as_array().unwrap().len(), 2);
            assert!(
                result["projects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|item| ["demo-one", "Demo two"].contains(&item["name"].as_str().unwrap()))
            );
            assert!(!result.to_string().contains("fixture-secret-not-live"));
            assert!(root.path().join("explore-called").exists());
            assert!(state.jobs.lock().unwrap().is_empty());
            assert!(!root.path().join(".spec-runs").exists());
            assert!(
                !root
                    .path()
                    .join("workspace's directory/.spec-runs")
                    .exists()
            );
        }
    }

    #[tokio::test]
    async fn invalid_disabled_and_busy_searches_do_not_contact_remote() {
        let root = tempfile::tempdir().unwrap();
        let state = fixture(root.path());
        for query in [
            "",
            " ",
            "../demo",
            "/demo",
            "demo\\path",
            "demo\0",
            "demo\nname",
            ".",
            "..",
        ] {
            let response = request(
                state.clone(),
                "POST",
                "/api/projects/search",
                body!({"query": query}),
            )
            .await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
        let response = request(
            state.clone(),
            "POST",
            "/api/projects/search",
            body!({"query": "x".repeat(101)}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let response = request(
            state.clone(),
            "POST",
            "/api/projects/search",
            body!({"query": "x".repeat(2000)}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let permit = state
            .project_search_slots
            .clone()
            .acquire_owned()
            .await
            .unwrap();
        let response = request(
            state.clone(),
            "POST",
            "/api/projects/search",
            body!({"query":"demo"}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        drop(permit);
        let response = request(
            app(root.path()),
            "POST",
            "/api/projects/search",
            body!({"query":"demo"}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(!root.path().join("explore-called").exists());
        assert!(state.jobs.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn no_matches_skips_model_and_remote_failures_are_sanitized_and_retryable() {
        let root = tempfile::tempdir().unwrap();
        let state = fixture(root.path());
        let response = request(
            state.clone(),
            "POST",
            "/api/projects/search",
            body!({"query":"no-matching-name"}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json(response).await["projects"], body!([]));
        assert!(!root.path().join("explore-called").exists());
        fs::create_dir(root.path().join("demo-one")).unwrap();
        fs::write(
            root.path().join(".local/bin/opencode-source"),
            "#!/bin/sh\nprintf 'private-provider-details' >&2\nexit 1\n",
        )
        .unwrap();
        for _ in 0..2 {
            let response = request(
                state.clone(),
                "POST",
                "/api/projects/search",
                body!({"query":"demo"}),
            )
            .await;
            assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
            let result = json(response).await.to_string();
            assert!(result.contains("Explore project search failed"));
            assert!(!result.contains("private-provider-details"));
        }
        assert_eq!(state.project_search_slots.available_permits(), 1);
    }

    #[tokio::test]
    async fn remote_response_bounds_and_schema_are_enforced() {
        let root = tempfile::tempdir().unwrap();
        let state = fixture(root.path());
        let ssh = &state.remote.as_ref().unwrap().binary;
        for value in [
            body!({"agent":"build", "projects":[], "root":"/root", "truncated":false}),
            body!({"agent":"explore", "projects":[{"name":"demo", "path":"/outside/demo"}], "root":"/root", "truncated":false}),
            body!({"agent":"explore", "projects":[], "root":"relative", "truncated":false}),
            Value::Null,
        ] {
            fs::write(
                ssh,
                format!(
                    "#!/usr/bin/python3\nimport sys\nsys.stdin.read()\nprint({:?})\n",
                    value.to_string()
                ),
            )
            .unwrap();
            let response = request(
                state.clone(),
                "POST",
                "/api/projects/search",
                body!({"query":"demo"}),
            )
            .await;
            assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        }
        fs::write(ssh, "#!/usr/bin/python3\nimport sys,time\nsys.stdin.read()\nsys.stdout.write('x'*140000)\nsys.stdout.flush()\ntime.sleep(60)\n").unwrap();
        let response = tokio::time::timeout(
            Duration::from_secs(5),
            request(
                state.clone(),
                "POST",
                "/api/projects/search",
                body!({"query":"demo"}),
            ),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(state.project_search_slots.available_permits(), 1);
    }
}
