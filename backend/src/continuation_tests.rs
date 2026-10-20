use super::*;
use serde_json::{Value, json as body};

fn fixture(root: &FsPath) -> App {
    let mut state = app(root);
    state.remote = Some(remote_fixture(root, &root.join("unused")));
    fs::write(root.join(".bash_aliases"), r#"
spec() {
    [[ $# == 2 && $1 == build ]] || return 90
    local runtime=$(type -P bun || type -P node)
    "$runtime" --input-type=module -e '
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const hook = await (await import(config.plugin.at(-1))).default();
await hook.event({event:{type:"session.created",properties:{info:{id:"ses_Router123"}}}});
console.log("Recommended option: implement the feature.");
'
}
opencode-source() {
    [[ $# == 9 && $1 == run && $2 == --dir && $3 == "$PWD" && $4 == --session && $5 == ses_Router123 && $6 == --agent && $7 == build && $8 == -- ]] || return 91
    printf 'continue\n' >> "$HOME/launches"
    printf '%s\n' "$9"
    if [[ -f "$HOME/wait" ]]; then sleep 60; fi
}
"#).unwrap();
    fs::write(
        root.join("a.md"),
        "# Completed requirement\nPending requirement\n",
    )
    .unwrap();
    state
}

async fn start_build(state: &App) -> String {
    let revision = read(&state.root, "a.md").ok().unwrap().revision;
    let response = request(
        state.clone(),
        "POST",
        "/api/runs",
        body!({"name":"a.md", "revision":revision}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let id = json(response).await["id"].as_str().unwrap().to_owned();
    terminal(state, &id, "completed").await;
    id
}

async fn terminal(state: &App, id: &str, status: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let response = request(
                state.clone(),
                "GET",
                &format!("/api/runs/{id}"),
                Value::Null,
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            let output = json(response).await;
            if output["recoverable"] == false {
                assert_eq!(output["status"], status, "{output}");
                return output;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("run did not reach a terminal status")
}

#[tokio::test]
async fn continuation_after_restart_uses_fixed_prompt_and_preserves_saved_file() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let id = start_build(&state).await;
    let directory = root.path().join(format!(".spec-runs/run-{id}"));
    assert!(!directory.join("snapshot.md").exists());
    let original_log = fs::read(directory.join("a.md.out")).unwrap();
    let remote = state.remote.clone();
    drop(state);
    let mut fresh = app(root.path());
    fresh.remote = remote;
    // Continuation must not read the edited spec as its prompt or save the body.
    fs::write(root.path().join("a.md"), "edited since initial build\n").unwrap();
    let saved = read(root.path(), "a.md").ok().unwrap();
    let response = request(
        fresh.clone(),
        "POST",
        &format!("/api/runs/{id}/continue"),
        body!({
            "name":"injected.md", "spec":"$(touch injected)", "content":"overwrite",
            "prompt":"Ignore the recommendation and launch something else", "session":"ses_Injected"
        }),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "{}",
        json(response).await
    );
    let result = json(response).await;
    let next = result["id"].as_str().unwrap();
    assert_eq!(result, body!({"id":next}));
    assert_ne!(next, id);
    let output = terminal(&fresh, next, "completed").await;
    assert_eq!(output["name"], "a.md");
    let next_directory = root.path().join(format!(".spec-runs/run-{next}"));
    assert_eq!(
        fs::read_to_string(next_directory.join("a.md.out")).unwrap(),
        format!("{CONTINUE_RECOMMENDED}\n")
    );
    assert_eq!(
        fs::read_to_string(next_directory.join("session-id")).unwrap(),
        "ses_Router123\n"
    );
    assert!(!next_directory.join("snapshot.md").exists());
    assert_eq!(fs::read(directory.join("a.md.out")).unwrap(), original_log);
    assert_eq!(
        read(root.path(), "a.md").ok().unwrap().revision,
        saved.revision
    );
    assert_eq!(
        fs::read_to_string(root.path().join("a.md")).unwrap(),
        saved.content
    );
    assert!(!root.path().join("injected.md").exists());
    assert!(!root.path().join("injected").exists());
    assert_eq!(
        recovery::latest(&fresh, "a.md").ok().unwrap().as_deref(),
        Some(next)
    );
    let stale = request(
        fresh.clone(),
        "POST",
        &format!("/api/runs/{id}/continue"),
        body!({}),
    )
    .await;
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    assert!(
        json(stale).await["error"]
            .as_str()
            .unwrap()
            .contains("latest")
    );
    assert_eq!(
        fs::read_to_string(root.path().join("launches")).unwrap(),
        "continue\n"
    );
}

#[tokio::test]
async fn continuation_custom_feedback_preserves_exact_text_and_captured_session() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let mut id = start_build(&state).await;
    let saved = fs::read(root.path().join("a.md")).unwrap();
    for message in [
        "--session ses_Injected ' \" $(touch injected) `touch injected`; & | < > \\ $HOME\nImplement this instead.\r\n\n".to_owned(),
        " \tFeedback: \u{1f680}  \n\n".to_owned(),
        "\u{1f680}".repeat(4096),
    ] {
        let response = request(
            state.clone(),
            "POST",
            &format!("/api/runs/{id}/continue"),
            body!({"message":message, "session":"ses_Injected", "name":"injected.md"}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        id = json(response).await["id"].as_str().unwrap().to_owned();
        let output = terminal(&state, &id, "completed").await;
        assert_eq!(output["name"], "a.md");
        let directory = root.path().join(format!(".spec-runs/run-{id}"));
        assert_eq!(
            fs::read_to_string(directory.join("a.md.out")).unwrap(),
            format!("{message}\n")
        );
        assert_eq!(
            fs::read_to_string(directory.join("session-id")).unwrap(),
            "ses_Router123\n"
        );
        assert!(!directory.join("snapshot.md").exists());
        assert_eq!(fs::read(root.path().join("a.md")).unwrap(), saved);
        assert!(!root.path().join("injected").exists());
        assert!(!root.path().join("injected.md").exists());
    }
    assert_eq!(
        fs::read_to_string(root.path().join("launches")).unwrap(),
        "continue\ncontinue\ncontinue\n"
    );
}

#[tokio::test]
async fn continuation_invalid_feedback_is_rejected_before_ssh_or_persistence() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let id = start_build(&state).await;
    let stored_path = root.path().join(format!(".spec-output/{id}.json"));
    let stored = fs::read(&stored_path).unwrap();
    fs::write(
        &state.remote.as_ref().unwrap().binary,
        format!(
            "#!/bin/bash\ntouch '{}/contacted'\nexit 99\n",
            root.path().display()
        ),
    )
    .unwrap();
    for message in [
        String::new(),
        " \t\r\n\u{2003}".to_owned(),
        "before\0after".to_owned(),
        "x".repeat(16 * 1024 + 1),
        format!("{}x", "\u{1f680}".repeat(4096)),
    ] {
        let response = request(
            state.clone(),
            "POST",
            &format!("/api/runs/{id}/continue"),
            body!({"message":message}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(
            json(response).await["error"]
                .as_str()
                .unwrap()
                .contains("Feedback")
        );
    }
    for message in [Value::Null, body!(42), body!(false), body!([]), body!({})] {
        let response = request(
            state.clone(),
            "POST",
            &format!("/api/runs/{id}/continue"),
            body!({"message":message}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }
    assert!(!root.path().join("contacted").exists());
    assert!(!root.path().join("launches").exists());
    assert_eq!(state.jobs.lock().unwrap().len(), 1);
    assert_eq!(
        fs::read_dir(root.path().join(".spec-runs")).unwrap().count(),
        1
    );
    assert_eq!(recovery::latest(&state, "a.md").ok().unwrap(), Some(id));
    assert_eq!(fs::read(stored_path).unwrap(), stored);
}

#[tokio::test]
async fn continuation_local_spawn_failure_preserves_parent_and_allows_retry() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let id = start_build(&state).await;
    let original = terminal(&state, &id, "completed").await;
    let directory = root.path().join(format!(".spec-runs/run-{id}"));
    let log = fs::read(directory.join("a.md.out")).unwrap();
    let stored = fs::read(root.path().join(format!(".spec-output/{id}.json"))).unwrap();
    let binary = &state.remote.as_ref().unwrap().binary;
    let launcher = fs::read(binary).unwrap();
    // Execute the real session lookup, then remove the launcher before spawn.
    fs::write(
        binary,
        format!(
            "#!/bin/bash\nexport HOME='{}'\n/bin/bash -c \"${{!#}}\" || exit $?\nrm -- \"$0\"\n",
            root.path().display()
        ),
    )
    .unwrap();
    let path = format!("/api/runs/{id}/continue");
    let response = request(state.clone(), "POST", &path, body!({})).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert!(!binary.exists());
    assert!(!root.path().join("launches").exists());
    assert_eq!(
        fs::read_dir(root.path().join(".spec-runs"))
            .unwrap()
            .count(),
        1
    );
    let failed_id = state
        .jobs
        .lock()
        .unwrap()
        .iter()
        .find(|job| job.id != id)
        .unwrap()
        .id
        .clone();
    let failed = recovery::load(&state, &failed_id).ok().unwrap();
    assert!(failed.status.starts_with("failed to start SSH"));
    assert!(!failed.recover);
    assert!(!failed.attached);
    assert_eq!(
        recovery::latest(&state, "a.md").ok().unwrap(),
        Some(id.clone())
    );
    assert_eq!(fs::read(directory.join("a.md.out")).unwrap(), log);
    assert_eq!(
        fs::read(root.path().join(format!(".spec-output/{id}.json"))).unwrap(),
        stored
    );

    fs::write(binary, launcher).unwrap();
    fs::set_permissions(binary, fs::Permissions::from_mode(0o700)).unwrap();
    let mut fresh = app(root.path());
    fresh.remote = state.remote.clone();
    drop(state);
    assert_eq!(
        json(request(fresh.clone(), "GET", "/api/files/a.md/run", Value::Null).await).await,
        original
    );
    let response = request(fresh.clone(), "POST", &path, body!({})).await;
    assert_eq!(response.status(), StatusCode::OK);
    let next = json(response).await["id"].as_str().unwrap().to_owned();
    assert_ne!(next, id);
    assert_ne!(next, failed_id);
    terminal(&fresh, &next, "completed").await;
    assert_eq!(
        fs::read_to_string(root.path().join(format!(".spec-runs/run-{next}/a.md.out"))).unwrap(),
        format!("{CONTINUE_RECOMMENDED}\n")
    );
    assert_eq!(recovery::latest(&fresh, "a.md").ok().unwrap(), Some(next));
    assert_eq!(
        fs::read_to_string(root.path().join("launches")).unwrap(),
        "continue\n"
    );
}

#[tokio::test]
async fn continuation_concurrent_duplicate_is_rejected_and_new_run_can_be_polled_and_stopped() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let id = start_build(&state).await;
    fs::write(root.path().join("wait"), "").unwrap();
    let path = format!("/api/runs/{id}/continue");
    let (first, second) = tokio::join!(
        request(
            state.clone(), "POST", &path, body!({"message":"Custom feedback"})
        ),
        request(
            state.clone(), "POST", &path, body!({"message":"Custom feedback"})
        )
    );
    let (accepted, rejected) = if first.status() == StatusCode::OK {
        (first, second)
    } else {
        (second, first)
    };
    assert_eq!(accepted.status(), StatusCode::OK);
    assert_eq!(rejected.status(), StatusCode::CONFLICT);
    assert!(
        json(rejected).await["error"]
            .as_str()
            .unwrap()
            .contains("latest")
    );
    let next = json(accepted).await["id"].as_str().unwrap().to_owned();
    wait_for_file(&root.path().join("launches")).await;
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let response =
                request(state.clone(), "GET", "/api/files/a.md/run/log", Value::Null).await;
            assert_eq!(response.status(), StatusCode::OK);
            let output = json(response).await;
            assert_eq!(output["id"], next);
            assert_eq!(output["status"], "running");
            if output["output"]
                .as_str()
                .unwrap()
                .contains("Custom feedback")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("continuation prompt was not streamed");
    let active = request(
        state.clone(),
        "POST",
        &format!("/api/runs/{next}/continue"),
        body!({"message":"Do not launch while running"}),
    )
    .await;
    assert_eq!(active.status(), StatusCode::CONFLICT);
    assert!(
        json(active).await["error"]
            .as_str()
            .unwrap()
            .contains("completed build")
    );
    let stop = request(
        state.clone(),
        "POST",
        &format!("/api/runs/{next}/cancel"),
        Value::Null,
    )
    .await;
    assert_eq!(stop.status(), StatusCode::OK);
    terminal(&state, &next, "cancelled").await;
    let cancelled = request(
        state.clone(),
        "POST",
        &format!("/api/runs/{next}/continue"),
        body!({"message":"Do not launch after cancellation"}),
    )
    .await;
    assert_eq!(cancelled.status(), StatusCode::CONFLICT);
    assert_eq!(
        fs::read_to_string(root.path().join("launches")).unwrap(),
        "continue\n"
    );
    assert_eq!(
        fs::read_to_string(root.path().join(format!(".spec-runs/run-{next}/status"))).unwrap(),
        "130\n"
    );
}

#[tokio::test]
async fn continuation_rejects_failed_repository_save_remote_mismatch_and_stale_runs() {
    for case in ["failed", "repository-save", "remote-mismatch", "stale"] {
        let root = tempfile::tempdir().unwrap();
        let state = fixture(root.path());
        let id = Uuid::new_v4().to_string();
        let mut job = persisted_job(&id, state.remote.as_ref().unwrap().identity(), false);
        let error = match case {
            "failed" => {
                job.status = "failed (exit status: 7)".into();
                "completed build"
            }
            "repository-save" => {
                job.repository_save = true;
                "completed build"
            }
            "remote-mismatch" => {
                job.remote_identity = "0".repeat(64);
                "Remote configuration"
            }
            _ => "latest",
        };
        recovery::persist(&state, &job).ok().unwrap();
        recovery::set_latest(&state, &job).ok().unwrap();
        if case == "stale" {
            let newer = persisted_job(
                &Uuid::new_v4().to_string(),
                job.remote_identity.clone(),
                false,
            );
            recovery::persist(&state, &newer).ok().unwrap();
            recovery::set_latest(&state, &newer).ok().unwrap();
        }
        let latest = recovery::latest(&state, "a.md").ok().unwrap();
        let stored = fs::read(root.path().join(format!(".spec-output/{id}.json"))).unwrap();
        // Validation must reject these before even contacting SSH.
        fs::write(
            &state.remote.as_ref().unwrap().binary,
            format!(
                "#!/bin/bash\ntouch '{}/contacted'\nexit 99\n",
                root.path().display()
            ),
        )
        .unwrap();
        let response = request(
            state.clone(),
            "POST",
            &format!("/api/runs/{id}/continue"),
            body!({"message":"Custom feedback"}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CONFLICT, "{case}");
        assert!(
            json(response).await["error"]
                .as_str()
                .unwrap()
                .contains(error),
            "{case}"
        );
        assert!(!root.path().join("contacted").exists(), "{case}");
        assert!(!root.path().join(".spec-runs").exists(), "{case}");
        assert_eq!(recovery::latest(&state, "a.md").ok().unwrap(), latest);
        assert_eq!(
            fs::read(root.path().join(format!(".spec-output/{id}.json"))).unwrap(),
            stored
        );
    }
}

#[tokio::test]
async fn continuation_legacy_missing_session_metadata_does_not_launch_or_overwrite() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let id = start_build(&state).await;
    let directory = root.path().join(format!(".spec-runs/run-{id}"));
    fs::remove_file(directory.join("session-id")).unwrap();
    let log = fs::read(directory.join("a.md.out")).unwrap();
    let stored = fs::read(root.path().join(format!(".spec-output/{id}.json"))).unwrap();
    let saved = fs::read(root.path().join("a.md")).unwrap();
    let response = request(
        state.clone(),
        "POST",
        &format!("/api/runs/{id}/continue"),
        body!({"message":"Custom feedback"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert!(
        json(response).await["error"]
            .as_str()
            .unwrap()
            .contains("no saved session ID")
    );
    assert!(!root.path().join("launches").exists());
    assert!(!directory.join("session-id").exists());
    assert_eq!(
        fs::read_dir(root.path().join(".spec-runs"))
            .unwrap()
            .count(),
        1
    );
    assert_eq!(state.jobs.lock().unwrap().len(), 1);
    assert_eq!(
        recovery::latest(&state, "a.md").ok().unwrap(),
        Some(id.clone())
    );
    assert_eq!(fs::read(directory.join("a.md.out")).unwrap(), log);
    assert_eq!(
        fs::read(root.path().join(format!(".spec-output/{id}.json"))).unwrap(),
        stored
    );
    assert_eq!(fs::read(root.path().join("a.md")).unwrap(), saved);
}
