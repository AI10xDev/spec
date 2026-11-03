use super::*;
use serde_json::{Value, json as body};

fn fixture(root: &FsPath) -> App {
    let mut state = app(root);
    state.remote = Some(remote_fixture(root, &root.join("unused")));
    fs::write(
        root.join(".bash_aliases"),
        r#"
spec() {
    echo builder
    if [[ -f "$HOME/hold-build" ]]; then
        touch "$HOME/build-started"
        sleep 60
    fi
}
"#,
    )
    .unwrap();
    let bin = root.join(".local/bin");
    fs::create_dir_all(&bin).unwrap();
    let runner = bin.join("opencode-source");
    // Exercise the real transport and Python runner, without contacting a provider.
    fs::write(&runner, r#"#!/usr/bin/python3
import json, os, pathlib, sys, time
root = pathlib.Path(os.environ['HOME'])
args = sys.argv[1:]
assert args[:1] == ['run']
assert args[3:7] == ['--agent', 'build', '--format', 'json']
assert '--session' not in args and '--continue' not in args
assert not any(k.startswith(('SPEC_SESSION', 'SPEC_BUILD', 'KIBI_SPEC', 'SPEC_OPTIM')) for k in os.environ)
assert os.environ['OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS'] == '1'
prompt = sys.stdin.read()
assert 'gemma4-policy' in prompt and 'Reinforcement Learning' in prompt
assert 'not the distillation pipeline' in prompt
if (root / 'expect-profile').exists():
    assert args[7:] == ['--model', 'spec-execution/selected-model']
    assert os.environ['SPEC_EXECUTION_API_KEY'] == 'fixture-secret'
    config = json.loads(os.environ['OPENCODE_CONFIG_CONTENT'])
    assert config['agent']['build']['model'] == 'spec-execution/selected-model'
    assert 'fixture-secret' not in json.dumps(config)
else:
    assert args[7:] == []
(root / 'builder-request.json').write_text(json.dumps({'args': args, 'cwd': os.getcwd(), 'prompt': prompt}))
print(json.dumps({'type': 'text', 'sessionID': 'ses_performanceFixture', 'part': {'text': 'RL transport fixture'}}), flush=True)
(root / 'performance-started').touch()
if (root / 'hold-performance').exists():
    time.sleep(60)
"#).unwrap();
    fs::set_permissions(runner, fs::Permissions::from_mode(0o700)).unwrap();
    state
}

async fn launch(state: &App, route: &str, input: Value) -> String {
    let response = request(state.clone(), "POST", route, input).await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "{}",
        json(response).await
    );
    json(response).await["id"].as_str().unwrap().to_owned()
}

async fn terminal(state: &App, prefix: &str, id: &str, status: &str) -> Value {
    let mut last = Value::Null;
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let response =
                request(state.clone(), "GET", &format!("{prefix}/{id}"), Value::Null).await;
            assert_eq!(
                response.status(),
                StatusCode::OK,
                "{}",
                json(response).await
            );
            let output = json(response).await;
            if output["recoverable"] == false {
                assert_eq!(output["status"], status, "{output}");
                return output;
            }
            last = output;
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    result.unwrap_or_else(|_| {
        let scoped = if prefix == "/api/performance/runs" {
            state.performance_app()
        } else {
            state.clone()
        };
        let jobs = scoped.jobs.lock().unwrap();
        let job = jobs.iter().find(|job| job.id == id).map(|job| body!({
            "status": job.status, "attached": job.attached, "recover": job.recover,
            "cancel_requested": *job.stop.borrow() == RunControl::Cancel,
            "control_closed": job.stop.is_closed(), "persistence_error": job.persistence_error,
        }));
        let directory = state.root.join(if scoped.performance { ".performance-runs" } else { ".spec-runs" }).join(format!("run-{id}"));
        let remote_status = fs::read_to_string(directory.join("status"));
        let markers: Vec<_> = ["ready", "cancel", "lease", "pipe", "snapshot.md"]
            .into_iter().map(|name| (name, directory.join(name).exists())).collect();
        panic!("run {id} did not reach {status}; last API output: {last}; local job: {job:?}; fixture status: {remote_status:?}; markers: {markers:?}");
    })
}

