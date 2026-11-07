use crate::tests::{app, json, remote_fixture, request, wait_for_file};
use crate::*;
use axum::body::Body;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json as body};
use tower::ServiceExt;

const ROUTE: &str = "/api/memory/graphql";
const SUMMARY: &str = "SPEC_BUILD_MEMORY_V1\n{\"whatChanged\":[\"Added a fixture feature\"],\"why\":[\"Exercise automatic capture\"],\"whatWasChecked\":[\"Agent claims fixture checks passed\"],\"unresolved\":[\"Real provider not exercised\"]}\nEND_SPEC_BUILD_MEMORY_V1\n";

fn fixture(root: &FsPath) -> App {
    let mut state = app(root);
    state.remote = Some(remote_fixture(root, &root.join("unused")));
    fs::write(root.join("summary"), SUMMARY).unwrap();
    fs::write(root.join("a.md"), "# Already completed\nPending feature\n").unwrap();
    fs::write(
        root.join(".bash_aliases"),
        r#"
spec() {
    [[ $# == 2 && $1 == build ]] || return 90
    local runtime=$(type -P bun || type -P node)
    "$runtime" --input-type=module -e '
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const hook = await (await import(config.plugin.at(-1))).default();
await hook.event({event:{type:"session.created",properties:{info:{id:"ses_Memory123"}}}});
' || return
    fixture_output
}
opencode-source() {
    [[ $1 == run && $4 == --session && $5 == ses_Memory123 ]] || return 91
    fixture_output
}
fixture_output() {
    touch "$HOME/entered"
    while [[ -f "$HOME/hold" ]]; do sleep 0.02; done
    cat "$HOME/summary"
}
"#,
    )
    .unwrap();
    state
}

async fn build(state: &App) -> String {
    let revision = read(&state.root, "a.md").ok().unwrap().revision;
    let response = request(
        state.clone(),
        "POST",
        "/api/runs",
        body!({"name":"a.md", "revision":revision}),
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

// Do not poll an output endpoint or call refresh: finalization must happen without a browser.
async fn terminal(state: &App, id: &str) -> Job {
    tokio::time::timeout(Duration::from_secs(12), async {
        loop {
            {
                let _guard = recovery::run_gate(state, id).await;
                let done = state
                    .jobs
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|job| job.id == id && !job.recover && !job.attached);
                if done {
                    return recovery::load(state, id).ok().unwrap();
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("automatic terminal persistence did not finish")
}

// Inspect SQLite directly: a GraphQL query would backfill and hide a broken scheduler.
async fn indexed(state: &App, job: &Job) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
    let metadata = job.memory.as_ref().unwrap();
    loop {
        let row = (|| -> rusqlite::Result<Value> {
            let db = Connection::open_with_flags(
                state.root.join(".spec-output/memory.sqlite3"),
                OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            // The file/schema may not exist yet, or the worker may hold a write lock.
            db.busy_timeout(Duration::ZERO)?;
            db.query_row(
                "SELECT status, started_at, finished_at, session_id, report FROM sweeps WHERE id=?1",
                [&job.id],
                |row| {
                    Ok(body!({
                        "status": row.get::<_, String>(0)?,
                        "startedAt": row.get::<_, Option<i64>>(1)?,
                        "finishedAt": row.get::<_, Option<i64>>(2)?,
                        "sessionId": row.get::<_, Option<String>>(3)?,
                        "report": row.get::<_, String>(4)?,
                    }))
                },
            )
        })();
        if let Ok(row) = &row {
            let report: Value = serde_json::from_str(row["report"].as_str().unwrap()).unwrap();
            if row["status"] == job.status
                && row["startedAt"] == body!(metadata.started_at)
                && row["finishedAt"] == body!(metadata.finished_at)
                && row["sessionId"] == body!(metadata.session_id)
                && metadata.report.as_ref().is_none_or(|expected| {
                    let expected = serde_json::to_value(expected).unwrap();
                    ["state", "claims", "source", "unverified"]
                        .iter()
                        .all(|field| report[field] == expected[field])
                })
            {
                return report;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "automatic indexing did not catch up for {}: {row:?}",
            job.id
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn sweep(state: &App, id: &str) -> Value {
    let response = request(state.clone(), "POST", ROUTE, body!({
        "query":"query($id: ID!) { sweep(id: $id) { id specName remoteIdentity startedAt finishedAt parentId sessionId specRevision status recover snapshotReportState report { state unverified claims { whatChanged why whatWasChecked unresolved } unresolved source { runId record retainedLog logTruncated capturedAt } } } }",
        "variables":{"id":id}
    })).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let result = json(response).await;
    assert!(result.get("errors").is_none(), "{result}");
    assert!(result["data"]["sweep"].is_object(), "{result}");
    result["data"]["sweep"].clone()
}

#[tokio::test]
async fn admission_and_automatic_terminal_report_are_persisted_before_any_memory_query() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    fs::write(root.path().join("hold"), "").unwrap();
    let original = fs::read(root.path().join("a.md")).unwrap();
    let revision = read(root.path(), "a.md").ok().unwrap().revision;
    let before = memory::now();
    let id = build(&state).await;
    let admitted: Job = serde_json::from_slice(
        &fs::read(root.path().join(format!(".spec-output/{id}.json"))).unwrap(),
    )
    .unwrap();
    assert_eq!(admitted.status, "running");
    let metadata = admitted.memory.as_ref().unwrap();
    let started = metadata.started_at.unwrap();
    assert!((before..=memory::now()).contains(&started));
    assert!(metadata.finished_at.is_none());
    assert!(metadata.parent_id.is_none());
    assert!(metadata.session_id.is_none());
    assert_eq!(metadata.spec_revision.as_deref(), Some(revision.as_str()));
    indexed(&state, &admitted).await;
    wait_for_file(&root.path().join("entered")).await;
    fs::remove_file(root.path().join("hold")).unwrap();
    let saved = terminal(&state, &id).await;
    assert_eq!(saved.status, "completed");
    assert_eq!(indexed(&state, &saved).await["state"], "Captured");
    let metadata = saved.memory.unwrap();
    assert_eq!(metadata.started_at, Some(started));
    let finished = metadata.finished_at.unwrap();
    assert!((started..=memory::now()).contains(&finished));
    assert_eq!(metadata.session_id.as_deref(), Some("ses_Memory123"));
    let fresh = app(root.path());
    let record = sweep(&fresh, &id).await;
    assert_eq!(record["status"], "completed");
    assert_eq!(record["recover"], false);
    assert_eq!(record["startedAt"], started);
    assert_eq!(record["finishedAt"], finished);
    assert_eq!(record["specName"], "a.md");
    assert_eq!(
        record["remoteIdentity"],
        state.remote.as_ref().unwrap().identity()
    );
    assert_eq!(record["specRevision"], revision);
    assert_eq!(record["sessionId"], "ses_Memory123");
    assert_eq!(record["snapshotReportState"], "CAPTURED");
    let report = &record["report"];
    assert_eq!(report["state"], "CAPTURED");
    assert_eq!(report["unverified"], true);
    assert_eq!(
        report["claims"],
        serde_json::from_str::<Value>(SUMMARY.lines().nth(1).unwrap()).unwrap()
    );
    assert_eq!(report["unresolved"], body!([]));
    assert_eq!(report["source"]["runId"], id);
    assert_eq!(
        report["source"]["record"],
        format!(".spec-output/{id}.json")
    );
    assert!(
        report["source"]["retainedLog"]
            .as_str()
            .unwrap()
            .contains(SUMMARY)
    );
    assert_eq!(report["source"]["logTruncated"], false);
    assert!((started..=memory::now()).contains(&report["source"]["capturedAt"].as_i64().unwrap()));
    assert_eq!(sweep(&app(root.path()), &id).await, record);
    assert_eq!(fs::read(root.path().join("a.md")).unwrap(), original);
}

#[tokio::test]
async fn continuation_after_restart_keeps_parent_session_revision_and_distinct_sweep_times() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let parent = build(&state).await;
    indexed(&state, &terminal(&state, &parent).await).await;
    let original = sweep(&state, &parent).await;
    fs::write(
        root.path().join("a.md"),
        "later edit, not the continued snapshot\n",
    )
    .unwrap();
    let mut fresh = app(root.path());
    fresh.remote = state.remote.clone();
    let before = memory::now();
    let response = request(
        fresh.clone(),
        "POST",
        &format!("/api/runs/{parent}/continue"),
        body!({}),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "{}",
        json(response).await
    );
    let child = json(response).await["id"].as_str().unwrap().to_owned();
    assert_ne!(child, parent);
    indexed(&fresh, &terminal(&fresh, &child).await).await;
    let continued = sweep(&fresh, &child).await;
    assert_eq!(continued["parentId"], parent);
    assert_eq!(continued["sessionId"], original["sessionId"]);
    assert_eq!(continued["specRevision"], original["specRevision"]);
    assert_ne!(
        continued["specRevision"],
        read(root.path(), "a.md").ok().unwrap().revision
    );
    let started = continued["startedAt"].as_i64().unwrap();
    assert!((before..=memory::now()).contains(&started));
    assert!(started >= original["finishedAt"].as_i64().unwrap());
    assert!((started..=memory::now()).contains(&continued["finishedAt"].as_i64().unwrap()));
    assert_eq!(continued["report"]["source"]["runId"], child);
    assert_eq!(sweep(&fresh, &parent).await, original);
    let parent_saved = recovery::load(&fresh, &parent)
        .ok()
        .unwrap()
        .memory
        .unwrap();
    assert_eq!(parent_saved.session_id.as_deref(), Some("ses_Memory123"));
    assert_eq!(
        parent_saved.spec_revision.unwrap(),
        original["specRevision"]
    );
    assert_eq!(
        fs::read_to_string(root.path().join("a.md")).unwrap(),
        "later edit, not the continued snapshot\n"
    );
}

#[tokio::test]
async fn queued_build_records_parent_and_captured_new_revision_not_later_autosave() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    fs::write(root.path().join("hold"), "").unwrap();
    let parent = build(&state).await;
    wait_for_file(&root.path().join("entered")).await;
    let parent_revision = read(root.path(), "a.md").ok().unwrap().revision;
    fs::write(root.path().join("a.md"), "queued new requirement\n").unwrap();
    let revision = read(root.path(), "a.md").ok().unwrap().revision;
    let response = request(
        state.clone(),
        "POST",
        &format!("/api/runs/{parent}/queued-build"),
        body!({"name":"a.md", "revision":revision}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    fs::write(root.path().join("a.md"), "later autosave\n").unwrap();
    fs::remove_file(root.path().join("hold")).unwrap();
    terminal(&state, &parent).await;
    let before = memory::now();
    queued_builds::dispatch(&state).await.ok().unwrap();
    let response = request(state.clone(), "GET", "/api/queued-builds", Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    let queued = json(response).await;
    assert_eq!(queued[0]["status"], "started", "{queued}");
    let child = queued[0]["id"].as_str().unwrap();
    assert_ne!(child, parent);
    let saved = terminal(&state, child).await;
    indexed(&state, &saved).await;
    let metadata = saved.memory.unwrap();
    assert_eq!(metadata.parent_id.as_deref(), Some(parent.as_str()));
    assert_eq!(metadata.spec_revision.as_deref(), Some(revision.as_str()));
    assert_ne!(revision, parent_revision);
    assert!((before..=memory::now()).contains(&metadata.started_at.unwrap()));
    assert!(metadata.finished_at.unwrap() >= metadata.started_at.unwrap());
    let record = sweep(&state, child).await;
    assert_eq!(record["parentId"], parent);
    assert_eq!(record["specRevision"], revision);
    assert_eq!(record["status"], "completed");
    assert_eq!(
        fs::read_to_string(root.path().join("a.md")).unwrap(),
        "later autosave\n"
    );
}

#[tokio::test]
async fn missing_reports_preserve_failed_cancelled_and_completed_operational_status() {
    for outcome in ["failed", "cancelled", "completed"] {
        let root = tempfile::tempdir().unwrap();
        let state = fixture(root.path());
        fs::write(
            root.path().join(".bash_aliases"),
            match outcome {
            "failed" => "spec() { printf 'ses_Failed123\\n' > \"${2%/*}/session-id\"; printf 'no summary\\n'; return 7; }\n",
            "cancelled" => "spec() { printf 'ses_Cancelled123\\n' > \"${2%/*}/session-id\"; touch \"$HOME/entered\"; sleep 60; }\n",
                _ => "spec() { printf 'no summary or session capture\n'; }\n",
            },
        )
        .unwrap();
        let id = build(&state).await;
        if outcome == "cancelled" {
            wait_for_file(&root.path().join("entered")).await;
            let response = request(
                state.clone(),
                "POST",
                &format!("/api/runs/{id}/cancel"),
                Value::Null,
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
        }
        let saved = terminal(&state, &id).await;
        assert!(saved.status.starts_with(outcome), "{}", saved.status);
        indexed(&state, &saved).await;
        let metadata = saved.memory.unwrap();
        assert!(metadata.finished_at.unwrap() >= metadata.started_at.unwrap());
        assert_eq!(
            metadata.session_id.as_deref(),
            match outcome {
                "failed" => Some("ses_Failed123"),
                "cancelled" => Some("ses_Cancelled123"),
                _ => None,
            }
        );
        let record = sweep(&app(root.path()), &id).await;
        assert_eq!(record["status"], saved.status);
        assert_eq!(record["recover"], false);
        assert_eq!(record["report"]["state"], "MISSING");
        assert_eq!(record["snapshotReportState"], "MISSING");
        assert_eq!(record["report"]["unverified"], true);
        assert!(record["report"]["claims"].is_null());
        assert!(
            record["report"]["unresolved"]
                .as_array()
                .unwrap()
                .iter()
                .any(|warning| {
                    warning
                        .as_str()
                        .unwrap()
                        .contains("checks and completion are not established")
                })
        );
    }
}

#[tokio::test]
async fn terminal_output_log_captures_report_without_replacing_attached_buffer_and_rebuilds() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let id = Uuid::new_v4().to_string();
    let started = memory::now();
    let original = b"original attached stream without a summary\n";
    let mut job: Job = serde_json::from_value(body!({
        "id":id, "name":"a.md", "status":"running", "recover":true,
        "output":original.to_vec(), "truncated":false,
        "remote_identity":state.remote.as_ref().unwrap().identity(),
        "memory":{
            "started_at":started, "finished_at":null, "parent_id":null,
            "session_id":null, "spec_revision":"original-revision"
        }
    }))
    .unwrap();
    job.attached = true;
    let control = job.stop.subscribe();
    recovery::persist(&state, &job).ok().unwrap();
    recovery::set_latest(&state, &job).ok().unwrap();
    state.jobs.lock().unwrap().push(job);
    let directory = root.path().join(format!(".spec-runs/run-{id}"));
    fs::create_dir_all(&directory).unwrap();
    for path in [directory.parent().unwrap(), directory.as_path()] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    for (name, contents) in [
        ("a.md.out", SUMMARY),
        ("status", "0\n"),
        ("session-id", "ses_RemoteMemory123\n"),
    ] {
        let path = directory.join(name);
        fs::write(&path, contents).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let before = memory::now();
    let response = request(state.clone(), "GET", "/api/files/a.md/run/log", Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    let output = json(response).await;
    assert_eq!(output["output"], SUMMARY);
    assert_eq!(output["status"], "completed");
    assert_eq!(output["recoverable"], false);
    assert!(*control.borrow() == RunControl::Detach);
    {
        let jobs = state.jobs.lock().unwrap();
        assert!(jobs[0].attached);
        assert_eq!(jobs[0].output.iter().copied().collect::<Vec<_>>(), original);
    }
    let saved = recovery::load(&state, &id).ok().unwrap();
    assert_eq!(saved.output.iter().copied().collect::<Vec<_>>(), original);
    assert_eq!(saved.status, "completed");
    assert!(!saved.recover);
    let metadata = saved.memory.as_ref().unwrap();
    let finished = metadata.finished_at.unwrap();
    assert!((before..=memory::now()).contains(&finished));
    assert_eq!(metadata.started_at, Some(started));
    assert_eq!(metadata.session_id.as_deref(), Some("ses_RemoteMemory123"));
    let captured = serde_json::to_value(metadata.report.as_ref().unwrap()).unwrap();
    assert_eq!(captured["state"], "Captured");
    assert_eq!(
        captured["claims"],
        serde_json::from_str::<Value>(SUMMARY.lines().nth(1).unwrap()).unwrap()
    );
    let indexed_report = indexed(&state, &saved).await;
    assert_eq!(indexed_report["source"], captured["source"]);
    assert_eq!(indexed_report["claims"], captured["claims"]);
    assert!(
        indexed_report["unresolved"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| { warning.as_str().unwrap().contains("Prior captured summary") })
    );
    let record = sweep(&state, &id).await;
    assert_eq!(record["finishedAt"], finished);
    assert_eq!(record["sessionId"], "ses_RemoteMemory123");
    assert_eq!(record["report"]["state"], "CAPTURED");
    assert_eq!(record["snapshotReportState"], "MISSING");
    assert_eq!(record["report"]["source"]["retainedLog"], SUMMARY);

    // Copy only canonical JSON; never unlink a database an index worker may still use.
    let rebuilt_root = tempfile::tempdir().unwrap();
    let rebuilt = app(rebuilt_root.path());
    let filename = format!("{id}.json");
    let bytes = fs::read(root.path().join(".spec-output").join(&filename)).unwrap();
    let directory = recovery::directory(&rebuilt, true).ok().unwrap();
    recovery::atomic(&directory, &filename, &bytes)
        .ok()
        .unwrap();
    assert!(
        !rebuilt_root
            .path()
            .join(".spec-output/memory.sqlite3")
            .exists()
    );
    assert_eq!(sweep(&rebuilt, &id).await, record);
    assert_eq!(
        fs::read(rebuilt_root.path().join(".spec-output").join(filename)).unwrap(),
        bytes
    );
}

#[tokio::test]
async fn busy_or_unsafe_memory_database_does_not_block_admission_or_cancellation() {
    for busy in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let state = fixture(root.path());
        let directory = recovery::directory(&state, true).ok().unwrap();
        drop(directory);
        let database = root.path().join(".spec-output/memory.sqlite3");
        let lock = if busy {
            let response = request(
                state.clone(),
                "POST",
                ROUTE,
                body!({"query":"{ sweeps { total } }"}),
            )
            .await;
            assert_eq!(json(response).await, body!({"data":{"sweeps":{"total":0}}}));
            let db = Connection::open(&database).unwrap();
            db.execute_batch("BEGIN EXCLUSIVE").unwrap();
            Some(db)
        } else {
            // A directory at the database path is rejected without damaging JSON storage.
            fs::create_dir(&database).unwrap();
            let response = request(
                state.clone(),
                "POST",
                ROUTE,
                body!({"query":"{ sweeps { total } }"}),
            )
            .await;
            assert!(json(response).await["errors"].is_array());
            None
        };
        fs::write(root.path().join("hold"), "").unwrap();
        let before = tokio::time::Instant::now();
        let id = tokio::time::timeout(Duration::from_secs(1), build(&state))
            .await
            .expect("database blocked admission");
        assert!(before.elapsed() < Duration::from_secs(1));
        assert!(recovery::load(&state, &id).ok().unwrap().recover);
        wait_for_file(&root.path().join("entered")).await;
        let before = tokio::time::Instant::now();
        let response = tokio::time::timeout(
            Duration::from_secs(1),
            request(
                state.clone(),
                "POST",
                &format!("/api/runs/{id}/cancel"),
                Value::Null,
            ),
        )
        .await
        .expect("database blocked cancellation");
        assert_eq!(response.status(), StatusCode::OK);
        assert!(before.elapsed() < Duration::from_secs(1));
        let saved = terminal(&state, &id).await;
        assert_eq!(saved.status, "cancelled");
        assert!(saved.memory.as_ref().unwrap().finished_at.is_some());
        assert_eq!(
            saved.memory.as_ref().unwrap().session_id.as_deref(),
            Some("ses_Memory123")
        );
        if let Some(db) = lock {
            db.execute_batch("ROLLBACK").unwrap();
        } else {
            fs::remove_dir(&database).unwrap();
        }
        // Retry from the canonical terminal record after the index becomes available.
        recovery::persist(&state, &saved).ok().unwrap();
        indexed(&state, &saved).await;
        assert_eq!(sweep(&state, &id).await["status"], "cancelled");
    }
}

#[tokio::test]
async fn concurrent_graphql_backfill_and_job_finalization_do_not_deadlock() {
    let root = tempfile::tempdir().unwrap();
    let state = fixture(root.path());
    let directory = recovery::directory(&state, true).ok().unwrap();
    for _ in 0..32 {
        let id = Uuid::new_v4().to_string();
        let legacy = body!({
            "id":id, "name":"historical.md", "status":"completed",
            "output":[], "truncated":false, "recover":false,
            "remote_identity":state.remote.as_ref().unwrap().identity()
        });
        recovery::atomic(
            &directory,
            &format!("{id}.json"),
            &serde_json::to_vec(&legacy).unwrap(),
        )
        .ok()
        .unwrap();
    }
    tokio::time::timeout(Duration::from_secs(15), async {
        let queries = async {
            let mut tasks = tokio::task::JoinSet::new();
            for _ in 0..8 {
                let state = state.clone();
                tasks.spawn(async move {
                    let response = request(
                        state,
                        "POST",
                        ROUTE,
                        body!({"query":"{ sweeps { total } }"}),
                    )
                    .await;
                    assert_eq!(response.status(), StatusCode::OK);
                    let result = json(response).await;
                    assert!(result.get("errors").is_none(), "{result}");
                    assert!(result["data"]["sweeps"]["total"].as_u64().unwrap() >= 32);
                });
            }
            while let Some(result) = tasks.join_next().await {
                result.unwrap();
            }
        };
        let job = async {
            let id = build(&state).await;
            let saved = terminal(&state, &id).await;
            indexed(&state, &saved).await;
            assert_eq!(saved.status, "completed");
            assert_eq!(sweep(&state, &id).await["report"]["state"], "CAPTURED");
        };
        tokio::join!(queries, job);
    })
    .await
    .expect("concurrent memory backfill and job finalization deadlocked");
}

#[tokio::test]
async fn historical_json_without_memory_imports_through_api_without_inventing_timestamps() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join(".spec-output");
    fs::create_dir(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    let id = Uuid::new_v4().to_string();
    let legacy = body!({
        "id":id, "name":"deleted-spec.md", "status":"completed",
        "output":b"old output without a summary".to_vec(), "truncated":false,
        "remote_identity":"a".repeat(64), "recover":false
    });
    let path = directory.join(format!("{id}.json"));
    let bytes = serde_json::to_vec(&legacy).unwrap();
    fs::write(&path, &bytes).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(!directory.join("memory.sqlite3").exists());
    let before = memory::now();
    let record = sweep(&app(root.path()), &id).await;
    assert_eq!(record["status"], "completed");
    for field in [
        "startedAt",
        "finishedAt",
        "parentId",
        "sessionId",
        "specRevision",
    ] {
        assert!(record[field].is_null(), "invented {field}: {record}");
    }
    assert_eq!(record["report"]["state"], "MISSING");
    assert!(record["report"]["claims"].is_null());
    assert!(
        (before..=memory::now())
            .contains(&record["report"]["source"]["capturedAt"].as_i64().unwrap())
    );
    assert_eq!(sweep(&app(root.path()), &id).await, record);
    assert_eq!(fs::read(path).unwrap(), bytes);
    assert!(!root.path().join("deleted-spec.md").exists());
}

#[tokio::test]
async fn memory_route_requires_bearer_token_and_does_not_grant_cross_origin_access() {
    let root = tempfile::tempdir().unwrap();
    let state = app(root.path());
    for origin in [None, Some("https://untrusted.example"), Some("null")] {
        for token in [None, Some("Bearer wrong-token"), Some("Bearer test-token")] {
            let mut builder = Request::builder()
                .method("POST")
                .uri(ROUTE)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::COOKIE, "token=test-token");
            if let Some(origin) = origin {
                builder = builder.header(header::ORIGIN, origin);
            }
            if let Some(token) = token {
                builder = builder.header(header::AUTHORIZATION, token);
            }
            let response = router(state.clone())
                .oneshot(
                    builder
                        .body(Body::from(
                            body!({"query":"{ sweeps { total } }"}).to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            let authorized = token == Some("Bearer test-token");
            assert_eq!(
                response.status(),
                if authorized {
                    StatusCode::OK
                } else {
                    StatusCode::UNAUTHORIZED
                }
            );
            assert!(
                !response
                    .headers()
                    .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            );
            assert!(
                !response
                    .headers()
                    .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
            );
            if authorized {
                assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
                assert_eq!(json(response).await, body!({"data":{"sweeps":{"total":0}}}));
            }
        }
    }
    let root = tempfile::tempdir().unwrap();
    for method in ["POST", "OPTIONS"] {
        let response = router(app(root.path()))
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(format!("{ROUTE}?token=test-token"))
                    .header(header::ORIGIN, "https://untrusted.example")
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                    .header(
                        header::ACCESS_CONTROL_REQUEST_HEADERS,
                        "authorization, content-type",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(
            !response
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        );
    }
    assert!(!root.path().join(".spec-output").exists());
}

#[tokio::test]
async fn memory_route_enforces_json_post_and_64_kib_body_limit_before_storage() {
    let root = tempfile::tempdir().unwrap();
    let state = app(root.path());
    for (method, content_type, payload, status) in [
        (
            "GET",
            "application/json",
            "{}".into(),
            StatusCode::METHOD_NOT_ALLOWED,
        ),
        (
            "POST",
            "text/plain",
            "{}".into(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
        (
            "POST",
            "application/json",
            "{".into(),
            StatusCode::BAD_REQUEST,
        ),
        (
            "POST",
            "application/json",
            body!({"query":"{ sweeps { total } }", "variables":{"padding":"x".repeat(64 * 1024)}})
                .to_string(),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
    ] {
        let response = router(state.clone())
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(ROUTE)
                    .header(header::AUTHORIZATION, "Bearer test-token")
                    .header(header::CONTENT_TYPE, content_type)
                    .body(Body::from(payload))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }
    assert!(!root.path().join(".spec-output").exists());
    let mut payload = body!({"query":"{ sweeps { total } }"}).to_string();
    payload.push_str(&" ".repeat(64 * 1024 - payload.len()));
    let response = router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(ROUTE)
                .header(header::AUTHORIZATION, "Bearer test-token")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(payload))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json(response).await, body!({"data":{"sweeps":{"total":0}}}));
}
