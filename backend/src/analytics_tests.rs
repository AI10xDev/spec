use super::retained_tests::{fixture, retained};
use super::*;
use serde_json::{Value, json};

const ENDPOINT: &str = "/api/analytics";

async fn evaluate(state: &App, input: Value) -> Value {
    let response = request(state.clone(), "POST", ENDPOINT, input).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    super::json(response).await
}

#[tokio::test]
async fn analytics_local_full_report_and_missing_are_read_only_snapshots() {
    let root = tempfile::tempdir().unwrap();
    let state = app(root.path());
    fs::write(root.path().join("a.md"), "spec").unwrap();
    // Similar stems must not count as this spec's output.
    fs::write(root.path().join("a.out"), "other spec output").unwrap();
    let missing = evaluate(&state, json!({"name": "a.md"})).await;
    assert_eq!(
        missing,
        json!({"report": null, "runs": [], "warnings": [
            "No prior output found; this is not proof that the spec has never run."
        ]})
    );
    let contents = format!("first evidence\n{}\nlast evidence", "x".repeat(MAX_OUTPUT));
    fs::write(root.path().join("a.md.out"), &contents).unwrap();
    let output = evaluate(&state, json!({"name": "a.md"})).await;
    assert_eq!(output.as_object().unwrap().len(), 3);
    assert_eq!(
        output["report"],
        json!({
            "id": "local", "name": "a.md", "status": "snapshot", "output": contents,
            "truncated": false, "recoverable": false, "continuable": false
        })
    );
    assert_eq!(output["runs"], json!([]));
    assert!(
        output["warnings"][0]
            .as_str()
            .unwrap()
            .contains("Local workspace")
    );
    assert!(!root.path().join(".spec-output").exists());
    assert!(!root.path().join(".spec-runs").exists());
    assert!(state.jobs.lock().unwrap().is_empty());
    assert!(!*state.recovered.lock().unwrap());
}