#[tokio::test]
async fn performance_launch_ignores_unresolved_spec_but_preserves_regular_conflicts() {
    let root = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let spec = persisted_job(
        &Uuid::new_v4().to_string(),
        state.remote.as_ref().unwrap().identity(),
        true,
    );
    recovery::persist(&state, &spec).ok().unwrap();
    // Unresolved spec state in another physical project must not block Performance.
    fs::create_dir_all(root.path().join(format!(".spec-runs/run-{}", spec.id))).unwrap();
    fs::set_permissions(
        root.path().join(".spec-runs"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let blocked = request(
        state.clone(),
        "POST",
        "/api/optimize",
        body!({"project": "."}),
    )
    .await;
    assert_eq!(blocked.status(), StatusCode::CONFLICT);
    assert!(
        json(blocked).await["error"]
            .as_str()
            .unwrap()
            .contains(&spec.id)
    );
    assert!(state.performance_state.jobs.lock().unwrap().is_empty());
    // A dedicated Performance request must not initialize or refresh spec state.
    *state.recovered.lock().unwrap() = false;
    state.jobs.lock().unwrap().clear();
    fs::write(root.path().join("hold-performance"), "").unwrap();
    let id = launch(
        &state,
        "/api/performance",
        body!({"project": project.path()}),
    )
    .await;
    wait_for_file(&root.path().join("performance-started")).await;
    assert!(
        !*state.recovered.lock().unwrap(),
        "Performance consulted spec recovery"
    );
    assert!(state.jobs.lock().unwrap().is_empty());
    let runs = json(request(state.clone(), "GET", "/api/runs", Value::Null).await).await;
    assert_eq!(runs.as_array().unwrap().len(), 1);
    assert_eq!(runs[0]["id"], spec.id);
    let runs =
        json(request(state.clone(), "GET", "/api/performance/runs", Value::Null).await).await;
    assert_eq!(runs.as_array().unwrap().len(), 1);
    assert_eq!(runs[0]["id"], id);
    assert_eq!(runs[0]["kind"], "performance");
    for route in ["/api/performance", "/api/optimize"] {
        assert_eq!(
            request(state.clone(), "POST", route, body!({"project": "."}))
                .await
                .status(),
            StatusCode::CONFLICT
        );
    }
    let blocked = request(
        state.clone(),
        "POST",
        "/api/optimize",
        body!({"name": "objective.optim", "content": "{}"}),
    )
    .await;
    assert_eq!(blocked.status(), StatusCode::CONFLICT);
    assert!(
        json(blocked).await["error"]
            .as_str()
            .unwrap()
            .contains(&spec.id)
    );
    for (prefix, wrong_id) in [("/api/runs", &id), ("/api/performance/runs", &spec.id)] {
        for (method, suffix) in [("GET", ""), ("POST", "/cancel")] {
            assert_eq!(
                request(
                    state.clone(),
                    method,
                    &format!("{prefix}/{wrong_id}{suffix}"),
                    body!({})
                )
                .await
                .status(),
                StatusCode::NOT_FOUND
            );
        }
    }
    assert_eq!(
        request(
            state.clone(),
            "POST",
            &format!("/api/performance/runs/{id}/cancel"),
            body!({})
        )
        .await
        .status(),
        StatusCode::OK
    );
    terminal(&state, "/api/performance/runs", &id, "cancelled").await;
    assert!(state.jobs.lock().unwrap()[0].recover);
}

#[tokio::test]
async fn performance_cancel_survives_stalled_attachment_control_delivery() {
    for cancel_requested in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let state = fixture(root.path());
        let binary = &state.remote.as_ref().unwrap().binary;
        let wrapper = fs::read_to_string(binary).unwrap().replace(
            "exec /bin/bash",
            r#"if [[ ${!#} == *"SSH attachment:"* ]]; then
    printf '%s\n' "$$" > "$HOME/attachment-pid"
fi
exec /bin/bash"#,
        );
        fs::write(binary, wrapper).unwrap();
        fs::write(root.path().join("hold-performance"), "").unwrap();
        let id = launch(
            &state,
            "/api/performance",
            body!({"project": project.path()}),
        )
        .await;
        wait_for_file(&root.path().join("performance-started")).await;
        let pid: i32 = fs::read_to_string(root.path().join("attachment-pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // Stall only SSH and its control reader, not the detached supervisor/builder.
        // The cancel byte stays buffered until the local acknowledgment deadline.
        killpg(Pid::from_raw(pid), Signal::SIGSTOP).unwrap();
        let cancel_path = format!("/api/performance/runs/{id}/cancel");
        if cancel_requested {
            assert_eq!(
                request(state.clone(), "POST", &cancel_path, body!({}))
                    .await
                    .status(),
                StatusCode::OK
            );
        } else {
            state.performance_state.jobs.lock().unwrap()[0]
                .stop
                .send(RunControl::Detach)
                .unwrap();
        }
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let finished = state
                    .performance_state
                    .jobs
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|job| job.id == id && !job.attached && job.stop.is_closed());
                if finished {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("local attachment did not finish cancellation teardown");
        let directory = root.path().join(format!(".performance-runs/run-{id}"));
        let delivered = directory.join("cancel").exists()
            || fs::read_to_string(directory.join("status")).is_ok_and(|status| status == "130\n");
        let output = json(
            request(
                state.clone(),
                "GET",
                &format!("/api/performance/runs/{id}"),
                Value::Null,
            )
            .await,
        )
        .await;
        if !delivered {
            // Clean up the supervised fixture even when testing the broken path.
            assert_eq!(
                request(state.clone(), "POST", &cancel_path, body!({}))
                    .await
                    .status(),
                StatusCode::OK
            );
        }
        terminal(&state, "/api/performance/runs", &id, "cancelled").await;
        assert_eq!(
            delivered, cancel_requested,
            "attachment teardown must retain Cancel without converting Detach to Cancel: {output}"
        );
        assert!(!root.path().join(".spec-output").exists());
    }
}

#[tokio::test]
async fn performance_reverse_isolation_shutdown_restart_and_scoped_cancellation() {
    let root = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    fs::write(root.path().join("hold-performance"), "").unwrap();
    fs::write(root.path().join("hold-build"), "").unwrap();
    fs::write(root.path().join("performance"), "Pending spec requirement").unwrap();
    let performance_id = launch(
        &state,
        "/api/performance",
        body!({"project": project.path()}),
    )
    .await;
    wait_for_file(&root.path().join("performance-started")).await;
    let revision = read(root.path(), "performance").ok().unwrap().revision;
    let spec_id = launch(
        &state,
        "/api/runs",
        body!({"name": "performance", "revision": revision}),
    )
    .await;
    wait_for_file(&root.path().join("build-started")).await;
    assert_eq!(state.jobs.lock().unwrap().len(), 1);
    assert_eq!(state.performance_state.jobs.lock().unwrap().len(), 1);
    detach_and_wait(&state).await;
    for jobs in [&state.jobs, &state.performance_state.jobs] {
        let jobs = jobs.lock().unwrap();
        assert!(!jobs[0].attached);
        assert!(jobs[0].recover);
        assert!(*jobs[0].stop.borrow() == RunControl::Detach);
    }
    let mut fresh = app(root.path());
    fresh.remote = state.remote.clone();
    for (route, id) in [
        ("/api/performance", &performance_id),
        ("/api/files/performance/run", &spec_id),
    ] {
        let output = json(request(fresh.clone(), "GET", route, Value::Null).await).await;
        assert_eq!(output["id"], *id);
        assert_eq!(output["status"], "running");
        assert_eq!(output["recoverable"], true);
    }
    assert_eq!(
        request(
            fresh.clone(),
            "POST",
            "/api/performance",
            body!({"project": "."})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            fresh.clone(),
            "POST",
            &format!("/api/performance/runs/{performance_id}/cancel"),
            body!({})
        )
        .await
        .status(),
        StatusCode::OK
    );
    let cancelled = terminal(
        &fresh,
        "/api/performance/runs",
        &performance_id,
        "cancelled",
    )
    .await;
    let spec_output = json(
        request(
            fresh.clone(),
            "GET",
            &format!("/api/runs/{spec_id}"),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(spec_output["status"], "running");
    assert_eq!(
        request(
            fresh.clone(),
            "POST",
            &format!("/api/runs/{spec_id}/cancel"),
            body!({})
        )
        .await
        .status(),
        StatusCode::OK
    );
    terminal(&fresh, "/api/runs", &spec_id, "cancelled").await;
    assert_eq!(
        json(request(app(root.path()), "GET", "/api/performance", Value::Null).await).await,
        cancelled
    );
    for (namespace, id) in [
        (".spec-output", &spec_id),
        (".performance-output", &performance_id),
    ] {
        assert!(root.path().join(format!("{namespace}/{id}.json")).exists());
    }
    assert_eq!(
        fs::read_to_string(root.path().join(".performance-output/latest-performance")).unwrap(),
        performance_id
    );
    assert!(!root.path().join(".spec-output/latest-performance").exists());
}

#[tokio::test]
async fn performance_provider_runner_persistence_uses_dedicated_endpoints() {
    for profile in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let state = fixture(root.path());
        if profile {
            let response = request(state.clone(), "PUT", "/api/settings", body!({
                "provider": "openai", "model": "selected-model", "endpoint": "https://api.openai.com/v1",
                "apiVersion": "", "apiKey": "fixture-secret"
            })).await;
            assert_eq!(
                response.status(),
                StatusCode::OK,
                "{}",
                json(response).await
            );
            fs::write(root.path().join("expect-profile"), "").unwrap();
        }
        let project = root.path().join("project with spaces;literal");
        fs::create_dir(&project).unwrap();
        let input = body!({"project": "project with spaces;literal", "spec": {"name": "instructions.md", "content": "Run configured RL only"}});
        let id = launch(&state, "/api/performance", input.clone()).await;
        let output = terminal(&state, "/api/performance/runs", &id, "completed").await;
        assert_eq!(output["name"], "performance");
        assert_eq!(output["continuable"], false);
        assert!(
            output["output"]
                .as_str()
                .unwrap()
                .contains("RL transport fixture")
        );
        let invocation: Value =
            serde_json::from_slice(&fs::read(root.path().join("builder-request.json")).unwrap())
                .unwrap();
        assert_eq!(invocation["cwd"], project.to_str().unwrap());
        assert!(
            invocation["prompt"]
                .as_str()
                .unwrap()
                .contains("Run configured RL only")
        );
        let directory = root.path().join(format!(".performance-runs/run-{id}"));
        assert_eq!(
            fs::read_to_string(directory.join("session-id")).unwrap(),
            "ses_performanceFixture\n"
        );
        assert_eq!(
            serde_json::from_slice::<Value>(
                &fs::read(directory.join("performance-request.json")).unwrap()
            )
            .unwrap(),
            input
        );
        assert!(!directory.join("invocation").exists());
        assert!(!root.path().join(".spec-runs").exists());
        assert!(!root.path().join(".spec-output").exists());
        assert!(state.jobs.lock().unwrap().is_empty());
        assert_eq!(
            json(request(state.clone(), "GET", "/api/optimize", Value::Null).await).await,
            Value::Null
        );
        let stored =
            fs::read_to_string(root.path().join(format!(".performance-output/{id}.json"))).unwrap();
        assert!(!stored.contains("fixture-secret"));
        assert!(!output.to_string().contains("fixture-secret"));
        assert_eq!(
            json(request(app(root.path()), "GET", "/api/performance", Value::Null).await).await,
            output
        );
    }
}

#[tokio::test]
async fn performance_owns_recovery_and_admission_gates_even_across_router_clones() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let scoped = state.performance_app();
    assert!(Arc::ptr_eq(&scoped.settings, &state.settings));
    assert!(Arc::ptr_eq(&scoped.jobs, &state.performance_app().jobs));
    assert!(Arc::ptr_eq(
        &scoped.recovered,
        &scoped.performance_app().recovered
    ));
    assert!(!Arc::ptr_eq(&scoped.recovery_runs, &state.recovery_runs));
    assert!(!Arc::ptr_eq(&scoped.recovery_gate, &state.recovery_gate));
    let mut blocker = persisted_job(
        &Uuid::new_v4().to_string(),
        scoped.remote.as_ref().unwrap().identity(),
        true,
    );
    blocker.name = "performance".into();
    recovery::persist(&scoped, &blocker).ok().unwrap();
    recovery::set_latest(&scoped, &blocker).ok().unwrap();
    let spec_gate = state.recovery_gate.lock().await;
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        request(
            state.clone(),
            "POST",
            "/api/performance",
            body!({"project": "."}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let error = json(response).await;
    assert!(error["error"].as_str().unwrap().contains(&blocker.id));
    assert!(!*state.recovered.lock().unwrap());
    drop(spec_gate);
    // An unavailable Performance run must not be refreshed by ordinary admission.
    let performance_gate = scoped.recovery_gate.lock().await;
    let run_gate = recovery::run_gate(&scoped, &blocker.id).await;
    fs::write(root.path().join("a.md"), "Pending requirement").unwrap();
    let revision = read(root.path(), "a.md").ok().unwrap().revision;
    let id = tokio::time::timeout(
        Duration::from_secs(5),
        launch(
            &state,
            "/api/runs",
            body!({"name": "a.md", "revision": revision}),
        ),
    )
    .await
    .unwrap();
    terminal(&state, "/api/runs", &id, "completed").await;
    assert!(scoped.jobs.lock().unwrap()[0].recover);
    drop(run_gate);
    drop(performance_gate);
}

#[tokio::test]
async fn performance_validates_its_dedicated_contract_without_creating_state() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    for input in [
        body!({}),
        body!({"name": "legacy.optim", "content": "{}"}),
        body!({"project": ".", "extra": true}),
        body!({"project": ""}),
        body!({"project": "  "}),
        body!({"project": "../other"}),
        body!({"project": "a/../../other"}),
        body!({"project": "bad\npath"}),
        body!({"project": "bad\0path"}),
        body!({"project": "x".repeat(4097)}),
        body!({"project": ".", "spec": {"name": "../file", "content": "{}"}}),
        body!({"project": ".", "spec": {"name": "file", "content": " "}}),
        body!({"project": ".", "spec": {"name": "file", "content": "\0"}}),
        body!({"project": ".", "spec": {"name": "file", "content": "\"".repeat(600_000)}}),
    ] {
        assert!(
            request(state.clone(), "POST", "/api/performance", input)
                .await
                .status()
                .is_client_error()
        );
    }
    assert!(state.jobs.lock().unwrap().is_empty());
    assert!(state.performance_state.jobs.lock().unwrap().is_empty());
    assert!(!root.path().join(".performance-output").exists());
    assert!(!root.path().join(".performance-runs").exists());
    assert_eq!(
        json(request(state, "GET", "/api/performance", Value::Null).await).await,
        Value::Null
    );
    assert_eq!(
        request(
            app(root.path()),
            "POST",
            "/api/performance",
            body!({"project": "."})
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn performance_snapshot_rejects_noncanonical_terminal_evidence_and_preserves_output() {
    for status in ["+0", "00", "0130", "-0", "256", "invalid"] {
        let root = tempfile::tempdir().unwrap();
        let state = fixture(root.path());
        let scoped = state.performance_app();
        let remote = scoped.remote.as_ref().unwrap();
        fs::write(
            &remote.binary,
            format!("#!/bin/sh\nprintf 'SPEC-RUN-1 {status} 0\\nuntrusted output'\n"),
        )
        .unwrap();
        let id = Uuid::new_v4().to_string();
        let mut job = persisted_job(&id, remote.identity(), true);
        job.name = "performance".into();
        recovery::persist(&scoped, &job).ok().unwrap();
        recovery::set_latest(&scoped, &job).ok().unwrap();
        let output =
            json(request(state.clone(), "GET", "/api/performance", Value::Null).await).await;
        assert_eq!(output["recoverable"], true, "{status}: {output}");
        assert_eq!(output["output"], "saved output");
        assert!(
            output["status"]
                .as_str()
                .unwrap()
                .contains("invalid remote status")
        );
        assert_eq!(
            request(
                state.clone(),
                "POST",
                &format!("/api/performance/runs/{id}/cancel"),
                body!({})
            )
            .await
            .status(),
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(
            request(state, "POST", "/api/performance", body!({"project": "."}))
                .await
                .status(),
            StatusCode::CONFLICT
        );
        assert!(recovery::load(&scoped, &id).ok().unwrap().recover);
        assert!(!root.path().join(".spec-output").exists());
    }
}

#[tokio::test]
async fn performance_remote_identity_mismatch_never_reads_or_cancels_spec_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let scoped = state.performance_app();
    let remote = state.remote.as_ref().unwrap();
    let old_identity = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(
                &remote.binary,
                &remote.target,
                &remote.directory,
                &remote.key,
            ))
            .unwrap()
        )
    );
    assert_eq!(
        remote.identity(),
        old_identity,
        "persisted spec identities must remain stable"
    );
    fs::write(
        &remote.binary,
        format!(
            "#!/bin/sh\ntouch '{}'\nprintf 'SPEC-RUN-1 0 0\\nwrong namespace'\n",
            root.path().join("contacted").display()
        ),
    )
    .unwrap();
    let id = Uuid::new_v4().to_string();
    let mut job = persisted_job(&id, old_identity, true);
    job.name = "performance".into();
    recovery::persist(&scoped, &job).ok().unwrap();
    recovery::set_latest(&scoped, &job).ok().unwrap();
    let output = json(request(state.clone(), "GET", "/api/performance", Value::Null).await).await;
    assert_eq!(output["recoverable"], true);
    assert_eq!(output["output"], "saved output");
    assert!(
        output["status"]
            .as_str()
            .unwrap()
            .contains("does not match")
    );
    assert_eq!(
        request(
            state,
            "POST",
            &format!("/api/performance/runs/{id}/cancel"),
            body!({})
        )
        .await
        .status(),
        StatusCode::BAD_GATEWAY
    );
    assert!(!root.path().join("contacted").exists());
}

#[tokio::test]
async fn performance_cancel_cleans_captured_provider_without_changing_request_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let selected = body!({
        "provider": "openai", "model": "selected-model", "endpoint": "https://api.openai.com/v1",
        "apiVersion": "", "apiKey": "fixture-secret"
    });
    assert_eq!(
        request(state.clone(), "PUT", "/api/settings", selected.clone())
            .await
            .status(),
        StatusCode::OK
    );
    fs::write(root.path().join("expect-profile"), "").unwrap();
    fs::write(root.path().join("hold-performance"), "").unwrap();
    let input =
        body!({"project": ".", "spec": {"name": "context.md", "content": "configured RL only\n"}});
    let id = launch(&state, "/api/performance", input.clone()).await;
    let replacement = body!({
        "provider": "openai", "model": "next-model", "endpoint": "https://api.openai.com/v1",
        "apiVersion": "", "apiKey": "replacement-secret"
    });
    assert_eq!(
        request(state.clone(), "PUT", "/api/settings", replacement)
            .await
            .status(),
        StatusCode::OK
    );
    wait_for_file(&root.path().join("performance-started")).await;
    let directory = root.path().join(format!(".performance-runs/run-{id}"));
    let profile = directory.join("execution-profile.json");
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&profile).unwrap()).unwrap(),
        selected
    );
    assert_eq!(
        fs::metadata(&profile).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::read_to_string(directory.join("snapshot.md")).unwrap(),
        include_str!("performance-session.py")
    );
    assert_eq!(
        request(
            state.clone(),
            "POST",
            &format!("/api/performance/runs/{id}/cancel"),
            body!({})
        )
        .await
        .status(),
        StatusCode::OK
    );
    let output = terminal(&state, "/api/performance/runs", &id, "cancelled").await;
    for name in [
        "execution-profile.json",
        "provider-setup.bash",
        "snapshot.md",
    ] {
        assert!(!directory.join(name).exists(), "{name}");
    }
    assert_eq!(
        serde_json::from_slice::<Value>(
            &fs::read(directory.join("performance-request.json")).unwrap()
        )
        .unwrap(),
        input
    );
    let stored =
        fs::read_to_string(root.path().join(format!(".performance-output/{id}.json"))).unwrap();
    for secret in ["fixture-secret", "replacement-secret"] {
        assert!(!stored.contains(secret));
        assert!(!output.to_string().contains(secret));
    }
    assert!(state.jobs.lock().unwrap().is_empty());
}
