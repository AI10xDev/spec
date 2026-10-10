use super::*;

fn git(root: &FsPath, args: &[&str]) {
    let output = std::process::Command::new("git")
        .current_dir(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
}

#[tokio::test]
async fn repository_api_disabled_and_live_status_are_authenticated_and_nonlaunching() {
    let root = tempfile::tempdir().unwrap();
    let mut state = app(root.path());
    let disconnected = serde_json::json!({
        "connected": false, "dirty": false, "directory": null, "model": "azure/gpt-6-sol"
    });
    let response = request(
        state.clone(),
        "GET",
        "/api/repository",
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(json(response).await, disconnected);
    assert_eq!(
        request(
            state.clone(),
            "POST",
            "/api/repository/save",
            serde_json::json!({"name":"a.md", "revision":"x"})
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );

    let remote_home = tempfile::tempdir().unwrap();
    let mut remote = remote_fixture(
        remote_home.path(),
        &remote_home.path().join("must-not-launch"),
    );
    remote.directory = root.path().to_str().unwrap().into();
    state.remote = Some(remote);
    assert_eq!(
        json(
            request(
                state.clone(),
                "GET",
                "/api/repository",
                serde_json::Value::Null
            )
            .await
        )
        .await,
        disconnected
    );
    git(root.path(), &["init", "--quiet"]);
    for dirty in [false, true] {
        if dirty {
            fs::write(root.path().join("edited.txt"), "edited").unwrap();
        }
        let response = request(
            state.clone(),
            "GET",
            "/api/repository",
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            json(response).await,
            serde_json::json!({
                "connected": true, "dirty": dirty, "directory": root.path(), "model": "azure/gpt-6-sol"
            })
        );
    }
    assert!(!root.path().join(".spec-runs").exists());
    fs::write(
        &state.remote.as_ref().unwrap().binary,
        "#!/bin/bash\nexit 255\n",
    )
    .unwrap();
    assert_eq!(
        request(state, "GET", "/api/repository", serde_json::Value::Null)
            .await
            .status(),
        StatusCode::BAD_GATEWAY
    );
}

#[tokio::test]
async fn repository_save_revalidates_spec_and_repository_before_creating_jobs() {
    let local = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    let mut state = app(local.path());
    let mut remote = remote_fixture(home.path(), &home.path().join("must-not-launch"));
    remote.directory = repo.path().to_str().unwrap().into();
    state.remote = Some(remote);
    for (name, content, revision, expected) in [
        ("../bad", "context", None, StatusCode::BAD_REQUEST),
        ("missing.md", "context", None, StatusCode::NOT_FOUND),
        ("a.md", "context", Some("stale"), StatusCode::CONFLICT),
        ("a.md", "", None, StatusCode::BAD_REQUEST),
        ("a.md", "context", None, StatusCode::CONFLICT),
    ] {
        fs::write(local.path().join("a.md"), content).unwrap();
        let current = read(local.path(), "a.md").ok().unwrap().revision;
        let response = request(
            state.clone(),
            "POST",
            "/api/repository/save",
            serde_json::json!({"name":name, "revision":revision.unwrap_or(&current)}),
        )
        .await;
        assert_eq!(
            response.status(),
            expected,
            "{name}: {}",
            json(response).await
        );
    }
    git(repo.path(), &["init", "--quiet"]);
    let revision = read(local.path(), "a.md").ok().unwrap().revision;
    assert_eq!(
        request(
            state.clone(),
            "POST",
            "/api/repository/save",
            serde_json::json!({"name":"a.md", "revision":revision})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    fs::write(local.path().join("a.md"), "x".repeat(MAX_BUILD_SPEC + 1)).unwrap();
    let revision = read(local.path(), "a.md").ok().unwrap().revision;
    assert_eq!(
        request(
            state.clone(),
            "POST",
            "/api/repository/save",
            serde_json::json!({"name":"a.md", "revision":revision})
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert!(state.jobs.lock().unwrap().is_empty());
    assert!(!repo.path().join(".spec-runs").exists());
    assert!(!local.path().join(".spec-output").exists());
}

#[tokio::test]
async fn repository_save_blocks_other_spec_runs_including_recovered_unknown_harnesses() {
    for attached in [false, true] {
        for saving in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let mut state = app(root.path());
            state.remote = Some(remote_fixture(
                root.path(),
                &root.path().join("must-not-launch"),
            ));
            let mut prior = persisted_job(
                &Uuid::new_v4().to_string(),
                state.remote.as_ref().unwrap().identity(),
                true,
            );
            prior.repository_save = !saving;
            recovery::persist(&state, &prior).ok().unwrap();
            if attached {
                prior.attached = true;
                state.jobs.lock().unwrap().push(prior);
            }
            fs::write(root.path().join("different.md"), "context").unwrap();
            let revision = read(root.path(), "different.md").ok().unwrap().revision;
            let response = request(
                state.clone(),
                "POST",
                if saving {
                    "/api/repository/save"
                } else {
                    "/api/runs"
                },
                serde_json::json!({"name":"different.md", "revision":revision}),
            )
            .await;
            assert_eq!(response.status(), StatusCode::CONFLICT);
            assert!(
                json(response).await["error"]
                    .as_str()
                    .unwrap()
                    .contains("repository")
            );
            assert_eq!(state.jobs.lock().unwrap().len(), 1);
            assert!(!root.path().join(".spec-runs").exists());
        }
    }
}

#[tokio::test]
async fn repository_save_uses_existing_workflow_model_snapshot_and_recoverable_output() {
    let local = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "--quiet"]);
    fs::write(repo.path().join("edited.txt"), "edited").unwrap();
    let mut remote = remote_fixture(home.path(), &home.path().join("unused"));
    remote.directory = repo.path().to_str().unwrap().into();
    fs::write(home.path().join(".bash_aliases"), r#"
export OPENCODE_CONFIG=/unchanged/config.json
export OPENCODE_CONFIG_CONTENT='{"model":"old/model","instructions":["AGENTS.md"],"provider":{"azure":{"options":{"keep":"secret"}}},"permission":{"edit":"ask"},"agent":{"build":{"model":"old/agent","prompt":"keep workflow"},"other":{"model":"other/model"}},"mode":{"build":{"model":"old/mode","temperature":0.5}}}'
spec() {
    [[ $1 == build && $# == 2 && $SPEC_BUILD_AUTO == 1 && $SPEC_BUILD_FOREGROUND == 1 ]] || return 90
    node -e '
const fs = require("node:fs");
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const path = config.instructions.at(-1);
console.log(JSON.stringify({config, path, instructions: fs.readFileSync(path, "utf8"), snapshot: fs.readFileSync(process.argv[1], "utf8"), cwd: process.cwd(), configFile: process.env.OPENCODE_CONFIG}));
' "$2"
    return 7
}
"#).unwrap();
    let mut state = app(local.path());
    state.remote = Some(remote.clone());
    fs::write(
        local.path().join("a.md"),
        "# completed\npending context only\n",
    )
    .unwrap();
    let document = read(local.path(), "a.md").ok().unwrap();
    let response = request(
        state.clone(),
        "POST",
        "/api/repository/save",
        serde_json::json!({"name":"a.md", "revision":document.revision}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let response = json(response).await;
    assert_eq!(response.as_object().unwrap().len(), 1);
    let id = response["id"].as_str().unwrap();
    let directory = repo.path().join(format!(".spec-runs/run-{id}"));
    wait_for_file(&directory.join("status")).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let _guard = state.recovery_gate.lock().await;
            if !state.jobs.lock().unwrap()[0].recover {
                break;
            }
            drop(_guard);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let mut fresh = app(local.path());
    fresh.remote = Some(remote);
    let output = json(
        request(
            fresh.clone(),
            "GET",
            "/api/files/a.md/run/log",
            serde_json::Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(output["id"], id);
    assert_eq!(output["status"], "failed (exit status: 7)");
    assert_eq!(output["recoverable"], false);
    let observed: serde_json::Value =
        serde_json::from_str(output["output"].as_str().unwrap().trim()).unwrap();
    assert_eq!(observed["snapshot"], document.content);
    assert_eq!(observed["cwd"], repo.path().to_str().unwrap());
    assert_eq!(observed["configFile"], "/unchanged/config.json");
    let config = &observed["config"];
    assert_eq!(config["model"], "azure/gpt-6-sol");
    assert_eq!(config["agent"]["build"]["model"], "azure/gpt-6-sol");
    assert_eq!(config["mode"]["build"]["model"], "azure/gpt-6-sol");
    assert_eq!(config["agent"]["build"]["prompt"], "keep workflow");
    assert_eq!(config["agent"]["other"]["model"], "other/model");
    assert_eq!(config["mode"]["build"]["temperature"], 0.5);
    assert_eq!(config["provider"]["azure"]["options"]["keep"], "secret");
    assert_eq!(config["permission"]["edit"], "ask");
    assert_eq!(config["instructions"][0], "AGENTS.md");
    assert_eq!(config["instructions"].as_array().unwrap().len(), 2);
    for text in [
        "context only",
        "Do not rebuild or implement",
        "AGENTS.md",
        "repository save/commit workflow",
        "Do not push, amend, reset",
    ] {
        assert!(
            observed["instructions"].as_str().unwrap().contains(text),
            "{text}"
        );
    }
    assert!(!FsPath::new(observed["path"].as_str().unwrap()).exists());
    assert!(!directory.join("snapshot.md").exists());
    assert_eq!(
        fs::read_to_string(local.path().join("a.md")).unwrap(),
        document.content
    );
    assert_eq!(
        json(request(fresh, "GET", "/api/files/a.md/run", serde_json::Value::Null).await).await,
        output
    );
    let stored = recovery::load(&state, id).ok().unwrap();
    assert!(stored.repository_save);
    // Legacy persisted runs remain readable without the newly introduced mode.
    let mut legacy = serde_json::to_value(stored).unwrap();
    legacy.as_object_mut().unwrap().remove("repository_save");
    assert!(
        !serde_json::from_value::<Job>(legacy)
            .unwrap()
            .repository_save
    );
}

#[tokio::test]
async fn repository_probe_ignores_session_artifacts_but_counts_staged_and_untracked_edits() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let mut remote = remote_fixture(home.path(), &home.path().join("unused"));
    git(root.path(), &["init", "--quiet"]);
    let nested = root.path().join("nested ' workspace");
    fs::create_dir(&nested).unwrap();
    remote.directory = nested.to_str().unwrap().into();
    let sibling = root.path().join("sibling [workspace]/deeper");
    for parent in [root.path(), nested.as_path(), sibling.as_path()] {
        for artifact in [
            ".spec-runs/run-test/output",
            ".spec-output/job",
            ".spec.lock",
        ] {
            let path = parent.join(artifact);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "session only").unwrap();
        }
    }
    let status = remote.repository_status().await.unwrap();
    assert!(status.connected);
    assert!(!status.dirty);
    assert_eq!(status.directory.as_deref(), root.path().to_str());
    fs::write(sibling.join("edited.txt"), "edited").unwrap();
    assert!(remote.repository_status().await.unwrap().dirty);
    fs::remove_file(sibling.join("edited.txt")).unwrap();
    assert!(!remote.repository_status().await.unwrap().dirty);
    fs::write(root.path().join("outside-workspace.txt"), "untracked").unwrap();
    assert!(remote.repository_status().await.unwrap().dirty);
    git(root.path(), &["add", "outside-workspace.txt"]);
    assert!(remote.repository_status().await.unwrap().dirty);
    fs::remove_file(root.path().join("outside-workspace.txt")).unwrap();
    assert!(remote.repository_status().await.unwrap().dirty);
}

#[test]
fn repository_probe_and_dirty_guard_ignore_inherited_pathspec_settings() {
    let root = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "--quiet"]);
    fs::create_dir_all(root.path().join(".spec-runs/run-test")).unwrap();
    fs::write(root.path().join(".spec-runs/run-test/status"), "0\n").unwrap();
    let settings = [
        "GIT_LITERAL_PATHSPECS",
        "GIT_GLOB_PATHSPECS",
        "GIT_NOGLOB_PATHSPECS",
        "GIT_ICASE_PATHSPECS",
    ];
    for dirty in [false, true] {
        if dirty {
            // A similarly named real file must not be excluded by inherited icase.
            fs::write(root.path().join(".SPEC.lock"), "edited").unwrap();
        }
        for enabled in [
            &settings[0..0],
            &settings[0..1],
            &settings[1..2],
            &settings[2..3],
            &settings[3..4],
            &settings[..],
        ] {
            for guard in [false, true] {
                let mut command = std::process::Command::new("bash");
                command
                    .args([
                        "--noprofile",
                        "--norc",
                        "-c",
                        include_str!("remote-repository.bash"),
                        "--",
                    ])
                    .arg(root.path())
                    .arg(if guard { "require-dirty" } else { "status" })
                    .env("GIT_CONFIG_NOSYSTEM", "1")
                    .env("GIT_CONFIG_GLOBAL", "/dev/null");
                for setting in settings {
                    command.env_remove(setting);
                }
                for setting in enabled {
                    command.env(setting, "1");
                }
                let output = command.output().unwrap();
                assert_eq!(
                    output.status.code(),
                    Some(if guard && !dirty { 125 } else { 0 }),
                    "{enabled:?}, dirty={dirty}, guard={guard}: {output:?}"
                );
                if !guard {
                    assert_eq!(
                        output.stdout,
                        format!(
                            "SPEC-REPOSITORY-1 1 {}\0{}\0",
                            u8::from(dirty),
                            root.path().display()
                        )
                        .as_bytes(),
                        "{enabled:?}"
                    );
                }
            }
        }
    }
}

#[tokio::test]
async fn repository_shell_guard_rechecks_clean_disconnected_and_unfinished_repositories() {
    for condition in [
        "disconnected",
        "clean",
        "unfinished",
        "invalid-status",
        "alias-cleans",
    ] {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let mut remote = remote_fixture(home.path(), &home.path().join("unused"));
        remote.directory = repo.path().to_str().unwrap().into();
        if condition != "disconnected" {
            git(repo.path(), &["init", "--quiet"]);
        }
        if ["unfinished", "invalid-status", "alias-cleans"].contains(&condition) {
            fs::write(repo.path().join("edited"), "edited").unwrap();
        }
        if ["unfinished", "invalid-status"].contains(&condition) {
            let prior = repo
                .path()
                .join(format!(".spec-runs/run-{}", Uuid::new_v4()));
            fs::create_dir_all(&prior).unwrap();
            fs::set_permissions(prior.parent().unwrap(), fs::Permissions::from_mode(0o700))
                .unwrap();
            if condition == "invalid-status" {
                fs::write(prior.join("status"), "bogus").unwrap();
            }
        }
        fs::write(
            home.path().join(".bash_aliases"),
            format!(
                "{}\nspec() {{ touch launched; }}\n",
                if condition == "alias-cleans" {
                    "rm -- edited"
                } else {
                    ":"
                }
            ),
        )
        .unwrap();
        let id = Uuid::new_v4().to_string();
        let mut child = remote
            .repository_command(7, &id, "other.md")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let _ = stdin.write_all(b"context").await;
        let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        drop(stdin);
        assert_eq!(output.status.code(), Some(125), "{condition}: {output:?}");
        assert!(!repo.path().join("launched").exists());
        assert!(
            !repo
                .path()
                .join(format!(".spec-runs/run-{id}/snapshot.md"))
                .exists()
        );
    }
}

#[tokio::test]
async fn repository_status_rejects_malformed_failed_and_oversized_responses() {
    let root = tempfile::tempdir().unwrap();
    let remote = remote_fixture(root.path(), &root.path().join("unused"));
    for script in [
        "exit 0",
        "printf 'SPEC-REPOSITORY-1 1 1\\0relative\\0'",
        "printf 'SPEC-REPOSITORY-1 0 1\\0\\0'",
        "printf 'SPEC-REPOSITORY-1 1 0\\0/repo\\0extra'",
        "printf 'SPEC-REPOSITORY-1 1 1\\0/repo\\0'; exit 255",
        "head -c 20000 /dev/zero",
        "head -c 5000 /dev/zero >&2",
    ] {
        fs::write(&remote.binary, format!("#!/bin/bash\n{script}\n")).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(3), remote.repository_status())
                .await
                .unwrap()
                .is_err(),
            "{script}"
        );
    }
}

#[tokio::test]
async fn repository_lock_survives_detachment_across_workspace_subdirectories_and_symlinks() {
    for saving in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let mut remote = remote_fixture(home.path(), &home.path().join("unused"));
        let git_directory = if saving {
            home.path().join("separate git metadata")
        } else {
            repo.path().join(".git")
        };
        if saving {
            git(
                repo.path(),
                &[
                    "init",
                    "--quiet",
                    "--separate-git-dir",
                    git_directory.to_str().unwrap(),
                ],
            );
        } else {
            git(repo.path(), &["init", "--quiet"]);
        }
        let git_config = fs::read(git_directory.join("config")).unwrap();
        let first_workspace = repo.path().join("first");
        let second_workspace = repo.path().join("second");
        fs::create_dir(&first_workspace).unwrap();
        fs::create_dir(&second_workspace).unwrap();
        symlink(repo.path(), home.path().join("repo-link")).unwrap();
        remote.directory = first_workspace.to_str().unwrap().into();
        let mut other = remote.clone();
        other.directory = home
            .path()
            .join("repo-link/second")
            .to_str()
            .unwrap()
            .into();
        fs::write(repo.path().join("edited"), "edited").unwrap();
        fs::write(
            home.path().join(".bash_aliases"),
            r#"
spec() {
    if [[ ! -f finish ]]; then
        setsid bash -c 'printf "%s" "$$" > daemon-pid; exec sleep 30' </dev/null >/dev/null 2>&1 &
    fi
    touch began
    for ((i=0; i<100; i++)); do [[ ! -f finish ]] || return 0; sleep 0.05; done
    return 7
}
"#,
        )
        .unwrap();
        let id = Uuid::new_v4().to_string();
        let mut command = if saving {
            remote.repository_command(7, &id, "first.md")
        } else {
            remote.command(7, &id, "first.md")
        };
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(b"context").await.unwrap();
        wait_for_file(&first_workspace.join("began")).await;
        wait_for_file(&first_workspace.join("daemon-pid")).await;
        let daemon = Pid::from_raw(
            fs::read_to_string(first_workspace.join("daemon-pid"))
                .unwrap()
                .parse()
                .unwrap(),
        );
        let attachment_retains_lock =
            FsPath::new(&format!("/proc/{}/fd/9", child.id().unwrap())).exists();
        drop(stdin);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), child.wait())
                .await
                .unwrap()
                .unwrap()
                .code(),
            Some(125)
        );
        let next_id = Uuid::new_v4().to_string();
        let mut next = if saving {
            other.command(7, &next_id, "different.md")
        } else {
            other.repository_command(7, &next_id, "different.md")
        };
        let output = next.stdin(Stdio::null()).output().await.unwrap();
        assert_eq!(output.status.code(), Some(125));
        assert!(String::from_utf8_lossy(&output.stderr).contains("Another harness is active"));
        assert_eq!(
            other
                .snapshot(&next_id, false, "different.md")
                .await
                .unwrap()
                .0,
            "failed (exit status: 125)"
        );
        fs::write(first_workspace.join("finish"), "").unwrap();
        fs::write(second_workspace.join("finish"), "").unwrap();
        wait_for_file(&first_workspace.join(format!(".spec-runs/run-{id}/status"))).await;
        // Completion releases the lock and permits the next save, regardless of name.
        let next_id = Uuid::new_v4().to_string();
        let mut next = other
            .repository_command(7, &next_id, "different.md")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = next.stdin.take().unwrap();
        stdin.write_all(b"context").await.unwrap();
        let output = tokio::time::timeout(Duration::from_secs(5), next.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        drop(stdin);
        let daemon_alive = nix::sys::signal::kill(daemon, None).is_ok();
        let _ = nix::sys::signal::kill(daemon, Signal::SIGKILL);
        assert!(output.status.success(), "{output:?}");
        assert!(
            daemon_alive,
            "The detached child must still be alive when the next save finishes"
        );
        assert!(
            !attachment_retains_lock,
            "Only the supervisor should retain the repository lock after handoff"
        );
        assert_eq!(fs::read(git_directory.join("config")).unwrap(), git_config);
    }
}

#[tokio::test]
async fn repository_registry_keeps_crashed_harnesses_unresolved_across_workspaces() {
    for mode in ["build", "repository-save"] {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        git(repo.path(), &["init", "--quiet"]);
        let first = repo.path().join("first");
        let second = repo.path().join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        fs::write(repo.path().join("edited"), "edited").unwrap();
        let mut remote = remote_fixture(home.path(), &home.path().join("unused"));
        remote.directory = second.to_str().unwrap().into();
        fs::write(home.path().join(".bash_aliases"), "spec() { return 0; }\n").unwrap();
        let id = Uuid::new_v4().to_string();
        let mut child = tokio::process::Command::new("bash")
            .env("HOME", home.path())
            .args([
                "-c",
                include_str!("remote-build.bash"),
                "--",
                first.to_str().unwrap(),
                "7",
                include_str!("remote-alias.bash"),
                "exit 125",
                &id,
                "first.md",
                mode,
                include_str!("remote-repository.bash"),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(b"context").await.unwrap();
        let directory = first.join(format!(".spec-runs/run-{id}"));
        wait_for_file(&directory.join("lease")).await;
        drop(stdin);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), child.wait())
                .await
                .unwrap()
                .unwrap()
                .code(),
            Some(125)
        );
        assert!(!directory.join("status").exists());
        let record = repo.path().join(format!(".git/spec-harness/run-{id}"));
        assert_eq!(
            fs::read(&record).unwrap(),
            format!("{}\0{mode}\0", directory.display()).as_bytes()
        );
        // No live process holds the repository lock, but another workspace must still refuse.
        let rejected = Uuid::new_v4().to_string();
        let mut command = if mode == "repository-save" {
            remote.command(7, &rejected, "other.md")
        } else {
            remote.repository_command(7, &rejected, "other.md")
        };
        let output = command.stdin(Stdio::null()).output().await.unwrap();
        assert_eq!(output.status.code(), Some(125));
        assert!(String::from_utf8_lossy(&output.stderr).contains("completion is unresolved"));
        assert_eq!(
            remote
                .snapshot(&rejected, false, "other.md")
                .await
                .unwrap()
                .0,
            "failed (exit status: 125)"
        );
        assert!(record.exists());
        // A terminal status, not a vanished lock, authorizes retiring the pointer.
        fs::write(directory.join("status"), "125\n").unwrap();
        fs::set_permissions(directory.join("status"), fs::Permissions::from_mode(0o600)).unwrap();
        let next_id = Uuid::new_v4().to_string();
        let mut next = remote
            .repository_command(7, &next_id, "other.md")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = next.stdin.take().unwrap();
        stdin.write_all(b"context").await.unwrap();
        let output = tokio::time::timeout(Duration::from_secs(5), next.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        drop(stdin);
        assert!(output.status.success(), "{output:?}");
        assert!(!record.exists());
    }
}

#[tokio::test]
async fn repository_api_rejections_are_terminal_after_restart_but_missing_sessions_are_not() {
    for condition in ["lock", "clean", "ssh-failure", "missing-session"] {
        let local = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        git(repo.path(), &["init", "--quiet"]);
        fs::write(repo.path().join("edited"), "edited").unwrap();
        let mut remote = remote_fixture(home.path(), &home.path().join("unused"));
        remote.directory = repo.path().to_str().unwrap().into();
        fs::write(home.path().join(".bash_aliases"), "spec() { return 0; }\n").unwrap();
        let original_ssh = fs::read_to_string(&remote.binary).unwrap();
        let action = match condition {
            "clean" => format!("rm -- '{}/edited'", repo.path().display()),
            "ssh-failure" => "exit 255".into(),
            "missing-session" => {
                "printf 'Launch rejected before supervisor start.\\n'; exit 0".into()
            }
            _ => ":".into(),
        };
        fs::write(
            &remote.binary,
            original_ssh.replace(
                "exec /bin/bash",
                &format!("if [[ ${{!#}} == 'bash -c '* ]]; then {action}; fi\nexec /bin/bash"),
            ),
        )
        .unwrap();
        let registry = repo.path().join(".git/spec-harness");
        fs::create_dir(&registry).unwrap();
        fs::set_permissions(&registry, fs::Permissions::from_mode(0o700)).unwrap();
        let lock = if condition == "lock" {
            Some(
                nix::fcntl::Flock::lock(
                    File::open(&registry).unwrap(),
                    nix::fcntl::FlockArg::LockExclusiveNonblock,
                )
                .unwrap(),
            )
        } else {
            None
        };
        let mut state = app(local.path());
        state.remote = Some(remote.clone());
        fs::write(local.path().join("a.md"), "context").unwrap();
        let revision = read(local.path(), "a.md").ok().unwrap().revision;
        let body = serde_json::json!({"name":"a.md", "revision":revision});
        let response = request(state.clone(), "POST", "/api/repository/save", body.clone()).await;
        assert_eq!(response.status(), StatusCode::OK);
        let id = json(response).await["id"].as_str().unwrap().to_owned();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let _guard = state.recovery_gate.lock().await;
                if !state.jobs.lock().unwrap()[0].attached {
                    break;
                }
                drop(_guard);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let rejected = ["lock", "clean"].contains(&condition);
        assert_eq!(
            state.jobs.lock().unwrap()[0].recover,
            !rejected,
            "{condition}"
        );
        // Simulate a backend that died before checkpointing the remote rejection.
        let mut checkpoint = recovery::load(&state, &id).ok().unwrap();
        checkpoint.recover = true;
        checkpoint.status = "running".into();
        checkpoint.output.clear();
        recovery::persist(&state, &checkpoint).ok().unwrap();
        let mut fresh = app(local.path());
        fresh.remote = Some(remote.clone());
        let output = json(
            request(
                fresh.clone(),
                "GET",
                &format!("/api/runs/{id}"),
                serde_json::Value::Null,
            )
            .await,
        )
        .await;
        assert_eq!(output["recoverable"], !rejected, "{condition}: {output}");
        if rejected {
            assert_eq!(output["status"], "failed (exit status: 125)");
            assert!(
                output["output"]
                    .as_str()
                    .unwrap()
                    .contains(if condition == "lock" {
                        "Another harness is active"
                    } else {
                        "requires a connected Git worktree"
                    })
            );
        }
        drop(lock);
        fs::write(&remote.binary, &original_ssh).unwrap();
        fs::write(repo.path().join("edited"), "edited again").unwrap();
        let response = request(fresh.clone(), "POST", "/api/repository/save", body).await;
        assert_eq!(
            response.status(),
            if rejected {
                StatusCode::OK
            } else {
                StatusCode::CONFLICT
            },
            "{condition}"
        );
        if rejected {
            let id = json(response).await["id"].as_str().unwrap().to_owned();
            wait_for_file(&repo.path().join(format!(".spec-runs/run-{id}/status"))).await;
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let _guard = fresh.recovery_gate.lock().await;
                    if fresh.jobs.lock().unwrap().iter().all(|job| !job.attached) {
                        break;
                    }
                    drop(_guard);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap();
        }
    }
}

#[test]
fn repository_model_overrides_file_based_legacy_mode_without_discarding_options() {
    for inline in [
        "{}",
        r#"{"mode":{}}"#,
        r#"{"mode":{"build":{"temperature":0.7},"plan":{"model":"inline/plan"}}}"#,
    ] {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        git(repo.path(), &["init", "--quiet"]);
        let snapshot = repo.path().join("snapshot.md");
        fs::write(&snapshot, "context only").unwrap();
        let legacy = home.path().join("legacy.json");
        let legacy_text = r#"{"model":"file/global","agent":{"build":{"prompt":"file workflow"}},"mode":{"build":{"model":"file/legacy","temperature":0.2,"permission":{"edit":"ask"}},"plan":{"model":"file/plan"}},"provider":{"azure":{"options":{"keep":true}}}}"#;
        fs::write(&legacy, legacy_text).unwrap();
        fs::write(home.path().join(".bash_aliases"), r#"
spec() {
    node -e '
const fs = require("node:fs");
const inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const file = JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, "utf8"));
const object = value => value && typeof value === "object" && !Array.isArray(value);
function merge(a, b) {
    const result = {...a};
    for (const [key, value] of Object.entries(b)) result[key] = object(value) && object(a[key]) ? merge(a[key], value) : value;
    return result;
}
const merged = merge(file, inline);
// Upstream migrates legacy mode settings over the agent settings after loading.
const effectiveBuild = merge(merged.agent.build, merged.mode.build);
console.log(JSON.stringify({inline, merged, effectiveBuild}));
'
}
"#).unwrap();
        let output = std::process::Command::new("bash")
            .current_dir(repo.path())
            .args(["-c", include_str!("remote-alias.bash"), "--"])
            .arg(&snapshot)
            .arg(repo.path().join("ready"))
            .arg("repository-save")
            .arg(include_str!("remote-repository.bash"))
            .env("HOME", home.path())
            .env("OPENCODE_CONFIG", &legacy)
            .env("OPENCODE_CONFIG_CONTENT", inline)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        let observed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        for pointer in [
            "/inline/model",
            "/inline/agent/build/model",
            "/inline/mode/build/model",
            "/effectiveBuild/model",
        ] {
            assert_eq!(
                observed.pointer(pointer).unwrap(),
                "azure/gpt-6-sol",
                "{inline}: {pointer}"
            );
        }
        assert_eq!(observed["effectiveBuild"]["prompt"], "file workflow");
        assert_eq!(observed["effectiveBuild"]["permission"]["edit"], "ask");
        assert_eq!(
            observed["effectiveBuild"]["temperature"],
            if inline.contains("0.7") { 0.7 } else { 0.2 }
        );
        assert_eq!(
            observed["merged"]["provider"]["azure"]["options"]["keep"],
            true
        );
        assert_eq!(
            observed["merged"]["mode"]["plan"]["model"],
            if inline.contains("inline/plan") {
                "inline/plan"
            } else {
                "file/plan"
            }
        );
        assert_eq!(fs::read_to_string(&legacy).unwrap(), legacy_text);
    }
}

#[tokio::test]
async fn repository_build_launchers_guard_persisted_save_and_legacy_records() {
    for suffix in [
        "",
        "build\0",
        "repository-save\0",
        "unknown\0",
        "build\0extra",
        "build",
    ] {
        for terminal in [false, true] {
            let home = tempfile::tempdir().unwrap();
            let repo = tempfile::tempdir().unwrap();
            git(repo.path(), &["init", "--quiet"]);
            let mut remote = remote_fixture(home.path(), &home.path().join("unused"));
            remote.directory = repo.path().to_str().unwrap().into();
            fs::write(home.path().join(".bash_aliases"), "spec() { return 0; }\n").unwrap();
            fs::write(repo.path().join("a.md"), "context").unwrap();
            let prior = repo.path().join(".spec-runs/run-prior");
            let registry = repo.path().join(".git/spec-harness");
            for directory in [prior.parent().unwrap(), prior.as_path(), registry.as_path()] {
                fs::create_dir_all(directory).unwrap();
                fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
            }
            let record = registry.join("run-prior");
            fs::write(&record, format!("{}\0{suffix}", prior.display())).unwrap();
            fs::set_permissions(&record, fs::Permissions::from_mode(0o600)).unwrap();
            if terminal {
                fs::write(prior.join("status"), "0\n").unwrap();
                fs::set_permissions(prior.join("status"), fs::Permissions::from_mode(0o600))
                    .unwrap();
            }
            let allowed =
                suffix == "build\0" || (terminal && ["", "repository-save\0"].contains(&suffix));
            for batch in [false, true] {
                let mut command = if batch {
                    let mut command = tokio::process::Command::new("bash");
                    command
                        .env("HOME", home.path())
                        .args([
                            "-c",
                            include_str!("../../scripts/build-projects.bash"),
                            "--",
                        ])
                        .arg(repo.path());
                    command
                } else {
                    remote.command(0, &Uuid::new_v4().to_string(), "a.md")
                };
                let mut child = command
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap();
                let stdin = child.stdin.take().unwrap();
                let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
                    .await
                    .unwrap()
                    .unwrap();
                drop(stdin);
                assert_eq!(
                    output.status.success(),
                    allowed,
                    "suffix={suffix:?}, terminal={terminal}, batch={batch}: {output:?}"
                );
                if !allowed {
                    assert!(
                        String::from_utf8_lossy(&output.stderr)
                            .contains("completion is unresolved")
                    );
                }
                // Shared readers do not retire another owner's record.
                assert!(record.exists());
            }
        }
    }
}

#[tokio::test]
async fn repository_batch_and_backend_exclusion_is_bidirectional_but_builds_can_overlap() {
    for first_save in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        git(repo.path(), &["init", "--quiet"]);
        let first = repo.path().join("first");
        let second = repo.path().join("second");
        for directory in [&first, &second] {
            fs::create_dir(directory).unwrap();
            fs::write(directory.join("a.md"), "context").unwrap();
        }
        let mut remote = remote_fixture(home.path(), &home.path().join("unused"));
        fs::write(
            home.path().join(".bash_aliases"),
            r#"
spec() {
    touch began
    for ((i=0; i<200; i++)); do [[ ! -f finish ]] || return 0; sleep 0.05; done
    return 7
}
"#,
        )
        .unwrap();
        let batch = |directory: &FsPath| {
            let mut command = tokio::process::Command::new("bash");
            command
                .env("HOME", home.path())
                .args([
                    "-c",
                    include_str!("../../scripts/build-projects.bash"),
                    "--",
                ])
                .arg(directory);
            command
        };
        remote.directory = first.to_str().unwrap().into();
        let mut command = if first_save {
            remote.repository_command(0, &Uuid::new_v4().to_string(), "a.md")
        } else {
            batch(&first)
        };
        let mut active = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = active.stdin.take().unwrap();
        wait_for_file(&first.join("began")).await;
        remote.directory = second.to_str().unwrap().into();
        let mut rejected = if first_save {
            batch(&second)
        } else {
            remote.repository_command(0, &Uuid::new_v4().to_string(), "a.md")
        };
        let output = rejected.stdin(Stdio::null()).output().await.unwrap();
        assert_eq!(output.status.code(), Some(125), "{output:?}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("Another harness is active"));
        assert!(!second.join("began").exists());
        fs::write(second.join("finish"), "").unwrap();
        if !first_save {
            // A backend build must still be allowed alongside a batch build.
            let mut concurrent = remote
                .command(0, &Uuid::new_v4().to_string(), "a.md")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let input = concurrent.stdin.take().unwrap();
            let output =
                tokio::time::timeout(Duration::from_secs(5), concurrent.wait_with_output())
                    .await
                    .unwrap()
                    .unwrap();
            drop(input);
            assert!(output.status.success(), "{output:?}");
        }
        fs::write(first.join("finish"), "").unwrap();
        let output = tokio::time::timeout(Duration::from_secs(5), active.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        drop(stdin);
        assert!(output.status.success(), "{output:?}");
        // Once the owner has finished, the previously excluded operation works.
        let mut next_command = if first_save {
            batch(&second)
        } else {
            remote.repository_command(0, &Uuid::new_v4().to_string(), "a.md")
        };
        let mut next = next_command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = next.stdin.take().unwrap();
        let output = tokio::time::timeout(Duration::from_secs(5), next.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        drop(input);
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            fs::read_dir(repo.path().join(".git/spec-harness"))
                .unwrap()
                .count(),
            0
        );
    }
}

#[tokio::test]
async fn repository_interrupted_batch_keeps_record_and_blocks_save_after_lock_release() {
    let home = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "--quiet"]);
    let mut remote = remote_fixture(home.path(), &home.path().join("unused"));
    remote.directory = repo.path().to_str().unwrap().into();
    fs::write(repo.path().join("a.md"), "context").unwrap();
    fs::write(
        home.path().join(".bash_aliases"),
        r#"
spec() {
    touch began
    for ((i=0; i<200; i++)); do [[ ! -f finish ]] || return 0; sleep 0.05; done
    return 7
}
"#,
    )
    .unwrap();
    let mut batch = tokio::process::Command::new("bash")
        .env("HOME", home.path())
        .args([
            "-c",
            include_str!("../../scripts/build-projects.bash"),
            "--",
        ])
        .arg(repo.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .unwrap();
    let batch_group = Pid::from_raw(batch.id().unwrap() as i32);
    wait_for_file(&repo.path().join("began")).await;
    batch.kill().await.unwrap();
    let registry = repo.path().join(".git/spec-harness");
    let record = fs::read_dir(&registry)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let contents = fs::read(&record).unwrap();
    let parts: Vec<_> = contents.split(|byte| *byte == 0).collect();
    assert_eq!(parts[1], b"build");
    let directory = PathBuf::from(std::str::from_utf8(parts[0]).unwrap());
    assert!(!directory.join("status").exists());
    // The build descendants must not retain the batch owner's repository lock.
    let lock = nix::fcntl::Flock::lock(
        File::open(&registry).unwrap(),
        nix::fcntl::FlockArg::LockExclusiveNonblock,
    )
    .unwrap();
    drop(lock);
    let output = remote
        .repository_command(0, &Uuid::new_v4().to_string(), "a.md")
        .stdin(Stdio::null())
        .output()
        .await
        .unwrap();
    assert_eq!(output.status.code(), Some(125), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("completion is unresolved"));
    fs::write(repo.path().join("finish"), "").unwrap();
    let _ = nix::sys::signal::killpg(batch_group, Signal::SIGKILL);
    assert!(record.exists());
    assert!(!directory.join("status").exists());
}

#[test]
fn repository_supervisor_does_not_retire_record_when_status_publication_fails() {
    for blocked in ["status.tmp", "status"] {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("run");
        fs::create_dir(&directory).unwrap();
        // Force the final status write or rename to fail after a successful build.
        fs::create_dir(directory.join(blocked)).unwrap();
        let record = root.path().join("record");
        fs::write(&record, "preserve unresolved run").unwrap();
        let output = std::process::Command::new("bash")
            .args(["-c", include_str!("remote-supervisor.bash"), "--"])
            .arg(&directory)
            .args([": > \"$2\"; exit 0", "a.md.out", "build", ""])
            .arg(&record)
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(blocked),
            "{output:?}"
        );
        assert!(!directory.join("status").is_file());
        assert!(record.exists());
    }
}