#[tokio::test]
async fn analytics_local_report_is_capped_at_eight_mib() {
    let root = tempfile::tempdir().unwrap();
    let state = app(root.path());
    fs::write(root.path().join("a.md"), "spec").unwrap();
    for size in [
        analytics::MAX_REPORT - 1,
        analytics::MAX_REPORT,
        analytics::MAX_REPORT + 3,
    ] {
        fs::write(root.path().join("a.md.out"), vec![b'x'; size]).unwrap();
        let output = evaluate(&state, json!({"name": "a.md"})).await;
        assert_eq!(
            output["report"]["output"].as_str().unwrap().len(),
            size.min(analytics::MAX_REPORT)
        );
        assert_eq!(output["report"]["truncated"], size >= analytics::MAX_REPORT);
        assert_eq!(
            output["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|w| w.as_str().unwrap().contains("reached the 8 MiB limit")),
            size >= analytics::MAX_REPORT
        );
    }
}

#[tokio::test]
async fn analytics_rejects_unsafe_names_ids_and_files_before_ssh() {
    let (root, state) = fixture();
    // Any accidental SSH invocation would fail differently from local validation.
    fs::write(
        &state.remote.as_ref().unwrap().binary,
        "#!/bin/bash\nexit 99\n",
    )
    .unwrap();
    for input in [
        json!({"name": "../secret"}),
        json!({"name": ".env"}),
        json!({"name": "/tmp/secret"}),
        json!({"name": "a/b"}),
        json!({"name": "a\\b"}),
        json!({"name": "a\nb"}),
        json!({"name": " a.md"}),
        json!({"name": "C:secret"}),
        json!({"name": ""}),
        json!({"name": "x".repeat(181)}),
        json!({"name": "a.md", "runId": "local"}),
        json!({"name": "a.md", "runId": "../../bad"}),
        json!({"name": "a.md", "runId": "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"}),
    ] {
        assert_eq!(
            request(state.clone(), "POST", ENDPOINT, input)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        request(state.clone(), "POST", ENDPOINT, json!({"name": "absent"}))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    symlink(root.path().join("a.md"), root.path().join("linked")).unwrap();
    assert_eq!(
        request(state, "POST", ENDPOINT, json!({"name": "linked"}))
            .await
            .status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    for kind in ["symlink", "dangling", "directory", "fifo"] {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.md"), "spec").unwrap();
        let path = root.path().join("a.md.out");
        match kind {
            "symlink" => symlink(root.path().join("a.md"), &path).unwrap(),
            "dangling" => symlink(root.path().join("missing"), &path).unwrap(),
            "directory" => fs::create_dir(&path).unwrap(),
            "fifo" => nix::unistd::mkfifo(&path, nix::sys::stat::Mode::S_IRUSR).unwrap(),
            _ => unreachable!(),
        }
        let response = tokio::time::timeout(
            Duration::from_secs(2),
            request(app(root.path()), "POST", ENDPOINT, json!({"name": "a.md"})),
        )
        .await
        .unwrap();
        assert_eq!(
            response.status(),
            if kind == "symlink" || kind == "dangling" {
                StatusCode::INTERNAL_SERVER_ERROR
            } else {
                StatusCode::BAD_REQUEST
            },
            "{kind}"
        );
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }
}

#[tokio::test]
async fn analytics_retained_requires_selection_and_reads_full_exact_named_report() {
    let (root, state) = fixture();
    let id = Uuid::new_v4().to_string();
    let directory = retained(root.path(), &id, "a.md");
    retained(root.path(), &Uuid::new_v4().to_string(), "a");
    let unrelated = Uuid::new_v4().to_string();
    retained(root.path(), &unrelated, "other.md");
    fs::write(
        root.path().join("a.md.out"),
        "local must not override choices",
    )
    .unwrap();
    let contents = format!("first evidence\n{}\nlast evidence", "x".repeat(MAX_OUTPUT));
    fs::write(directory.join("a.md.out"), &contents).unwrap();
    let choices = evaluate(&state, json!({"name": "a.md"})).await;
    assert_eq!(choices["report"], Value::Null);
    assert_eq!(choices["runs"].as_array().unwrap().len(), 1);
    assert_eq!(choices["runs"][0]["id"], id);
    assert!(choices["runs"][0]["modified"].is_number());
    let selected = evaluate(&state, json!({"name": "a.md", "runId": id})).await;
    assert_eq!(
        selected,
        json!({"report": {
        "id": id, "name": "a.md", "status": "completed", "output": contents,
        "truncated": false, "recoverable": false, "continuable": false
    }, "runs": [], "warnings": []})
    );
    for id in [unrelated, Uuid::new_v4().to_string()] {
        assert_eq!(
            request(
                state.clone(),
                "POST",
                ENDPOINT,
                json!({"name": "a.md", "runId": id})
            )
            .await
            .status(),
            StatusCode::BAD_GATEWAY
        );
    }
    assert!(!root.path().join(".spec-output").exists());
    assert!(state.jobs.lock().unwrap().is_empty());
    assert!(!*state.recovered.lock().unwrap());
    assert!(!directory.join("cancel").exists());
}

#[tokio::test]
async fn analytics_prefers_verified_association_without_mutating_it() {
    let (root, mut state) = fixture();
    let id = Uuid::new_v4().to_string();
    retained(root.path(), &id, "a.md");
    let other = Uuid::new_v4().to_string();
    retained(root.path(), &other, "a.md");
    fs::write(root.path().join("a.md.out"), "local").unwrap();
    let mut job = persisted_job(&id, state.remote.as_ref().unwrap().identity(), false);
    recovery::persist(&state, &job).ok().unwrap();
    recovery::set_latest(&state, &job).ok().unwrap();
    let before = fs::read(root.path().join(format!(".spec-output/{id}.json"))).unwrap();
    let report = evaluate(&state, json!({"name": "a.md"})).await;
    assert_eq!(report["report"]["id"], id);
    assert_eq!(report["report"]["output"], "retained output");
    assert_eq!(
        evaluate(&state, json!({"name": "a.md", "runId": other})).await["report"]["id"],
        other
    );
    assert_eq!(recovery::latest(&state, "a.md").ok().flatten().unwrap(), id);
    assert_eq!(
        fs::read(root.path().join(format!(".spec-output/{id}.json"))).unwrap(),
        before
    );
    assert!(state.jobs.lock().unwrap().is_empty());
    assert!(!*state.recovered.lock().unwrap());
    // A pointer to a different filename is not association evidence.
    job.name = "a".into();
    recovery::persist(&state, &job).ok().unwrap();
    assert_eq!(
        request(state.clone(), "POST", ENDPOINT, json!({"name": "a.md"}))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    job.name = "a.md".into();
    recovery::persist(&state, &job).ok().unwrap();
    state.remote.as_mut().unwrap().target = "changed@host".into();
    assert_eq!(
        request(state.clone(), "POST", ENDPOINT, json!({"name": "a.md"}))
            .await
            .status(),
        StatusCode::BAD_GATEWAY
    );
    state.remote = None;
    assert_eq!(
        request(state, "POST", ENDPOINT, json!({"name": "a.md"}))
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
async fn analytics_remote_cap_and_active_or_unknown_snapshots_warn() {
    let (root, state) = fixture();
    let id = Uuid::new_v4().to_string();
    let directory = retained(root.path(), &id, "a.md");
    for size in [
        analytics::MAX_REPORT - 1,
        analytics::MAX_REPORT,
        analytics::MAX_REPORT + 5,
    ] {
        fs::write(
            directory.join("a.md.out"),
            [b"start".as_slice(), &vec![b'x'; size - 5]].concat(),
        )
        .unwrap();
        let report = evaluate(&state, json!({"name": "a.md", "runId": id})).await;
        assert_eq!(report["report"]["truncated"], size >= analytics::MAX_REPORT);
        let text = report["report"]["output"].as_str().unwrap();
        assert_eq!(text.len(), size.min(analytics::MAX_REPORT));
        assert!(text.starts_with("start"));
        assert_eq!(
            report["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|w| w.as_str().unwrap().contains("reached the 8 MiB limit")),
            size >= analytics::MAX_REPORT
        );
    }
    // Oversized reports remain selectable in analytics, unlike display-tail lookup.
    assert_eq!(
        evaluate(&state, json!({"name": "a.md"})).await["runs"][0]["id"],
        id
    );
    fs::write(directory.join("a.md.out"), "small").unwrap();
    fs::rename(directory.join("status"), directory.join("lease")).unwrap();
    let lease = nix::fcntl::Flock::lock(
        File::open(directory.join("lease")).unwrap(),
        nix::fcntl::FlockArg::LockExclusiveNonblock,
    )
    .unwrap();
    let active = evaluate(&state, json!({"name": "a.md", "runId": id})).await;
    assert_eq!(active["report"]["status"], "running");
    assert!(
        active["warnings"][0]
            .as_str()
            .unwrap()
            .contains("Active or unknown")
    );
    drop(lease);
    let unknown = evaluate(&state, json!({"name": "a.md", "runId": id})).await;
    assert!(
        unknown["report"]["status"]
            .as_str()
            .unwrap()
            .starts_with("unknown")
    );
    assert!(!unknown["warnings"].as_array().unwrap().is_empty());
    assert!(!directory.join("cancel").exists());
}

#[tokio::test]
async fn analytics_lossy_utf8_is_incomplete_but_retained_tail_behavior_is_unchanged() {
    let (root, remote_state) = fixture();
    let local_state = app(root.path());
    let id = Uuid::new_v4().to_string();
    let directory = retained(root.path(), &id, "a.md");
    for (bytes, lossy) in [
        (b"metric: \xff".to_vec(), true),
        (b"metric: \xe2\x82".to_vec(), true),
        (b"valid replacement: \xef\xbf\xbd".to_vec(), false),
        (b"valid Unicode: \xc3\xa9".to_vec(), false),
        (vec![b'x'; MAX_OUTPUT], false),
    ] {
        fs::write(root.path().join("a.md.out"), &bytes).unwrap();
        fs::write(directory.join("a.md.out"), &bytes).unwrap();
        for (state, input) in [
            (&local_state, json!({"name": "a.md"})),
            (&remote_state, json!({"name": "a.md", "runId": id})),
        ] {
            let report = evaluate(state, input).await;
            assert_eq!(
                report["report"]["output"],
                String::from_utf8_lossy(&bytes).as_ref()
            );
            assert_eq!(report["report"]["truncated"], lossy);
            assert_eq!(
                report["warnings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|w| w.as_str().unwrap().contains("invalid UTF-8")),
                lossy
            );
        }
        let tail = request(
            remote_state.clone(),
            "GET",
            &format!("/api/files/a.md/retained-runs/{id}/log"),
            Value::Null,
        )
        .await;
        assert_eq!(tail.status(), StatusCode::OK);
        let tail = super::json(tail).await;
        assert_eq!(tail["output"], String::from_utf8_lossy(&bytes).as_ref());
        assert_eq!(tail["truncated"], false);
    }
}

#[tokio::test]
async fn analytics_remote_absence_is_distinct_from_transport_or_storage_failure() {
    let (root, state) = fixture();
    let missing = evaluate(&state, json!({"name": "a.md"})).await;
    assert_eq!(missing["report"], Value::Null);
    assert_eq!(missing["runs"], json!([]));
    assert!(
        missing["warnings"][0]
            .as_str()
            .unwrap()
            .contains("No prior output found")
    );
    fs::write(root.path().join("a.md.out"), "local fallback").unwrap();
    assert_eq!(
        evaluate(&state, json!({"name": "a.md"})).await["report"]["id"],
        "local"
    );
    let id = Uuid::new_v4().to_string();
    let directory = retained(root.path(), &id, "a.md");
    fs::remove_file(directory.join("a.md.out")).unwrap();
    symlink(root.path().join("a.md.out"), directory.join("a.md.out")).unwrap();
    for input in [
        json!({"name": "a.md"}),
        json!({"name": "a.md", "runId": id}),
    ] {
        assert_eq!(
            request(state.clone(), "POST", ENDPOINT, input)
                .await
                .status(),
            StatusCode::BAD_GATEWAY
        );
    }
    fs::write(
        &state.remote.as_ref().unwrap().binary,
        "#!/bin/bash\nprintf 'authentication denied' >&2\nexit 255\n",
    )
    .unwrap();
    let failure = request(state, "POST", ENDPOINT, json!({"name": "a.md"})).await;
    assert_eq!(failure.status(), StatusCode::BAD_GATEWAY);
    assert!(
        super::json(failure).await["error"]
            .as_str()
            .unwrap()
            .contains("authentication denied")
    );
}
