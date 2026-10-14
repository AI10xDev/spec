use super::*;
use serde_json::{Value, json as body};

fn fixture(root: &FsPath) -> App {
    let mut state = app(root);
    state.remote = Some(remote_fixture(root, &root.join("unused")));
    fs::write(
        root.join(".bash_aliases"),
        r#"
spec() {
    [[ $# == 2 && $1 == build && $SPEC_BUILD_AUTO == 1 ]] || return 90
    echo builder
    if [[ -f "$HOME/hold-build" ]]; then
        touch "$HOME/build-started"
        sleep 60
    fi
}
"#,
    )
    .unwrap();
    state
}

async fn build(state: &App, name: &str) -> String {
    let revision = read(&state.root, name).ok().unwrap().revision;
    let response = request(
        state.clone(),
        "POST",
        "/api/runs",
        body!({"name":name, "revision":revision}),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "{}",
        json(response).await
    );
    json(response).await["id"].as_str().unwrap().to_owned()
}

async fn start_optimization(state: &App) -> String {
    let response = request(state.clone(), "POST", "/api/optimize", body!({})).await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "{}",
        json(response).await
    );
    json(response).await["id"].as_str().unwrap().to_owned()
}

async fn terminal(state: &App, id: &str, status: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(15), async {
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
    .expect("run did not reach a terminal status within 15 seconds")
}

fn objective(root: &FsPath, command: &str) {
    fs::write(
        root.join("objective.optim"),
        body!({
            "version": 1,
            "objectives": [{
                "name": "throughput",
                "command": ["python3", "-c", command],
                "measure": ["python3", "-c", "from pathlib import Path; p=Path('score'); print(p.read_text() if p.exists() else 0)"],
                "direction": "maximize",
                "absolute_tolerance": 0,
                "relative_tolerance": 0,
                "patience": 2
            }]
        })
        .to_string(),
    )
    .unwrap();
}

#[tokio::test]
async fn optimization_real_python_reports_gains_and_persists_separately_from_builds() {
    for name in ["a.md", "optimization"] {
        let root = tempfile::tempdir().unwrap();
        let state = fixture(root.path());
        assert_eq!(
            json(request(state.clone(), "GET", "/api/optimize", Value::Null).await).await,
            Value::Null
        );
        fs::write(root.path().join(name), "Pending requirement\n").unwrap();
        let build_id = build(&state, name).await;
        let original = terminal(&state, &build_id, "completed").await;
        assert_eq!(original["output"], "builder\n");
        assert_eq!(original["continuable"], true);
        assert_eq!(
            json(request(state.clone(), "GET", "/api/optimize", Value::Null).await).await,
            Value::Null
        );
        let build_directory = root.path().join(format!(".spec-runs/run-{build_id}"));
        let invocation = fs::read(build_directory.join("invocation")).unwrap();
        let log = build_directory.join(format!("{name}.out"));
        assert_eq!(
            invocation,
            format!(
                "{}\0build\0{name}\0{}\0",
                root.path().display(),
                log.display()
            )
            .into_bytes()
        );
        let stored_build =
            fs::read(root.path().join(format!(".spec-output/{build_id}.json"))).unwrap();
        objective(
            root.path(),
            "import os; from pathlib import Path; Path('score').write_text(str(min(int(os.environ['SPEC_OPTIM_ITERATION']),2)))",
        );

        // Optimize has no editor name, revision, or document in its request.
        let id = start_optimization(&state).await;
        let output = terminal(&state, &id, "completed").await;
        assert_eq!(output["name"], "optimization");
        assert_eq!(output["continuable"], false);
        assert!(
            state
                .jobs
                .lock()
                .unwrap()
                .iter()
                .find(|job| job.id == id)
                .unwrap()
                .optimization
        );
        let directory = root.path().join(format!(".spec-runs/run-{id}"));
        assert!(!directory.join("snapshot.md").exists());
        assert!(!directory.join("invocation").exists());
        let report = fs::read_to_string(directory.join("report.jsonl")).unwrap();
        assert_eq!(
            fs::read_to_string(directory.join("progress.log")).unwrap(),
            report
        );
        assert_eq!(output["output"], report);
        assert_eq!(
            fs::read_to_string(directory.join("optimization.out")).unwrap(),
            report
        );
        let events: Vec<Value> = report
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(events[0]["event"], "start");
        assert_eq!(events[0]["project"], root.path().to_str().unwrap());
        assert_eq!(events[0]["filename"], name);
        assert_eq!(events[0]["output"], log.to_str().unwrap());
        assert_eq!(
            events[0]["source"],
            build_directory.join("invocation").to_str().unwrap()
        );
        let iterations: Vec<_> = events
            .iter()
            .filter(|event| event["event"] == "iteration")
            .collect();
        assert_eq!(iterations.len(), 4);
        assert_eq!(
            iterations
                .iter()
                .map(|event| event["gain"].clone())
                .collect::<Vec<_>>(),
            body!([1.0, 1.0, 0.0, 0.0]).as_array().unwrap().clone()
        );
        assert_eq!(
            iterations
                .iter()
                .map(|event| event["marginal_difference"].clone())
                .collect::<Vec<_>>(),
            body!([null, 0.0, -1.0, 0.0]).as_array().unwrap().clone()
        );
        assert_eq!(events.last().unwrap()["outcome"], "converged");
        assert_eq!(
            events.last().unwrap()["objectives"][0]["cumulative_gain"],
            2.0
        );
        let commands = fs::read_to_string(directory.join("commands.log")).unwrap();
        assert!(commands.contains("throughput iteration=0 measure"));
        assert!(commands.contains("throughput iteration=4 command"));
        assert_eq!(
            fs::read(build_directory.join("invocation")).unwrap(),
            invocation
        );
        assert_eq!(
            fs::read(root.path().join(format!(".spec-output/{build_id}.json"))).unwrap(),
            stored_build
        );
        assert_eq!(
            fs::read_to_string(root.path().join(name)).unwrap(),
            "Pending requirement\n"
        );

        let remote = state.remote.clone();
        drop(state);
        let mut fresh = app(root.path());
        fresh.remote = remote;
        assert_eq!(
            json(request(fresh.clone(), "GET", "/api/optimize", Value::Null).await).await,
            output
        );
        assert_eq!(
            json(
                request(
                    fresh.clone(),
                    "GET",
                    &format!("/api/files/{name}/run"),
                    Value::Null
                )
                .await
            )
            .await,
            original
        );
        let response = request(
            fresh.clone(),
            "POST",
            &format!("/api/runs/{id}/continue"),
            body!({}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert!(
            json(response).await["error"]
                .as_str()
                .unwrap()
                .contains("completed build")
        );

        // Advancing the build pointer must not replace the optimizer pointer either.
        let next_build = build(&fresh, name).await;
        terminal(&fresh, &next_build, "completed").await;
        let offline = app(root.path());
        assert_eq!(
            json(request(offline.clone(), "GET", "/api/optimize", Value::Null).await).await,
            output
        );
        assert_eq!(
            json(
                request(
                    offline,
                    "GET",
                    &format!("/api/files/{name}/run"),
                    Value::Null
                )
                .await
            )
            .await["id"],
            next_build
        );
    }
}

#[tokio::test]
async fn optimization_pointer_preserves_legacy_regular_file_records() {
    let root = tempfile::tempdir().unwrap();
    let state = app(root.path());
    let mut regular = persisted_job(&Uuid::new_v4().to_string(), "0".repeat(64), false);
    regular.name = "optimization".into();
    recovery::persist(&state, &regular).ok().unwrap();
    recovery::set_latest(&state, &regular).ok().unwrap();

    // Records from before Optimize have no optimization flag.
    let mut legacy = serde_json::to_value(&regular).unwrap();
    legacy.as_object_mut().unwrap().remove("optimization");
    let legacy = serde_json::to_vec(&legacy).unwrap();
    let record = root
        .path()
        .join(format!(".spec-output/{}.json", regular.id));
    fs::write(&record, &legacy).unwrap();
    let file_pointer = root.path().join(format!(
        ".spec-output/latest-{:x}",
        Sha256::digest(b"optimization")
    ));
    assert_eq!(fs::read_to_string(&file_pointer).unwrap(), regular.id);
    assert_eq!(
        json(request(app(root.path()), "GET", "/api/optimize", Value::Null).await).await,
        Value::Null
    );

    let mut optimizer = persisted_job(&Uuid::new_v4().to_string(), "0".repeat(64), false);
    optimizer.name = "optimization".into();
    optimizer.optimization = true;
    recovery::persist(&state, &optimizer).ok().unwrap();
    recovery::set_latest(&state, &optimizer).ok().unwrap();
    let optimizer_pointer = root.path().join(".spec-output/latest-optimization");
    assert_eq!(
        fs::read_to_string(&optimizer_pointer).unwrap(),
        optimizer.id
    );
    assert_eq!(fs::read_to_string(&file_pointer).unwrap(), regular.id);
    assert_eq!(fs::read(&record).unwrap(), legacy);
    for (route, id, continuable) in [
        ("/api/files/optimization/run", &regular.id, true),
        ("/api/optimize", &optimizer.id, false),
    ] {
        let response = request(app(root.path()), "GET", route, Value::Null).await;
        assert_eq!(response.status(), StatusCode::OK);
        let output = json(response).await;
        assert_eq!(output["id"], *id);
        assert_eq!(output["continuable"], continuable);
    }

    // A valid ID of the wrong run kind must not cross the namespace boundary.
    fs::write(&optimizer_pointer, &regular.id).unwrap();
    fs::write(&file_pointer, &optimizer.id).unwrap();
    for route in ["/api/optimize", "/api/files/optimization/run"] {
        let response = request(app(root.path()), "GET", route, Value::Null).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json(response).await["error"], "Latest run kind mismatch");
    }
}

#[tokio::test]
async fn optimization_missing_config_fails_with_durable_diagnostic() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    fs::write(root.path().join("a.md"), "Pending requirement\n").unwrap();
    let build_id = build(&state, "a.md").await;
    let original = terminal(&state, &build_id, "completed").await;
    let id = start_optimization(&state).await;
    let output = terminal(&state, &id, "failed (exit status: 1)").await;
    assert_eq!(output["continuable"], false);
    assert!(output["output"].as_str().unwrap().contains(".optim"));
    let directory = root.path().join(format!(".spec-runs/run-{id}"));
    let report: Value =
        serde_json::from_str(&fs::read_to_string(directory.join("report.jsonl")).unwrap()).unwrap();
    assert_eq!(report["event"], "final");
    assert_eq!(report["outcome"], "failed");
    assert!(report["error"].as_str().unwrap().contains(".optim"));
    assert_eq!(fs::read_to_string(directory.join("status")).unwrap(), "1\n");
    let fresh = app(root.path());
    assert_eq!(
        json(request(fresh.clone(), "GET", "/api/optimize", Value::Null).await).await,
        output
    );
    assert_eq!(
        json(request(fresh, "GET", "/api/files/a.md/run", Value::Null).await).await,
        original
    );
}

#[tokio::test]
async fn optimization_remote_disabled_does_not_create_a_job() {
    let root = tempfile::tempdir().unwrap();
    let state = app(root.path());
    assert_eq!(
        json(request(state.clone(), "GET", "/api/optimize", Value::Null).await).await,
        Value::Null
    );
    let response = request(state.clone(), "POST", "/api/optimize", body!({})).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(
        json(response).await["error"]
            .as_str()
            .unwrap()
            .contains("Remote execution is disabled")
    );
    assert!(state.jobs.lock().unwrap().is_empty());
    assert!(!root.path().join(".spec-runs").exists());
}

#[tokio::test]
async fn optimization_mutual_exclusion_restart_and_cancellation_kill_descendants() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    fs::write(root.path().join("a.md"), "Pending requirement\n").unwrap();
    fs::write(root.path().join("hold-build"), "").unwrap();
    let build_id = build(&state, "a.md").await;
    wait_for_file(&root.path().join("build-started")).await;
    let response = request(state.clone(), "POST", "/api/optimize", body!({})).await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(state.jobs.lock().unwrap().len(), 1);
    assert_eq!(
        request(
            state.clone(),
            "POST",
            &format!("/api/runs/{build_id}/cancel"),
            body!({})
        )
        .await
        .status(),
        StatusCode::OK
    );
    terminal(&state, &build_id, "cancelled").await;

    objective(
        root.path(),
        "import os, subprocess, time; from pathlib import Path; child=subprocess.Popen(['python3','-c','import time; time.sleep(60)']); Path('optimizer-pids').write_text(str(os.getpid())+' '+str(child.pid)); time.sleep(60)",
    );
    let (first, second) = tokio::join!(
        request(state.clone(), "POST", "/api/optimize", body!({})),
        request(state.clone(), "POST", "/api/optimize", body!({}))
    );
    let (accepted, rejected) = if first.status() == StatusCode::OK {
        (first, second)
    } else {
        (second, first)
    };
    assert_eq!(accepted.status(), StatusCode::OK);
    assert_eq!(rejected.status(), StatusCode::CONFLICT);
    let id = json(accepted).await["id"].as_str().unwrap().to_owned();
    wait_for_file(&root.path().join("optimizer-pids")).await;
    assert_eq!(state.jobs.lock().unwrap().len(), 2);
    let revision = read(root.path(), "a.md").ok().unwrap().revision;
    assert_eq!(
        request(
            state.clone(),
            "POST",
            "/api/runs",
            body!({"name":"a.md", "revision":revision})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );

    // Match backend shutdown before reopening the durable job in a fresh App.
    state
        .jobs
        .lock()
        .unwrap()
        .iter()
        .find(|job| job.id == id)
        .unwrap()
        .stop
        .send(RunControl::Detach)
        .unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let guard = state.recovery_gate.lock().await;
            if !state
                .jobs
                .lock()
                .unwrap()
                .iter()
                .find(|job| job.id == id)
                .unwrap()
                .attached
            {
                break;
            }
            drop(guard);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let remote = state.remote.clone();
    drop(state);
    let mut fresh = app(root.path());
    fresh.remote = remote;
    let running = json(request(fresh.clone(), "GET", "/api/optimize", Value::Null).await).await;
    assert_eq!(running["id"], id);
    assert_eq!(running["status"], "running");
    assert_eq!(running["recoverable"], true);
    assert_eq!(running["continuable"], false);
    assert!(running["output"].as_str().unwrap().contains("throughput"));
    assert_eq!(
        request(fresh.clone(), "POST", "/api/optimize", body!({}))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            fresh.clone(),
            "POST",
            "/api/runs",
            body!({"name":"a.md", "revision":revision})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            fresh.clone(),
            "POST",
            &format!("/api/runs/{id}/cancel"),
            body!({})
        )
        .await
        .status(),
        StatusCode::OK
    );
    let cancelled = terminal(&fresh, &id, "cancelled").await;
    let directory = root.path().join(format!(".spec-runs/run-{id}"));
    assert_eq!(
        fs::read_to_string(directory.join("status")).unwrap(),
        "130\n"
    );
    assert!(!directory.join("snapshot.md").exists());
    for pid in fs::read_to_string(root.path().join("optimizer-pids"))
        .unwrap()
        .split_whitespace()
    {
        // A killed process can remain a zombie until the container's init reaps it.
        if let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) {
            assert_eq!(
                stat.split(") ").nth(1).unwrap().chars().next(),
                Some('Z'),
                "child {pid} survived cancellation"
            );
        }
    }
    assert_eq!(
        json(request(app(root.path()), "GET", "/api/optimize", Value::Null).await).await,
        cancelled
    );
}
