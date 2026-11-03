use super::*;
use serde_json::{Value, json as body};

fn fixture(root: &FsPath, recover: bool) -> (App, String) {
    let mut state = app(root);
    state.remote = Some(remote_fixture(root, &root.join("unused")));
    let id = Uuid::new_v4().to_string();
    let job = persisted_job(&id, state.remote.as_ref().unwrap().identity(), recover);
    recovery::persist(&state, &job).ok().unwrap();
    recovery::set_latest(&state, &job).ok().unwrap();
    fs::write(root.join("a.md"), "saved follow-up\n").unwrap();
    (state, id)
}

async fn enqueue(state: &App, id: &str) -> Value {
    let doc = read(&state.root, "a.md").ok().unwrap();
    let response = request(
        state.clone(),
        "POST",
        &format!("/api/runs/{id}/queued-build"),
        body!({"name":doc.name,"revision":doc.revision}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    json(response).await
}

async fn items(state: &App) -> Value {
    let response = request(state.clone(), "GET", "/api/queued-builds", Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    json(response).await
}

async fn terminal(state: &App, id: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let done = state.jobs.lock().unwrap().iter().any(|job| {
                job.id == id && !job.recover && !job.attached && job.status == "completed"
            });
            if done {
                break;
            }
            recovery::refresh(state, id, false).await.ok().unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("child did not finalize");
}

#[tokio::test]
async fn queued_build_snapshot_survives_autosave_and_restart_and_dispatches_once_without_browser() {
    let root = tempfile::tempdir().unwrap();
    let runner = root.path().join("runner");
    fs::write(
        &runner,
        r#"#!/bin/bash
[[ $# == 2 && $1 == build ]] || exit 90
printf 'build\n' >> launches
if [[ $(cat "$2") == parent ]]; then
  touch entered
  while [[ ! -f release ]]; do sleep 0.02; done
else
  cat "$2" > captured
fi
"#,
    )
    .unwrap();
    fs::set_permissions(&runner, fs::Permissions::from_mode(0o700)).unwrap();
    let mut state = app(root.path());
    state.remote = Some(remote_fixture(root.path(), &runner));
    fs::write(root.path().join("a.md"), "parent").unwrap();
    let revision = read(root.path(), "a.md").ok().unwrap().revision;
    let response = request(
        state.clone(),
        "POST",
        "/api/runs",
        body!({"name":"a.md","revision":revision}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let parent = json(response).await["id"].as_str().unwrap().to_owned();
    wait_for_file(&root.path().join("entered")).await;
    let captured = "# Already done\nImplement this saved follow-up\n$(touch injected)\n";
    let acknowledged = save(
        &state,
        "a.md",
        Save {
            content: captured.into(),
            revision: Some(revision),
        },
    )
    .ok()
    .unwrap();
    let item = enqueue(&state, &parent).await;
    assert_eq!(
        item,
        body!({"parent_id":parent,"name":"a.md","revision":acknowledged.revision,"status":"waiting"})
    );
    let later = save(
        &state,
        "a.md",
        Save {
            content: "later autosave, do not execute".into(),
            revision: Some(acknowledged.revision),
        },
    )
    .ok()
    .unwrap();
    queued_builds::dispatch(&state).await.ok().unwrap();
    assert_eq!(items(&state).await[0]["status"], "waiting");
    assert_eq!(
        fs::read_to_string(root.path().join("launches")).unwrap(),
        "build\n"
    );
    detach_and_wait(&state).await;
    let mut fresh = app(root.path());
    fresh.remote = state.remote.clone();
    assert_eq!(items(&fresh).await, body!([item]));
    fs::write(root.path().join("release"), "").unwrap();
    let worker = queued_builds::spawn(fresh.clone());
    let competing_check = {
        let fresh = fresh.clone();
        tokio::spawn(async move { queued_builds::dispatch(&fresh).await.ok().unwrap() })
    };
    let child = tokio::time::timeout(Duration::from_secs(12), async {
        loop {
            let list = items(&fresh).await;
            if list[0]["status"] == "started" {
                break list[0]["id"].as_str().unwrap().to_owned();
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap();
    terminal(&fresh, &child).await;
    competing_check.await.unwrap();
    worker.abort();
    let _ = worker.await;
    assert_ne!(parent, child);
    assert_eq!(
        fs::read_to_string(root.path().join("captured")).unwrap(),
        captured
    );
    assert_eq!(
        read(root.path(), "a.md").ok().unwrap().revision,
        later.revision
    );
    assert!(!root.path().join("injected").exists());
    let mut restarted = app(root.path());
    restarted.remote = fresh.remote.clone();
    queued_builds::dispatch(&restarted).await.ok().unwrap();
    assert_eq!(items(&restarted).await[0]["id"], child);
    assert_eq!(
        fs::read_to_string(root.path().join("launches")).unwrap(),
        "build\nbuild\n"
    );
    assert_eq!(
        recovery::latest(&restarted, "a.md")
            .ok()
            .unwrap()
            .as_deref(),
        Some(child.as_str())
    );
    let deleted = request(
        restarted.clone(),
        "DELETE",
        &format!("/api/runs/{parent}/queued-build"),
        Value::Null,
    )
    .await;
    assert_eq!(json(deleted).await, body!({"ok":true}));
    assert_eq!(items(&restarted).await, body!([]));
    assert_eq!(
        recovery::load(&restarted, &child).ok().unwrap().status,
        "completed"
    );
}

#[tokio::test]
async fn queued_build_duplicates_are_idempotent_after_edits_and_replacements_require_delete() {
    let root = tempfile::tempdir().unwrap();
    let (state, parent) = fixture(root.path(), true);
    let (first, second) = tokio::join!(enqueue(&state, &parent), enqueue(&state, &parent));
    assert_eq!(first, second);
    fs::write(root.path().join("a.md"), "a later saved revision").unwrap();
    let duplicate = request(
        state.clone(),
        "POST",
        &format!("/api/runs/{parent}/queued-build"),
        body!({"name":"a.md","revision":first["revision"]}),
    )
    .await;
    assert_eq!(json(duplicate).await, first);
    let revision = read(root.path(), "a.md").ok().unwrap().revision;
    let replacement = request(
        state.clone(),
        "POST",
        &format!("/api/runs/{parent}/queued-build"),
        body!({"name":"a.md","revision":revision}),
    )
    .await;
    assert_eq!(replacement.status(), StatusCode::CONFLICT);
    request(
        state.clone(),
        "DELETE",
        &format!("/api/runs/{parent}/queued-build"),
        Value::Null,
    )
    .await;
    assert_eq!(enqueue(&state, &parent).await["revision"], revision);
}

#[tokio::test]
async fn queued_build_requires_authoritative_success_and_finished_attachment() {
    for (recover, attached, status, expected) in [
        (true, false, "completed", "waiting"),
        (true, false, "unknown", "waiting"),
        (true, false, "unavailable", "waiting"),
        (false, true, "completed", "waiting"),
        (false, false, "cancelled", "paused"),
        (false, false, "failed (exit status: 1)", "paused"),
        (false, false, "timed out", "paused"),
        (false, false, "completed", "ready"),
    ] {
        let root = tempfile::tempdir().unwrap();
        let (state, parent) = fixture(root.path(), true);
        enqueue(&state, &parent).await;
        {
            let mut jobs = recovery::restore(&state, &parent).ok().unwrap();
            let job = jobs.iter_mut().find(|job| job.id == parent).unwrap();
            job.recover = recover;
            job.attached = attached;
            job.status = status.into();
            recovery::persist(&state, job).ok().unwrap();
        }
        let run = recovery::run_gate(&state, &parent).await;
        let admission = state.recovery_gate.lock().await;
        let prepared = queued_builds::prepare(&state, &parent).ok().unwrap();
        drop(admission);
        drop(run);
        assert_eq!(
            prepared.is_some(),
            expected == "ready",
            "{recover} {attached} {status}"
        );
        assert_eq!(
            items(&state).await[0]["status"],
            if expected == "ready" {
                "waiting"
            } else {
                expected
            }
        );
    }
}

#[tokio::test]
async fn queued_build_stop_revokes_before_run_gate_even_when_final_success_wins() {
    let root = tempfile::tempdir().unwrap();
    let (state, parent) = fixture(root.path(), true);
    enqueue(&state, &parent).await;
    let gate = recovery::run_gate(&state, &parent).await;
    let cancel_task = {
        let state = state.clone();
        let parent = parent.clone();
        tokio::spawn(async move {
            request(
                state,
                "POST",
                &format!("/api/runs/{parent}/cancel"),
                Value::Null,
            )
            .await
        })
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        while items(&state).await[0]["status"] != "paused" {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("Stop waited for the run gate before revoking the queue");
    {
        let mut jobs = recovery::restore(&state, &parent).ok().unwrap();
        let job = jobs.iter_mut().find(|job| job.id == parent).unwrap();
        job.status = "completed".into();
        job.recover = false;
        recovery::persist(&state, job).ok().unwrap();
    }
    drop(gate);
    assert_eq!(cancel_task.await.unwrap().status(), StatusCode::OK);
    let mut fresh = app(root.path());
    fresh.remote = state.remote.clone();
    queued_builds::dispatch(&fresh).await.ok().unwrap();
    assert_eq!(items(&fresh).await[0]["status"], "paused");
    request(
        fresh.clone(),
        "DELETE",
        &format!("/api/runs/{parent}/queued-build"),
        Value::Null,
    )
    .await;
    let revision = read(root.path(), "a.md").ok().unwrap().revision;
    let response = request(
        fresh.clone(),
        "POST",
        &format!("/api/runs/{parent}/queued-build"),
        body!({"name":"a.md","revision":revision}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert!(!root.path().join(".spec-runs").exists());
}

#[tokio::test]
async fn queued_build_restart_never_retries_claimed_or_uncertain_children() {
    for registered in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let (state, parent) = fixture(root.path(), false);
        enqueue(&state, &parent).await;
        let (_, _, child) = queued_builds::prepare(&state, &parent)
            .ok()
            .unwrap()
            .unwrap();
        {
            let _files = state.files.lock().unwrap();
            queued_builds::claim(&state, &parent, &child).ok().unwrap();
        }
        if registered {
            let job = persisted_job(&child, state.remote.as_ref().unwrap().identity(), true);
            recovery::persist(&state, &job).ok().unwrap();
            // Simulate crash before latest pointer and SSH launch as well.
        }
        let mut fresh = app(root.path());
        fresh.remote = state.remote.clone();
        for _ in 0..2 {
            queued_builds::dispatch(&fresh).await.ok().unwrap();
        }
        let list = items(&fresh).await;
        assert_eq!(
            list[0]["status"],
            if registered { "started" } else { "paused" }
        );
        assert_eq!(list[0]["id"], child);
        assert!(!root.path().join(".spec-runs").exists());
    }
}

#[tokio::test]
async fn queued_build_remote_unavailable_waits_without_claiming_attempt() {
    for recover in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let (state, parent) = fixture(root.path(), recover);
        enqueue(&state, &parent).await;
        fs::write(
            &state.remote.as_ref().unwrap().binary,
            "#!/bin/sh\nexit 255\n",
        )
        .unwrap();
        queued_builds::dispatch(&state).await.ok().unwrap();
        let list = items(&state).await;
        assert_eq!(list[0]["status"], "waiting");
        assert!(list[0].get("id").is_none());
        assert_eq!(
            recovery::latest(&state, "a.md").ok().unwrap().as_deref(),
            Some(parent.as_str())
        );
    }
}

#[tokio::test]
async fn queued_build_validates_snapshot_ownership_kind_latest_and_limits() {
    for case in [
        "revision",
        "invalid-revision",
        "name",
        "repository",
        "optimization",
        "stale",
        "remote",
        "empty",
        "large",
    ] {
        let root = tempfile::tempdir().unwrap();
        let (mut state, parent) = fixture(root.path(), true);
        match case {
            "repository" | "optimization" => {
                let mut job = recovery::load(&state, &parent).ok().unwrap();
                job.repository_save = case == "repository";
                job.optimization = case == "optimization";
                recovery::persist(&state, &job).ok().unwrap();
            }
            "stale" => {
                let job = persisted_job(
                    &Uuid::new_v4().to_string(),
                    state.remote.as_ref().unwrap().identity(),
                    false,
                );
                recovery::persist(&state, &job).ok().unwrap();
                recovery::set_latest(&state, &job).ok().unwrap();
            }
            "remote" => state.remote.as_mut().unwrap().target = "another@host".into(),
            "empty" => fs::write(root.path().join("a.md"), " \n").unwrap(),
            "large" => fs::write(root.path().join("a.md"), "a".repeat(MAX_BUILD_SPEC + 1)).unwrap(),
            _ => {}
        }
        let revision = match case {
            "revision" => "0".repeat(64),
            "invalid-revision" => "bad".into(),
            _ => read(root.path(), "a.md").ok().unwrap().revision,
        };
        let response = request(
            state.clone(),
            "POST",
            &format!("/api/runs/{parent}/queued-build"),
            body!({"name":if case == "name" {"b.md"} else {"a.md"},"revision":revision}),
        )
        .await;
        assert!(
            response.status().is_client_error(),
            "{case}: {}",
            response.status()
        );
        assert_eq!(items(&state).await, body!([]));
    }
}

#[tokio::test]
async fn queued_build_dispatch_rechecks_latest_remote_and_conflicting_runs() {
    for case in ["latest", "remote", "conflict"] {
        let root = tempfile::tempdir().unwrap();
        let (mut state, parent) = fixture(root.path(), false);
        enqueue(&state, &parent).await;
        // A non-launching stand-in supplies authoritative remote completion.
        fs::write(
            &state.remote.as_ref().unwrap().binary,
            "#!/bin/sh\nprintf 'SPEC-RUN-1 0 0\\n'\n",
        )
        .unwrap();
        let _control;
        match case {
            "remote" => state.remote.as_mut().unwrap().target = "changed@host".into(),
            "latest" => {
                let job = persisted_job(
                    &Uuid::new_v4().to_string(),
                    state.remote.as_ref().unwrap().identity(),
                    false,
                );
                recovery::persist(&state, &job).ok().unwrap();
                recovery::set_latest(&state, &job).ok().unwrap();
            }
            _ => {
                let mut job = persisted_job(
                    &Uuid::new_v4().to_string(),
                    state.remote.as_ref().unwrap().identity(),
                    true,
                );
                job.name = "another.md".into();
                job.attached = true;
                _control = job.stop.subscribe();
                recovery::persist(&state, &job).ok().unwrap();
                state.jobs.lock().unwrap().push(job);
            }
        }
        queued_builds::dispatch(&state).await.ok().unwrap();
        let list = items(&state).await;
        assert_eq!(
            list[0]["status"],
            if case == "conflict" {
                "waiting"
            } else {
                "paused"
            }
        );
        assert!(list[0].get("id").is_none());
    }
}

#[tokio::test]
async fn queued_build_concurrent_dispatch_and_delete_during_preflight_do_not_launch_twice() {
    for stop in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let (state, parent) = fixture(root.path(), false);
        enqueue(&state, &parent).await;
        fs::write(&state.remote.as_ref().unwrap().binary, format!(
            "#!/bin/bash\ntouch '{}/probe-entered'\nwhile [[ ! -f '{}/probe-release' ]]; do sleep 0.02; done\nprintf 'SPEC-RUN-1 0 0\\n'\n",
            root.path().display(), root.path().display())).unwrap();
        let first = {
            let state = state.clone();
            tokio::spawn(async move { queued_builds::dispatch(&state).await.ok().unwrap() })
        };
        wait_for_file(&root.path().join("probe-entered")).await;
        let second = {
            let state = state.clone();
            tokio::spawn(async move { queued_builds::dispatch(&state).await.ok().unwrap() })
        };
        let cancellation = {
            let state = state.clone();
            let parent = parent.clone();
            tokio::spawn(async move {
                request(
                    state,
                    if stop { "POST" } else { "DELETE" },
                    &format!(
                        "/api/runs/{parent}/{}",
                        if stop { "cancel" } else { "queued-build" }
                    ),
                    Value::Null,
                )
                .await
            })
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let list = items(&state).await;
                if list == body!([]) || list[0]["status"] == "paused" {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("queue revocation blocked on network IO");
        fs::write(root.path().join("probe-release"), "").unwrap();
        first.await.unwrap();
        second.await.unwrap();
        assert_eq!(cancellation.await.unwrap().status(), StatusCode::OK);
        assert_eq!(
            recovery::latest(&state, "a.md").ok().unwrap().as_deref(),
            Some(parent.as_str())
        );
        assert_eq!(state.jobs.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn queued_build_rejects_unsafe_or_corrupt_storage_and_enforces_queue_capacity() {
    let root = tempfile::tempdir().unwrap();
    let (state, parent) = fixture(root.path(), false);
    enqueue(&state, &parent).await;
    let path = root.path().join(".spec-output/queued-builds");
    let original = fs::read(&path).unwrap();
    let mut saved: Value = serde_json::from_slice(&original).unwrap();
    saved[0]["content"] = body!("tampered snapshot");
    fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
    assert_eq!(
        request(state.clone(), "GET", "/api/queued-builds", Value::Null)
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    fs::write(&path, &original).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        request(state.clone(), "GET", "/api/queued-builds", Value::Null)
            .await
            .status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let template: Value = serde_json::from_slice(&original).unwrap();
    let entries: Vec<_> = (0..32)
        .map(|_| {
            let mut entry = template[0].clone();
            entry["item"]["parent_id"] = body!(Uuid::new_v4().to_string());
            entry["child_id"] = body!(Uuid::new_v4().to_string());
            entry
        })
        .collect();
    fs::write(&path, serde_json::to_vec(&entries).unwrap()).unwrap();
    let revision = read(root.path(), "a.md").ok().unwrap().revision;
    let response = request(
        state.clone(),
        "POST",
        &format!("/api/runs/{parent}/queued-build"),
        body!({"name":"a.md","revision":revision}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(items(&state).await.as_array().unwrap().len(), 32);
}

#[tokio::test]
async fn queued_build_storage_errors_never_skip_attached_or_remote_stop() {
    for mode in ["attached", "remote", "remote-error"] {
        for failure in ["corrupt-queue", "unsafe-queue", "unsafe-marker"] {
            let root = tempfile::tempdir().unwrap();
            let (state, parent) = fixture(root.path(), true);
            enqueue(&state, &parent).await;
            let control = {
                let mut jobs = recovery::restore(&state, &parent).ok().unwrap();
                let job = jobs.iter_mut().find(|job| job.id == parent).unwrap();
                let (stop, control) = watch::channel(RunControl::Running);
                job.stop = stop;
                job.attached = mode == "attached";
                control
            };
            fs::write(&state.remote.as_ref().unwrap().binary, format!(
                "#!/bin/bash\n[[ ${{!#}} == *\" cancel 'a.md'\" ]] || exit 90\ntouch '{}/remote-stopped'\n{}\n",
                root.path().display(),
                if mode == "remote-error" { "exit 255" } else { "printf 'SPEC-RUN-1 130 0\\n'" },
            )).unwrap();
            let queue = root.path().join(".spec-output/queued-builds");
            let original = fs::read(&queue).unwrap();
            let marker = root.path().join(format!(".spec-output/stop-{parent}"));
            match failure {
                "corrupt-queue" => fs::write(&queue, "not JSON").unwrap(),
                "unsafe-queue" => {
                    fs::set_permissions(&queue, fs::Permissions::from_mode(0o644)).unwrap()
                }
                _ => fs::create_dir(&marker).unwrap(),
            }
            let response = request(
                state.clone(),
                "POST",
                &format!("/api/runs/{parent}/cancel"),
                Value::Null,
            )
            .await;
            assert_eq!(
                response.status(),
                if mode == "remote-error" {
                    StatusCode::BAD_GATEWAY
                } else {
                    StatusCode::OK
                }
            );
            let response = json(response).await;
            if mode == "remote-error" {
                let error = response["error"].as_str().unwrap();
                assert!(error.contains("255") && error.contains("queued build revocation"));
            } else {
                assert_eq!(response["ok"], true);
                assert!(response["queue_error"].as_str().is_some());
            }
            if mode == "attached" {
                assert!(*control.borrow() == RunControl::Cancel);
                assert!(!root.path().join("remote-stopped").exists());
            } else {
                assert!(root.path().join("remote-stopped").exists());
            }
            if failure != "unsafe-marker" {
                assert_eq!(fs::read(&marker).unwrap(), b"1");
                assert!(queued_builds::dispatch(&state).await.is_err());
                fs::write(&queue, original).unwrap();
                fs::set_permissions(&queue, fs::Permissions::from_mode(0o600)).unwrap();
            } else {
                // The marker failed, but pausing the queue was still durable.
                fs::remove_dir(&marker).unwrap();
            }
            let fresh = app(root.path());
            assert_eq!(items(&fresh).await[0]["status"], "paused");
            assert_eq!(items(&fresh).await[0]["id"], Value::Null);
        }
    }
}

#[tokio::test]
async fn queued_build_worker_retries_terminal_checkpoint_under_parent_gate() {
    let root = tempfile::tempdir().unwrap();
    let (state, parent) = fixture(root.path(), false);
    enqueue(&state, &parent).await;
    fs::write(&state.remote.as_ref().unwrap().binary, format!(
        "#!/bin/bash\nif [[ ${{!#}} == *\" snapshot 'a.md'\" ]]; then\n  printf 'SPEC-RUN-1 0 0\\n'\nelse\n  printf 'build\\n' >> '{}/launches'\nfi\n",
        root.path().display(),
    )).unwrap();
    let record = root.path().join(format!(".spec-output/{parent}.json"));
    fs::set_permissions(&record, fs::Permissions::from_mode(0o644)).unwrap();
    {
        let gate = recovery::run_gate(&state, &parent).await;
        {
            let mut jobs = state.jobs.lock().unwrap();
            let job = jobs.iter_mut().find(|job| job.id == parent).unwrap();
            job.dirty = true;
            job.output = b"final checkpoint".to_vec().into();
        }
        recovery::checkpoint(&state, &parent);
        drop(gate);
    }
    queued_builds::dispatch(&state).await.ok().unwrap();
    assert!(!root.path().join("launches").exists());
    assert_eq!(items(&state).await[0]["status"], "waiting");
    let gate = recovery::run_gate(&state, &parent).await;
    fs::set_permissions(&record, fs::Permissions::from_mode(0o600)).unwrap();
    let worker = queued_builds::spawn(state.clone());
    tokio::time::sleep(Duration::from_millis(100)).await;
    {
        let jobs = state.jobs.lock().unwrap();
        let job = jobs.iter().find(|job| job.id == parent).unwrap();
        assert!(job.dirty && job.persistence_error.is_some());
        assert!(!job.recover && !job.attached);
    }
    assert!(!root.path().join("launches").exists());
    drop(gate);
    // Only the background worker runs: no output polling, restart or manual retry.
    wait_for_file(&root.path().join("launches")).await;
    worker.abort();
    let _ = worker.await;
    let child = items(&state).await[0]["id"].as_str().unwrap().to_owned();
    terminal(&state, &child).await;
    {
        let jobs = state.jobs.lock().unwrap();
        let job = jobs.iter().find(|job| job.id == parent).unwrap();
        assert!(!job.dirty && job.persistence_error.is_none());
    }
    let saved = recovery::load(&state, &parent).ok().unwrap();
    assert_eq!(saved.output, b"final checkpoint".to_vec());
    assert_eq!(saved.status, "completed");
    assert_eq!(
        fs::read_to_string(root.path().join("launches")).unwrap(),
        "build\n"
    );
}
