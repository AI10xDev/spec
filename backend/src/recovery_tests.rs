use super::*;

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
        {
            let mut jobs = state.jobs.lock().unwrap();
            let job = &mut jobs[0];
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
                _ => "for this repository",
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
