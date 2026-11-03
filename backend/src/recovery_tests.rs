use super::*;
use serde_json::{Value, json as body};

#[tokio::test]
async fn active_runs_lists_persisted_and_attached_jobs_without_files_or_ssh() {
    let root = tempfile::tempdir().unwrap();
    let mut state = app(root.path());
    let remote = remote_fixture(root.path(), &root.path().join("unused"));
    fs::write(&remote.binary, "#!/bin/sh\nexit 99\n").unwrap();
    state.remote = Some(remote);
    let mut expected = Vec::new();
    for (name, kind, recover) in [
        ("deleted.md", "build", true),
        ("repo.md", "repository-save", true),
        ("optimization", "optimization", true),
        ("finished.md", "build", false),
    ] {
        let mut job = persisted_job(
            &Uuid::new_v4().to_string(),
            state.remote.as_ref().unwrap().identity(),
            recover,
        );
        job.name = name.into();
        job.repository_save = kind == "repository-save";
        job.optimization = kind == "optimization";
        recovery::persist(&state, &job).ok().unwrap();
        if recover {
            expected.push(body!({"id":job.id,"name":name,"status":"detached (backend restarted)","kind":kind}));
        }
    }
    let mut attached = persisted_job(&Uuid::new_v4().to_string(), "a".repeat(64), true);
    attached.name = "attached.md".into();
    attached.attached = true;
    let _attached_control = attached.stop.subscribe();
    expected.push(body!({"id":attached.id,"name":"attached.md","status":"running","kind":"build"}));
    state.jobs.lock().unwrap().push(attached);
    expected.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    for _ in 0..2 {
        let response = request(state.clone(), "GET", "/api/runs", Value::Null).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json(response).await, body!(expected));
    }
    assert!(!root.path().join("deleted.md").exists());
    assert!(!root.path().join(".spec-runs").exists());
    assert_eq!(state.jobs.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn active_run_inspection_keeps_unavailable_blockers_until_remote_terminal_status() {
    let root = tempfile::tempdir().unwrap();
    let mut state = app(root.path());
    state.remote = Some(remote_fixture(root.path(), &root.path().join("unused")));
    let mut ids = Vec::new();
    for name in ["deleted.md", "unopened.md"] {
        let job = Job {
            name: name.into(),
            ..persisted_job(
                &Uuid::new_v4().to_string(),
                state.remote.as_ref().unwrap().identity(),
                true,
            )
        };
        ids.push(job.id.clone());
        recovery::persist(&state, &job).ok().unwrap();
    }
    let response = request(
        state.clone(),
        "POST",
        "/api/optimize",
        body!({"project":".","spec":null}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let detail = json(response).await["error"].as_str().unwrap().to_owned();
    assert!(detail.contains("2 active or unresolved"));
    assert!(ids.iter().any(|id| detail.contains(id)));
    assert!(detail.contains("Active runs"));
    let response = request(
        state.clone(),
        "GET",
        &format!("/api/runs/{}", ids[0]),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let missing = json(response).await;
    assert_eq!(missing["recoverable"], true);
    assert!(
        missing["status"]
            .as_str()
            .unwrap()
            .starts_with("unavailable")
    );
    assert_eq!(missing["output"], "saved output");
    assert_eq!(
        json(request(state.clone(), "GET", "/api/runs", Value::Null).await)
            .await
            .as_array()
            .unwrap()
            .len(),
        2
    );

    // Only this protocol stand-in's confirmed remote terminal state resolves a run.
    let binary = &state.remote.as_ref().unwrap().binary;
    fs::write(binary, format!("#!/bin/bash\nif [[ ${{!#}} == *'{}'* ]]; then\n  printf 'SPEC-RUN-1 0 0\\nconfirmed terminal output'\nelse\n  printf 'SPEC-RUN-1 unknown 0\\nstill unresolved'\nfi\n", ids[0])).unwrap();
    let output = json(
        request(
            state.clone(),
            "GET",
            &format!("/api/runs/{}", ids[0]),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(output["recoverable"], false);
    assert_eq!(output["status"], "completed");
    let runs = json(request(state.clone(), "GET", "/api/runs", Value::Null).await).await;
    assert_eq!(runs.as_array().unwrap().len(), 1);
    assert_eq!(runs[0]["id"], ids[1]);
    let response = request(
        state.clone(),
        "POST",
        "/api/optimize",
        body!({"project":".","spec":null}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert!(
        json(response).await["error"]
            .as_str()
            .unwrap()
            .contains(&ids[1])
    );
    assert!(!root.path().join("deleted.md").exists());
    assert!(!root.path().join(".spec-runs").exists());
}

#[tokio::test]
async fn active_runs_empty_and_unsafe_storage_never_report_false_completion() {
    let root = tempfile::tempdir().unwrap();
    let state = app(root.path());
    assert_eq!(
        json(request(state, "GET", "/api/runs", Value::Null).await).await,
        body!([])
    );
    assert!(!root.path().join(".spec-output").exists());
    fs::create_dir(root.path().join(".spec-output")).unwrap();
    fs::set_permissions(
        root.path().join(".spec-output"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let response = request(app(root.path()), "GET", "/api/runs", Value::Null).await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

#[test]
fn restored_parent_stays_cached_until_state_capture_finishes() {
    let root = tempfile::tempdir().unwrap();
    let state = app(root.path());
    let parent = Uuid::new_v4().to_string();
    let other = Uuid::new_v4().to_string();
    for id in [&parent, &other] {
        let job = persisted_job(id, "0".repeat(64), false);
        recovery::persist(&state, &job).ok().unwrap();
    }
    drop(recovery::restore(&state, &parent).ok().unwrap());
    for _ in 1..32 {
        state.jobs.lock().unwrap().push(persisted_job(
            &Uuid::new_v4().to_string(),
            "0".repeat(64),
            false,
        ));
    }
    let jobs = recovery::restore(&state, &parent).ok().unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    let restore = {
        let state = state.clone();
        let other = other.clone();
        std::thread::spawn(move || {
            // No scheduling delay: report whether eviction can acquire the lock.
            send.send(state.jobs.try_lock().is_err()).unwrap();
            drop(recovery::restore(&state, &other).ok().unwrap());
        })
    };
    assert!(receive.recv_timeout(Duration::from_secs(2)).unwrap());
    let job = jobs.iter().find(|job| job.id == parent).unwrap();
    assert!(!job.recover);
    let name = job.name.clone();
    drop(jobs);
    restore.join().unwrap();
    let jobs = state.jobs.lock().unwrap();
    assert_eq!(jobs.len(), 32);
    assert!(!jobs.iter().any(|job| job.id == parent));
    assert!(jobs.iter().any(|job| job.id == other));
    assert_eq!(name, recovery::load(&state, &parent).ok().unwrap().name);
}

// A local protocol stand-in holds one snapshot until the test explicitly releases
// it. No real SSH, harness, provider or elapsed network delay is involved.
fn gated_remote(root: &FsPath, blocked: &str) -> Remote {
    let remote = remote_fixture(root, &root.join("must-not-launch"));
    fs::write(
        &remote.binary,
        format!(
            r#"#!/bin/bash
set -eu
cd '{}'
if [[ ${{!#}} == *"'{blocked}' snapshot '"* && ! -f released ]]; then
    touch entered
    while [[ ! -f released ]]; do sleep 0.01; done
fi
if [[ ${{!#}} == *"' cancel '"* ]]; then
    touch cancelled
    printf 'SPEC-RUN-1 130 0\nnew cancellation output'
else
    printf 'SPEC-RUN-1 running 0\nold snapshot output'
fi
"#,
            root.display()
        ),
    )
    .unwrap();
    remote
}

#[tokio::test]
async fn closed_attached_inspection_recovers_only_verified_remote_terminal_state() {
    for (header, expected, recover) in [
        ("unknown", "unknown (remote status unavailable)", true),
        ("missing", "unavailable", true),
        ("0", "completed", false),
    ] {
        let root = tempfile::tempdir().unwrap();
        let mut state = app(root.path());
        let remote = remote_fixture(root.path(), &root.path().join("must-not-launch"));
        fs::write(
            &remote.binary,
            format!(
                "#!/bin/sh\ntouch '{}/contacted'\n{}\n",
                root.path().display(),
                if header == "missing" {
                    "printf 'remote run directory missing' >&2; exit 1".into()
                } else {
                    format!("printf 'SPEC-RUN-1 {header} 0\\nremote output'")
                }
            ),
        )
        .unwrap();
        let id = Uuid::new_v4().to_string();
        let mut job = persisted_job(&id, remote.identity(), true);
        job.attached = true;
        assert!(job.stop.is_closed());
        recovery::persist(&state, &job).ok().unwrap();
        state.jobs.lock().unwrap().push(job);
        state.remote = Some(remote);

        let response = request(
            state.clone(),
            "GET",
            &format!("/api/runs/{id}"),
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let output = json(response).await;
        assert!(
            root.path().join("contacted").exists(),
            "closed attachment skipped remote recovery"
        );
        assert!(output["status"].as_str().unwrap().starts_with(expected));
        assert_eq!(output["recoverable"], recover);
        assert_eq!(
            output["output"],
            if header == "missing" {
                "saved output"
            } else {
                "remote output"
            }
        );
        assert!(!state.jobs.lock().unwrap()[0].attached);
        let saved = recovery::load(&state, &id).ok().unwrap();
        assert_eq!(saved.recover, recover);
        assert_eq!(saved.output, state.jobs.lock().unwrap()[0].output);
        if !recover {
            assert_eq!(saved.status, "completed");
        }
        let runs = json(request(state.clone(), "GET", "/api/runs", Value::Null).await).await;
        assert_eq!(runs.as_array().unwrap().len(), usize::from(recover));
        if recover {
            let response = request(
                state,
                "POST",
                "/api/optimize",
                body!({"project":".","spec":null}),
            )
            .await;
            assert_eq!(response.status(), StatusCode::CONFLICT);
        }
    }
}

#[tokio::test]
async fn terminal_disk_read_restores_entry_evicted_during_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let id = Uuid::new_v4().to_string();
    let mut state = app(root.path());
    state.remote = Some(gated_remote(root.path(), &id));
    let target = persisted_job(&id, state.remote.as_ref().unwrap().identity(), false);
    recovery::persist(&state, &target).ok().unwrap();
    recovery::set_latest(&state, &target).ok().unwrap();
    drop(recovery::restore(&state, &id).ok().unwrap());
    for _ in 1..32 {
        let other = persisted_job(
            &Uuid::new_v4().to_string(),
            target.remote_identity.clone(),
            false,
        );
        recovery::persist(&state, &other).ok().unwrap();
        drop(recovery::restore(&state, &other.id).ok().unwrap());
    }
    let pending = {
        let state = state.clone();
        tokio::spawn(
            async move { request(state, "GET", "/api/files/a.md/run/log", Value::Null).await },
        )
    };
    wait_for_file(&root.path().join("entered")).await;
    let other = persisted_job(
        &Uuid::new_v4().to_string(),
        target.remote_identity.clone(),
        false,
    );
    recovery::persist(&state, &other).ok().unwrap();
    drop(recovery::restore(&state, &other.id).ok().unwrap());
    assert!(!state.jobs.lock().unwrap().iter().any(|job| job.id == id));
    fs::write(root.path().join("released"), "").unwrap();
    let response = pending
        .await
        .expect("disk read must not panic after cache eviction");
    assert_eq!(response.status(), StatusCode::OK);
    let output = json(response).await;
    assert_eq!(output["id"], id);
    assert_eq!(output["status"], "completed");
    assert_eq!(output["recoverable"], false);
    assert!(!state.jobs.is_poisoned());
    assert!(!recovery::load(&state, &id).ok().unwrap().recover);
    assert_eq!(state.jobs.lock().unwrap().len(), 32);
}

#[tokio::test]
async fn closed_attached_cancellation_uses_remote_and_propagates_failure() {
    for unavailable in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let mut state = app(root.path());
        let remote = gated_remote(root.path(), &Uuid::new_v4().to_string());
        if unavailable {
            fs::write(
                &remote.binary,
                format!(
                    "#!/bin/sh\ntouch '{}/cancelled'\nexit 1\n",
                    root.path().display()
                ),
            )
            .unwrap();
        }
        let id = Uuid::new_v4().to_string();
        let mut job = persisted_job(&id, remote.identity(), true);
        job.attached = true;
        recovery::persist(&state, &job).ok().unwrap();
        state.jobs.lock().unwrap().push(job);
        state.remote = Some(remote);
        let result = recovery::refresh(&state, &id, true).await;
        assert!(
            root.path().join("cancelled").exists(),
            "closed attachment silently ignored cancellation"
        );
        if unavailable {
            assert_eq!(result.err().unwrap().0, StatusCode::BAD_GATEWAY);
        } else {
            result.ok().unwrap();
        }
        let saved = recovery::load(&state, &id).ok().unwrap();
        assert_eq!(saved.recover, unavailable);
        assert!(!state.jobs.lock().unwrap()[0].attached);
        if !unavailable {
            assert_eq!(saved.status, "cancelled");
            assert_eq!(saved.output, b"new cancellation output".to_vec());
        }
    }
}

#[tokio::test]
async fn closed_attached_detachment_is_persisted_before_remote_io() {
    let root = tempfile::tempdir().unwrap();
    let id = Uuid::new_v4().to_string();
    let mut state = app(root.path());
    state.remote = Some(gated_remote(root.path(), &id));
    let mut job = persisted_job(&id, state.remote.as_ref().unwrap().identity(), true);
    job.attached = true;
    state.jobs.lock().unwrap().push(job);
    let snapshot = {
        let state = state.clone();
        let id = id.clone();
        tokio::spawn(async move { recovery::refresh(&state, &id, false).await.ok().unwrap() })
    };
    wait_for_file(&root.path().join("entered")).await;
    let saved = recovery::load(&state, &id).ok().unwrap();
    let detached = !state.jobs.lock().unwrap()[0].attached;
    fs::write(root.path().join("released"), "").unwrap();
    snapshot.await.unwrap();
    assert!(detached);
    assert!(saved.recover);
    assert_eq!(saved.output, b"saved output".to_vec());
}

#[tokio::test]
async fn closed_attached_persistence_failure_blocks_remote_io_and_retries() {
    let root = tempfile::tempdir().unwrap();
    let mut state = app(root.path());
    state.remote = Some(gated_remote(root.path(), &Uuid::new_v4().to_string()));
    let id = Uuid::new_v4().to_string();
    let mut job = persisted_job(&id, state.remote.as_ref().unwrap().identity(), true);
    job.attached = true;
    recovery::persist(&state, &job).ok().unwrap();
    state.jobs.lock().unwrap().push(job);
    let directory = root.path().join(".spec-output");
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
    for _ in 0..2 {
        let error = recovery::refresh(&state, &id, true)
            .await
            .expect_err("unsafe persistence must fail closed");
        assert_eq!(error.0, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(!root.path().join("cancelled").exists());
        let jobs = state.jobs.lock().unwrap();
        assert!(jobs[0].recover);
        assert!(jobs[0].dirty);
        assert!(jobs[0].persistence_error.is_some());
    }
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    recovery::refresh(&state, &id, true).await.ok().unwrap();
    assert!(root.path().join("cancelled").exists());
    assert!(!recovery::load(&state, &id).ok().unwrap().recover);
    assert!(state.jobs.lock().unwrap()[0].persistence_error.is_none());
}

#[tokio::test]
async fn closed_attached_identity_mismatch_stays_unresolved_without_ssh() {
    let root = tempfile::tempdir().unwrap();
    let mut state = app(root.path());
    state.remote = Some(gated_remote(root.path(), &Uuid::new_v4().to_string()));
    let id = Uuid::new_v4().to_string();
    let mut job = persisted_job(&id, "0".repeat(64), true);
    job.attached = true;
    state.jobs.lock().unwrap().push(job);
    recovery::refresh(&state, &id, false).await.ok().unwrap();
    {
        let jobs = state.jobs.lock().unwrap();
        assert!(!jobs[0].attached);
        assert!(jobs[0].recover);
        assert!(
            jobs[0]
                .status
                .contains("remote configuration does not match")
        );
        assert_eq!(jobs[0].output, b"saved output".to_vec());
    }
    let error = recovery::refresh(&state, &id, true).await.err().unwrap();
    assert_eq!(error.0, StatusCode::BAD_GATEWAY);
    assert!(!root.path().join("cancelled").exists());
    assert!(recovery::load(&state, &id).ok().unwrap().recover);
}

#[tokio::test]
async fn attached_live_control_and_known_terminal_state_avoid_remote_replacement() {
    for recover in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let mut state = app(root.path());
        let remote = remote_fixture(root.path(), &root.path().join("must-not-launch"));
        fs::write(
            &remote.binary,
            format!(
                "#!/bin/sh\ntouch '{}/contacted'\nprintf 'SPEC-RUN-1 0 0\\nremote output'\n",
                root.path().display()
            ),
        )
        .unwrap();
        let id = Uuid::new_v4().to_string();
        let mut job = persisted_job(&id, remote.identity(), recover);
        job.attached = true;
        let control = job.stop.subscribe();
        recovery::persist(&state, &job).ok().unwrap();
        state.jobs.lock().unwrap().push(job);
        state.remote = Some(remote);
        recovery::refresh(&state, &id, false).await.ok().unwrap();
        assert!(state.jobs.lock().unwrap()[0].attached);
        assert!(!root.path().join("contacted").exists());
        assert_eq!(
            state.jobs.lock().unwrap()[0].output,
            b"saved output".to_vec()
        );
        drop(control);
        if !recover {
            recovery::refresh(&state, &id, false).await.ok().unwrap();
            assert!(!state.jobs.lock().unwrap()[0].attached);
            assert!(!root.path().join("contacted").exists());
            let saved = recovery::load(&state, &id).ok().unwrap();
            assert_eq!(saved.status, "completed");
            assert!(!saved.recover);
            assert_eq!(saved.output, b"saved output".to_vec());
        }
    }
}

#[tokio::test]
async fn blocked_recovery_does_not_block_attached_or_unrelated_recovered_cancellation() {
    for admission in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let blocked = Uuid::new_v4().to_string();
        let detached = Uuid::new_v4().to_string();
        let attached = Uuid::new_v4().to_string();
        let mut state = app(root.path());
        state.remote = Some(gated_remote(root.path(), &blocked));
        for (id, name) in [(&blocked, "blocked.md"), (&detached, "detached.md")] {
            let mut job = persisted_job(id, state.remote.as_ref().unwrap().identity(), true);
            job.name = name.into();
            recovery::persist(&state, &job).ok().unwrap();
        }
        recovery::initialize(&state).ok().unwrap();
        let mut job = persisted_job(&attached, state.remote.as_ref().unwrap().identity(), true);
        let (stop, stopped) = watch::channel(RunControl::Running);
        job.stop = stop;
        job.attached = true;
        state.jobs.lock().unwrap().push(job);
        let pending = {
            let state = state.clone();
            let id = blocked.clone();
            tokio::spawn(async move {
                if admission {
                    request(
                        state,
                        "POST",
                        "/api/runs",
                        serde_json::json!({"name":"missing.md", "revision":"missing"}),
                    )
                    .await
                } else {
                    request(
                        state,
                        "GET",
                        &format!("/api/runs/{id}"),
                        serde_json::Value::Null,
                    )
                    .await
                }
            })
        };
        wait_for_file(&root.path().join("entered")).await;
        let attached_result = tokio::time::timeout(
            Duration::from_secs(2),
            request(
                state.clone(),
                "POST",
                &format!("/api/runs/{attached}/cancel"),
                serde_json::Value::Null,
            ),
        )
        .await;
        let detached_result = tokio::time::timeout(
            Duration::from_secs(2),
            request(
                state.clone(),
                "POST",
                &format!("/api/runs/{detached}/cancel"),
                serde_json::Value::Null,
            ),
        )
        .await;
        let signalled = *stopped.borrow() == RunControl::Cancel;
        let remote_cancelled = root.path().join("cancelled").is_file();
        fs::write(root.path().join("released"), "").unwrap();
        let response = pending.await.unwrap();
        assert_eq!(
            response.status(),
            if admission {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::OK
            }
        );
        assert_eq!(
            attached_result
                .expect("attached cancellation waited on unrelated recovery")
                .status(),
            StatusCode::OK
        );
        assert!(signalled);
        assert_eq!(
            detached_result
                .expect("recovered cancellation waited on unrelated recovery")
                .status(),
            StatusCode::OK
        );
        assert!(remote_cancelled);
        let saved = recovery::load(&state, &detached).ok().unwrap();
        assert_eq!(saved.status, "cancelled");
        assert!(!saved.recover);
        assert_eq!(saved.output, b"new cancellation output".to_vec());
    }
}

#[tokio::test]
async fn same_run_snapshot_and_cancel_publish_in_order() {
    let root = tempfile::tempdir().unwrap();
    let id = Uuid::new_v4().to_string();
    let mut state = app(root.path());
    state.remote = Some(gated_remote(root.path(), &id));
    let job = persisted_job(&id, state.remote.as_ref().unwrap().identity(), true);
    recovery::persist(&state, &job).ok().unwrap();
    recovery::initialize(&state).ok().unwrap();
    let snapshot = {
        let state = state.clone();
        let id = id.clone();
        tokio::spawn(async move { recovery::refresh(&state, &id, false).await.ok().unwrap() })
    };
    wait_for_file(&root.path().join("entered")).await;
    let cancel = recovery::refresh(&state, &id, true);
    tokio::pin!(cancel);
    // Drive cancellation while the old snapshot is held. Without serialization,
    // it completes first and the late running snapshot can undo terminal state.
    let early_cancel = tokio::time::timeout(Duration::from_secs(1), &mut cancel).await;
    let contacted_early = root.path().join("cancelled").exists();
    fs::write(root.path().join("released"), "").unwrap();
    snapshot.await.unwrap();
    assert!(
        early_cancel.is_err(),
        "cancel bypassed the same-run snapshot"
    );
    assert!(!contacted_early);
    cancel.await.ok().unwrap();
    recovery::refresh(&state, &id, false).await.ok().unwrap();
    let saved = recovery::load(&state, &id).ok().unwrap();
    assert_eq!(saved.status, "cancelled");
    assert!(!saved.recover);
    assert_eq!(saved.output, b"new cancellation output".to_vec());
}

#[tokio::test]
async fn snapshot_revalidates_before_overwriting_attached_or_terminal_state() {
    for attached in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4().to_string();
        let mut state = app(root.path());
        state.remote = Some(gated_remote(root.path(), &id));
        let job = persisted_job(&id, state.remote.as_ref().unwrap().identity(), true);
        recovery::persist(&state, &job).ok().unwrap();
        recovery::initialize(&state).ok().unwrap();
        let snapshot = {
            let state = state.clone();
            let id = id.clone();
            tokio::spawn(async move { recovery::refresh(&state, &id, false).await.ok().unwrap() })
        };
        wait_for_file(&root.path().join("entered")).await;
        let _control;
        {
            let mut jobs = state.jobs.lock().unwrap();
            let job = &mut jobs[0];
            _control = job.stop.subscribe();
            job.attached = attached;
            job.recover = attached;
            job.status = if attached { "running" } else { "completed" }.into();
        }
        append(&state, &id, b" latest attached bytes");
        recovery::checkpoint(&state, &id);
        fs::write(root.path().join("released"), "").unwrap();
        snapshot.await.unwrap();
        let jobs = state.jobs.lock().unwrap();
        assert_eq!(jobs[0].recover, attached);
        assert_eq!(
            jobs[0].status,
            if attached { "running" } else { "completed" }
        );
        assert_eq!(
            jobs[0].output,
            b"saved output latest attached bytes".to_vec()
        );
        assert_eq!(
            recovery::load(&state, &id).ok().unwrap().output,
            jobs[0].output
        );
    }
}

#[tokio::test]
async fn concurrent_admission_rechecks_file_capacity_and_repository_exclusion() {
    for scenario in ["same-file", "capacity", "repository"] {
        let root = tempfile::tempdir().unwrap();
        let mut state = app(root.path());
        state.remote = Some(gated_remote(root.path(), &Uuid::new_v4().to_string()));
        for name in ["a.md", "b.md"] {
            fs::write(root.path().join(name), "fixture").unwrap();
        }
        if scenario == "capacity" {
            for index in 0..MAX_RUNS - 1 {
                let mut job = persisted_job(&Uuid::new_v4().to_string(), "0".repeat(64), true);
                job.name = format!("pending-{index}.md");
                recovery::persist(&state, &job).ok().unwrap();
            }
        }
        let build = |name: &str| {
            RunInput::Build(Run {
                name: name.into(),
                revision: read(root.path(), name).ok().unwrap().revision,
            })
        };
        // Both requests finish their recovery pass before either may admit a run.
        let gate = state.recovery_gate.lock().await;
        let first = start_run(
            state.clone(),
            if scenario == "repository" {
                RunInput::Optimize(Optimize {
                    name: "test.optim".into(),
                    content: "fixture".into(),
                })
            } else {
                build("a.md")
            },
        );
        let second = start_run(
            state.clone(),
            build(if scenario == "same-file" {
                "a.md"
            } else {
                "b.md"
            }),
        );
        tokio::pin!(first, second);
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(std::future::Future::poll(first.as_mut(), &mut context).is_pending());
        assert!(std::future::Future::poll(second.as_mut(), &mut context).is_pending());
        drop(gate);
        let (first, second) = tokio::join!(first, second);
        let id = first.ok().expect("first admission").0["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let error = second.expect_err("concurrent admission must conflict");
        assert_eq!(error.0, StatusCode::CONFLICT);
        assert!(
            error.1.contains(match scenario {
                "same-file" => "for this file",
                "capacity" => "16-run limit",
                _ => "This repository has",
            }),
            "{}",
            error.1
        );
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let guard = recovery::run_gate(&state, &id).await;
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
        let saved = recovery::load(&state, &id).ok().unwrap();
        assert!(
            saved.recover,
            "unconfirmed SSH exit must not free admission"
        );
        assert_eq!(
            recovery::latest(&state, "a.md").ok().flatten(),
            (scenario != "repository").then_some(id)
        );
    }
}
