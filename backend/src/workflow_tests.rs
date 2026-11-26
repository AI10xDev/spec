use super::*;
use serde_json::{Value, json as body};

fn fixture(root: &FsPath) -> App {
    let mut state = app(root);
    let runner = root.join("workflow-runner");
    state.remote = Some(remote_fixture(root, &runner));
    fs::write(
        root.join(".bash_aliases"),
        format!("export SPEC_WORKFLOW_RUNNER='{}'\n", runner.display()),
    )
    .unwrap();
    fs::write(&runner, r#"#!/bin/bash
set -eu
if [[ ${1:-} == --workflow-version ]]; then printf 'spec-workflow-v1\n'; exit; fi
directory=${SPEC_BUILD_RESULT_FILE%/*}
printf '%s\n' "$SPEC_BUILD_STAGE" >> "$HOME/launches"
cat "$1" > "$directory/received"
printf '%s' "${SPEC_BUILD_SESSION_ID:-}" > "$directory/received-session"
if [[ -n ${SPEC_BUILD_HANDOFF_FILE:-} ]]; then cp "$SPEC_BUILD_HANDOFF_FILE" "$directory/received-handoff"; fi
if [[ -z ${SPEC_BUILD_SESSION_ID:-} ]]; then printf 'ses_%s\n' "$SPEC_BUILD_STAGE" > "$SPEC_BUILD_SESSION_FILE"; fi
printf 'This log is not the handoff.\n'
if [[ -f "$HOME/wait" ]]; then touch "$HOME/entered"; while [[ ! -f "$HOME/release" ]]; do sleep 0.02; done; fi
if [[ -f "$HOME/missing-result" ]]; then exit 0; fi
python3 - "$SPEC_BUILD_RESULT_FILE" "$SPEC_BUILD_STAGE" "$1" <<'PY'
import json, sys
with open(sys.argv[1], 'w') as output:
    json.dump({'version': 1, 'stage': sys.argv[2], 'report': 'Validated report: ' + open(sys.argv[3]).read()}, output)
PY
"#).unwrap();
    fs::set_permissions(&runner, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(root.join("a.md"), "Original immutable spec\n").unwrap();
    state
}

async fn start(state: &App) -> String {
    let revision = read(&state.root, "a.md").ok().unwrap().revision;
    let response = request(
        state.clone(),
        "POST",
        "/api/runs",
        body!({"name":"a.md", "revision":revision}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    json(response).await["id"].as_str().unwrap().into()
}

async fn finished(state: &App, id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(12), async {
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
            if output["recoverable"] == false
                && !state
                    .jobs
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|job| job.id == id && job.attached)
            {
                return output;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("staged run did not finish")
}

async fn followup(state: &App, id: &str, message: &str) -> String {
    let response = request(
        state.clone(),
        "POST",
        &format!("/api/runs/{id}/continue"),
        body!({"message":message}),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "{}",
        json(response).await
    );
    json(response).await["id"].as_str().unwrap().into()
}

#[tokio::test]
async fn workflow_approval_is_explicit_durable_and_fresh_with_immutable_handoff() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let builder = start(&state).await;
    let output = finished(&state, &builder).await;
    assert_eq!(output["status"], "completed");
    assert_eq!(output["stage"], "builder");
    assert_eq!(output["approvable"], true);
    assert_eq!(
        output["report"],
        "Validated report: Original immutable spec\n"
    );
    let revised = followup(&state, &builder, "Explore another option, not approval").await;
    let output = finished(&state, &revised).await;
    assert_eq!(output["stage"], "builder");
    let handoff = output["report"].clone();
    assert_eq!(
        fs::read_to_string(
            root.path()
                .join(format!(".spec-runs/run-{revised}/received-session"))
        )
        .unwrap(),
        "ses_builder"
    );
    assert_eq!(
        request(
            state.clone(),
            "POST",
            &format!("/api/runs/{builder}/approve"),
            body!({})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let mut fresh = app(root.path());
    fresh.remote = state.remote.clone();
    let path = format!("/api/runs/{revised}/approve");
    let (a, b) = tokio::join!(
        request(fresh.clone(), "POST", &path, body!({})),
        request(fresh.clone(), "POST", &path, body!({}))
    );
    let accepted = if a.status() == StatusCode::OK {
        assert_eq!(b.status(), StatusCode::CONFLICT);
        a
    } else {
        assert_eq!(a.status(), StatusCode::CONFLICT);
        assert_eq!(b.status(), StatusCode::OK);
        b
    };
    let integrator = json(accepted).await["id"].as_str().unwrap().to_owned();
    let output = finished(&fresh, &integrator).await;
    assert_eq!(output["stage"], "integrator");
    assert_eq!(output["status"], "completed");
    assert_eq!(output["approvable"], false);
    fs::write(root.path().join("a.md"), "Edited after approval").unwrap();
    let directory = root.path().join(format!(".spec-runs/run-{integrator}"));
    assert_eq!(
        fs::read_to_string(directory.join("received")).unwrap(),
        "Original immutable spec\n"
    );
    assert_eq!(
        fs::read_to_string(directory.join("received-session")).unwrap(),
        ""
    );
    let original_handoff = fs::read(directory.join("received-handoff")).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&original_handoff).unwrap()["report"],
        handoff
    );
    let continued = followup(&fresh, &integrator, "Run additional integration checks").await;
    let output = finished(&fresh, &continued).await;
    assert_eq!(output["stage"], "integrator");
    assert_eq!(
        output["report"],
        "Validated report: Run additional integration checks"
    );
    let directory = root.path().join(format!(".spec-runs/run-{continued}"));
    assert_eq!(
        fs::read(directory.join("received-handoff")).unwrap(),
        original_handoff
    );
    assert_eq!(
        fs::read_to_string(directory.join("received-session")).unwrap(),
        "ses_integrator"
    );
    assert_eq!(
        fs::read_to_string(directory.join("received")).unwrap(),
        "Run additional integration checks"
    );
    let job = recovery::load(&fresh, &continued).ok().unwrap();
    assert_eq!(job.snapshot.as_deref(), Some("Original immutable spec\n"));
    let mut restarted = app(root.path());
    restarted.remote = fresh.remote.clone();
    assert_eq!(
        request(restarted.clone(), "POST", &path, body!({}))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            restarted,
            "POST",
            &format!("/api/runs/{continued}/approve"),
            body!({})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        fs::read_to_string(root.path().join("launches")).unwrap(),
        "builder\nbuilder\nintegrator\nintegrator\n"
    );
}

#[tokio::test]
async fn workflow_rejects_active_wrong_remote_legacy_and_persistence_errors() {
    for case in ["active", "wrong-remote", "legacy", "persistence", "dirty"] {
        let root = tempfile::tempdir().unwrap();
        let mut state = fixture(root.path());
        let id = start(&state).await;
        finished(&state, &id).await;
        {
            let mut jobs = state.jobs.lock().unwrap();
            let job = jobs.iter_mut().find(|job| job.id == id).unwrap();
            match case {
                "active" => job.attached = true,
                "legacy" => {
                    job.stage = None;
                    job.snapshot = None;
                    job.build_result = None;
                }
                "persistence" => job.persistence_error = Some("failed checkpoint".into()),
                "dirty" => job.dirty = true,
                _ => {}
            }
        }
        if case == "wrong-remote" {
            state.remote.as_mut().unwrap().target = "other@host".into();
        }
        assert_eq!(
            request(
                state.clone(),
                "POST",
                &format!("/api/runs/{id}/approve"),
                body!({})
            )
            .await
            .status(),
            StatusCode::CONFLICT,
            "{case}"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("launches")).unwrap(),
            "builder\n",
            "{case}"
        );
    }
}

#[tokio::test]
async fn workflow_requires_empty_approval_body_and_has_no_performance_approval() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let id = start(&state).await;
    finished(&state, &id).await;
    for input in [
        body!({"message":"approve"}),
        body!({"stage":"integrator"}),
        Value::Null,
    ] {
        assert_eq!(
            request(
                state.clone(),
                "POST",
                &format!("/api/runs/{id}/approve"),
                input
            )
            .await
            .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    assert_eq!(
        request(
            state.clone(),
            "POST",
            &format!("/api/performance/runs/{id}/approve"),
            body!({})
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        fs::read_to_string(root.path().join("launches")).unwrap(),
        "builder\n"
    );
}

#[tokio::test]
async fn workflow_successful_exit_without_private_result_is_not_success_or_approval() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    fs::write(root.path().join("missing-result"), "").unwrap();
    let id = start(&state).await;
    let output = finished(&state, &id).await;
    assert!(
        output["status"]
            .as_str()
            .unwrap()
            .starts_with("failed (invalid or missing build result"),
        "{output}"
    );
    assert_eq!(output["approvable"], false);
    assert_eq!(output["report"], Value::Null);
    assert_eq!(
        request(
            state.clone(),
            "POST",
            &format!("/api/runs/{id}/approve"),
            body!({})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let output = json(request(state, "GET", "/api/files/a.md/run/log", Value::Null).await).await;
    assert_ne!(output["status"], "completed");
    assert_eq!(output["approvable"], false);
}

#[test]
fn workflow_record_budget_covers_maximally_escaped_snapshot_result_and_handoff() {
    let root = tempfile::tempdir().unwrap();
    let state = app(root.path());
    let mut job = persisted_job(&Uuid::new_v4().to_string(), "a".repeat(64), false);
    job.stage = Some("integrator".into());
    job.snapshot = Some(format!("x{}", "\u{1}".repeat(MAX_BUILD_SPEC - 1)));
    job.build_result = Some(remote::BuildResult {
        version: 1,
        stage: "integrator".into(),
        report: job.snapshot.clone().unwrap(),
    });
    job.approved_handoff = Some(remote::BuildResult {
        version: 1,
        stage: "builder".into(),
        report: job.snapshot.clone().unwrap(),
    });
    job.output = vec![255; MAX_OUTPUT].into();
    recovery::persist(&state, &job).ok().unwrap();
    let restored = recovery::load(&state, &job.id).ok().unwrap();
    assert_eq!(restored.snapshot, job.snapshot);
    assert_eq!(
        restored.approved_handoff.unwrap().report.len(),
        MAX_BUILD_SPEC
    );
}

#[test]
fn workflow_legacy_records_default_to_no_stage_and_never_invent_a_handoff() {
    let root = tempfile::tempdir().unwrap();
    let state = app(root.path());
    let job = persisted_job(&Uuid::new_v4().to_string(), "a".repeat(64), false);
    let mut value = serde_json::to_value(&job).unwrap();
    for field in ["stage", "snapshot", "build_result", "approved_handoff"] {
        value.as_object_mut().unwrap().remove(field);
    }
    let legacy: Job = serde_json::from_value(value).unwrap();
    assert!(workflow::validate(&legacy).is_ok());
    assert!(legacy.stage.is_none());
    assert!(legacy.snapshot.is_none());
    assert!(legacy.approved_handoff.is_none());
    let _files = state.files.lock().unwrap();
    assert!(!workflow::approvable(&state, &legacy).ok().unwrap());
}

#[tokio::test]
async fn workflow_recovery_retries_result_transport_failure_and_persists_private_report() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let id = start(&state).await;
    let completed = finished(&state, &id).await;
    let mut job = recovery::load(&state, &id).ok().unwrap();
    job.recover = true;
    job.status = "running".into();
    job.build_result = None;
    recovery::persist(&state, &job).ok().unwrap();
    let mut fresh = app(root.path());
    fresh.remote = state.remote.clone();
    fs::write(root.path().join("block-result"), "").unwrap();
    fs::write(&fresh.remote.as_ref().unwrap().binary, format!(r#"#!/bin/bash
export HOME='{}'
if [[ ${{!#}} == *'Read a successful staged result'* && -f "$HOME/block-result" ]]; then exit 255; fi
exec /bin/bash -c "${{!#}}"
"#, root.path().display())).unwrap();
    for route in [format!("/api/runs/{id}"), "/api/files/a.md/run/log".into()] {
        let output = json(request(fresh.clone(), "GET", &route, Value::Null).await).await;
        assert_eq!(output["recoverable"], true, "{output}");
        assert_eq!(output["approvable"], false);
        assert_eq!(output["report"], Value::Null);
        assert!(
            output["status"]
                .as_str()
                .unwrap()
                .starts_with("unknown (build result unavailable")
        );
        assert_eq!(
            request(
                fresh.clone(),
                "POST",
                &format!("/api/runs/{id}/approve"),
                body!({})
            )
            .await
            .status(),
            StatusCode::CONFLICT
        );
    }
    fs::remove_file(root.path().join("block-result")).unwrap();
    let recovered = finished(&fresh, &id).await;
    assert_eq!(recovered["status"], "completed");
    assert_eq!(recovered["report"], completed["report"]);
    assert_eq!(recovered["approvable"], true);
    let restored = recovery::load(&fresh, &id).ok().unwrap();
    assert!(!restored.recover);
    assert_eq!(
        restored.build_result.unwrap().report,
        completed["report"].as_str().unwrap()
    );
}

#[tokio::test]
async fn workflow_disk_log_and_recovery_reject_invalid_results_instead_of_using_logs() {
    for disk_log in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let state = fixture(root.path());
        let id = start(&state).await;
        finished(&state, &id).await;
        let mut job = recovery::load(&state, &id).ok().unwrap();
        job.recover = true;
        job.status = "running".into();
        job.build_result = None;
        recovery::persist(&state, &job).ok().unwrap();
        fs::write(
            root.path().join(format!(".spec-runs/run-{id}/result.json")),
            r#"{"version":1,"stage":"integrator","report":"Mismatched stage"}"#,
        )
        .unwrap();
        let mut fresh = app(root.path());
        fresh.remote = state.remote.clone();
        let route = if disk_log {
            "/api/files/a.md/run/log".into()
        } else {
            format!("/api/runs/{id}")
        };
        let output = json(request(fresh.clone(), "GET", &route, Value::Null).await).await;
        assert!(
            output["status"]
                .as_str()
                .unwrap()
                .starts_with("failed (invalid or missing build result"),
            "{output}"
        );
        assert_eq!(output["recoverable"], false);
        assert_eq!(output["approvable"], false);
        assert_eq!(output["report"], Value::Null);
        assert_eq!(
            request(
                fresh.clone(),
                "POST",
                &format!("/api/runs/{id}/approve"),
                body!({})
            )
            .await
            .status(),
            StatusCode::CONFLICT
        );
        assert!(
            recovery::load(&fresh, &id)
                .ok()
                .unwrap()
                .build_result
                .is_none()
        );
    }
}

#[tokio::test]
async fn workflow_queue_after_integrator_starts_a_new_builder_without_inheriting_approval() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let builder = start(&state).await;
    finished(&state, &builder).await;
    let response = request(
        state.clone(),
        "POST",
        &format!("/api/runs/{builder}/approve"),
        body!({}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let integrator = json(response).await["id"].as_str().unwrap().to_owned();
    finished(&state, &integrator).await;
    fs::write(root.path().join("a.md"), "New queued requirements").unwrap();
    let document = read(root.path(), "a.md").ok().unwrap();
    let response = request(
        state.clone(),
        "POST",
        &format!("/api/runs/{integrator}/queued-build"),
        body!({"name":document.name,"revision":document.revision}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    queued_builds::dispatch(&state).await.ok().unwrap();
    let child = recovery::latest(&state, "a.md").ok().unwrap().unwrap();
    assert_ne!(child, integrator);
    let output = finished(&state, &child).await;
    assert_eq!(output["stage"], "builder");
    assert_eq!(output["approvable"], true);
    let job = recovery::load(&state, &child).ok().unwrap();
    assert_eq!(job.snapshot.as_deref(), Some("New queued requirements"));
    assert!(job.approved_handoff.is_none());
    assert_eq!(
        fs::read_to_string(
            root.path()
                .join(format!(".spec-runs/run-{child}/received-session"))
        )
        .unwrap(),
        ""
    );
}

#[tokio::test]
async fn workflow_approval_rejects_unsafe_durable_storage_without_launch() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let id = start(&state).await;
    finished(&state, &id).await;
    fs::set_permissions(
        root.path().join(format!(".spec-output/{id}.json")),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    let response = request(state, "POST", &format!("/api/runs/{id}/approve"), body!({})).await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        fs::read_to_string(root.path().join("launches")).unwrap(),
        "builder\n"
    );
}

#[tokio::test]
async fn workflow_changed_or_missing_saved_spec_is_not_approvable_after_restart() {
    for missing in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let state = fixture(root.path());
        let id = start(&state).await;
        finished(&state, &id).await;
        if missing {
            fs::remove_file(root.path().join("a.md")).unwrap();
        } else {
            let revision = read(root.path(), "a.md").ok().unwrap().revision;
            let response = request(
                state.clone(),
                "PUT",
                "/api/files/a.md",
                body!({"content":"New saved requirements", "revision":revision}),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
        }
        let mut fresh = app(root.path());
        fresh.remote = state.remote.clone();
        for route in [
            format!("/api/runs/{id}"),
            "/api/files/a.md/run".into(),
            "/api/files/a.md/run/log".into(),
        ] {
            let response = request(fresh.clone(), "GET", &route, Value::Null).await;
            assert_eq!(response.status(), StatusCode::OK);
            let output = json(response).await;
            assert_eq!(output["status"], "completed");
            assert_eq!(output["approvable"], false, "{route}: {output}");
        }
        assert_eq!(
            request(
                fresh.clone(),
                "POST",
                &format!("/api/runs/{id}/approve"),
                body!({})
            )
            .await
            .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            fs::read_to_string(root.path().join("launches")).unwrap(),
            "builder\n"
        );
        assert_eq!(
            recovery::latest(&fresh, "a.md").ok().unwrap().as_deref(),
            Some(id.as_str())
        );
        if !missing {
            let next = start(&fresh).await;
            assert_eq!(finished(&fresh, &next).await["approvable"], true);
            let response = request(
                fresh.clone(),
                "POST",
                &format!("/api/runs/{next}/approve"),
                body!({}),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            let integrator = json(response).await["id"].as_str().unwrap().to_owned();
            assert_eq!(finished(&fresh, &integrator).await["status"], "completed");
            assert_eq!(
                fs::read_to_string(
                    root.path()
                        .join(format!(".spec-runs/run-{integrator}/received"))
                )
                .unwrap(),
                "New saved requirements"
            );
        }
    }
}

#[tokio::test]
async fn workflow_approval_rechecks_saved_spec_after_waiting_for_admission() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let id = start(&state).await;
    finished(&state, &id).await;
    let admission = state.recovery_gate.lock().await;
    let path = format!("/api/runs/{id}/approve");
    let approval = request(state.clone(), "POST", &path, body!({}));
    tokio::pin!(approval);
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut approval)
            .await
            .is_err()
    );
    let revision = read(root.path(), "a.md").ok().unwrap().revision;
    let response = request(
        state.clone(),
        "PUT",
        "/api/files/a.md",
        body!({"content":"Changed during admission", "revision":revision}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    drop(admission);
    assert_eq!(approval.await.status(), StatusCode::CONFLICT);
    assert_eq!(
        fs::read_to_string(root.path().join("launches")).unwrap(),
        "builder\n"
    );
}

#[tokio::test]
async fn workflow_pending_queue_blocks_approval_even_when_editor_matches_original_again() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let id = start(&state).await;
    finished(&state, &id).await;
    fs::write(root.path().join("a.md"), "Queued new spec").unwrap();
    let revision = read(root.path(), "a.md").ok().unwrap().revision;
    let response = request(
        state.clone(),
        "POST",
        &format!("/api/runs/{id}/queued-build"),
        body!({"name":"a.md","revision":revision}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    fs::write(root.path().join("a.md"), "Original immutable spec\n").unwrap();
    let mut fresh = app(root.path());
    fresh.remote = state.remote.clone();
    let output = json(
        request(
            fresh.clone(),
            "GET",
            &format!("/api/runs/{id}"),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(output["approvable"], false);
    assert_eq!(
        request(
            fresh.clone(),
            "POST",
            &format!("/api/runs/{id}/approve"),
            body!({})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        fs::read_to_string(root.path().join("launches")).unwrap(),
        "builder\n"
    );
    assert_eq!(
        request(
            fresh.clone(),
            "DELETE",
            &format!("/api/runs/{id}/queued-build"),
            Value::Null
        )
        .await
        .status(),
        StatusCode::OK
    );
    let output = json(request(fresh, "GET", &format!("/api/runs/{id}"), Value::Null).await).await;
    assert_eq!(output["approvable"], true);
}

#[tokio::test]
async fn workflow_queue_and_approval_cannot_both_be_admitted() {
    for queue_first in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let state = fixture(root.path());
        let id = start(&state).await;
        finished(&state, &id).await;
        let revision = read(root.path(), "a.md").ok().unwrap().revision;
        let admission = state.recovery_gate.lock().await;
        let queue_path = format!("/api/runs/{id}/queued-build");
        let approval_path = format!("/api/runs/{id}/approve");
        let queue = request(
            state.clone(),
            "POST",
            &queue_path,
            body!({"name":"a.md","revision":revision}),
        );
        let approval = request(state.clone(), "POST", &approval_path, body!({}));
        tokio::pin!(queue, approval);
        // Poll each request to the locked, FIFO admission gate in a known order.
        if queue_first {
            assert!(
                tokio::time::timeout(Duration::from_millis(30), &mut queue)
                    .await
                    .is_err()
            );
            assert!(
                tokio::time::timeout(Duration::from_millis(30), &mut approval)
                    .await
                    .is_err()
            );
        } else {
            assert!(
                tokio::time::timeout(Duration::from_millis(30), &mut approval)
                    .await
                    .is_err()
            );
            assert!(
                tokio::time::timeout(Duration::from_millis(30), &mut queue)
                    .await
                    .is_err()
            );
        }
        drop(admission);
        let (queue, approval) = tokio::join!(queue, approval);
        assert_eq!(
            queue.status(),
            if queue_first {
                StatusCode::OK
            } else {
                StatusCode::CONFLICT
            }
        );
        assert_eq!(
            approval.status(),
            if queue_first {
                StatusCode::CONFLICT
            } else {
                StatusCode::OK
            }
        );
        if !queue_first {
            let integrator = json(approval).await["id"].as_str().unwrap().to_owned();
            finished(&state, &integrator).await;
        }
        let queued =
            json(request(state.clone(), "GET", "/api/queued-builds", Value::Null).await).await;
        assert_eq!(queued.as_array().unwrap().len(), usize::from(queue_first));
        assert_eq!(
            fs::read_to_string(root.path().join("launches")).unwrap(),
            if queue_first {
                "builder\n"
            } else {
                "builder\nintegrator\n"
            }
        );
    }
}

#[tokio::test]
async fn workflow_local_spawn_failure_restores_builder_and_allows_approval_retry() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let id = start(&state).await;
    finished(&state, &id).await;
    let binary = &state.remote.as_ref().unwrap().binary;
    let launcher = fs::read(binary).unwrap();
    fs::remove_file(binary).unwrap();
    let path = format!("/api/runs/{id}/approve");
    assert_eq!(
        request(state.clone(), "POST", &path, body!({}))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        recovery::latest(&state, "a.md").ok().unwrap().as_deref(),
        Some(id.as_str())
    );
    let failed = {
        let jobs = state.jobs.lock().unwrap();
        let job = jobs.iter().find(|job| job.id != id).unwrap();
        assert!(job.status.starts_with("failed to start SSH"));
        assert!(!job.attached && !job.recover);
        job.id.clone()
    };
    assert!(
        !root
            .path()
            .join(format!(".spec-runs/run-{failed}"))
            .exists()
    );
    assert_eq!(
        fs::read_to_string(root.path().join("launches")).unwrap(),
        "builder\n"
    );
    let mut fresh = app(root.path());
    fresh.remote = state.remote.clone();
    let output = json(
        request(
            fresh.clone(),
            "GET",
            &format!("/api/runs/{id}"),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(output["approvable"], true);
    fs::write(binary, launcher).unwrap();
    fs::set_permissions(binary, fs::Permissions::from_mode(0o700)).unwrap();
    let response = request(fresh.clone(), "POST", &path, body!({})).await;
    assert_eq!(response.status(), StatusCode::OK);
    let integrator = json(response).await["id"].as_str().unwrap().to_owned();
    assert_ne!(integrator, failed);
    assert_eq!(finished(&fresh, &integrator).await["status"], "completed");
    assert_eq!(
        fs::read_to_string(root.path().join("launches")).unwrap(),
        "builder\nintegrator\n"
    );
}

#[tokio::test]
async fn workflow_verified_terminal_output_keeps_polling_until_attachment_finalizes() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let id = start(&state).await;
    finished(&state, &id).await;
    // Retain a live attachment control while the real remote result is already
    // terminal. This deterministically exercises disk-read-before-teardown.
    let mut control = {
        let mut jobs = state.jobs.lock().unwrap();
        let job = jobs.iter_mut().find(|job| job.id == id).unwrap();
        let (stop, control) = watch::channel(RunControl::Running);
        job.stop = stop;
        job.attached = true;
        job.recover = true;
        job.status = "running".into();
        job.build_result = None;
        recovery::persist(&state, job).ok().unwrap();
        control
    };
    let disk =
        json(request(state.clone(), "GET", "/api/files/a.md/run/log", Value::Null).await).await;
    assert_eq!(disk["status"], "completed");
    assert_eq!(disk["recoverable"], true);
    assert_eq!(disk["approvable"], false);
    assert_eq!(
        disk["report"],
        "Validated report: Original immutable spec\n"
    );
    control.changed().await.unwrap();
    assert!(*control.borrow() == RunControl::Detach);
    let output = json(
        request(
            state.clone(),
            "GET",
            &format!("/api/runs/{id}"),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(output["status"], "completed");
    assert_eq!(output["recoverable"], true);
    assert_eq!(output["approvable"], false);
    fs::write(
        &state.remote.as_ref().unwrap().binary,
        "#!/bin/sh\nexit 255\n",
    )
    .unwrap();
    let unavailable =
        json(request(state.clone(), "GET", "/api/files/a.md/run/log", Value::Null).await).await;
    assert!(
        unavailable["status"]
            .as_str()
            .unwrap()
            .starts_with("unavailable")
    );
    assert_eq!(unavailable["recoverable"], true);
    assert_eq!(unavailable["approvable"], false);
    // A closed control lets normal recovery finalize the attachment, without
    // losing the verified report or relying on another successful SSH read.
    drop(control);
    let output = json(
        request(
            state.clone(),
            "GET",
            &format!("/api/runs/{id}"),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(output["status"], "completed");
    assert_eq!(output["recoverable"], false);
    assert_eq!(output["approvable"], true);
}

#[tokio::test]
async fn workflow_postspawn_transport_failure_does_not_allow_duplicate_approval() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let id = start(&state).await;
    finished(&state, &id).await;
    fs::write(
        &state.remote.as_ref().unwrap().binary,
        "#!/bin/sh\nsleep 0.05\nexit 255\n",
    )
    .unwrap();
    let path = format!("/api/runs/{id}/approve");
    let response = request(state.clone(), "POST", &path, body!({})).await;
    assert_eq!(response.status(), StatusCode::OK);
    let integrator = json(response).await["id"].as_str().unwrap().to_owned();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let detached = state
                .jobs
                .lock()
                .unwrap()
                .iter()
                .any(|job| job.id == integrator && !job.attached);
            if detached {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let output = json(
        request(
            state.clone(),
            "GET",
            &format!("/api/runs/{integrator}"),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(output["recoverable"], true);
    assert_eq!(output["approvable"], false);
    assert_eq!(
        recovery::latest(&state, "a.md").ok().unwrap().as_deref(),
        Some(integrator.as_str())
    );
    assert_eq!(
        request(state, "POST", &path, body!({})).await.status(),
        StatusCode::CONFLICT
    );
}
