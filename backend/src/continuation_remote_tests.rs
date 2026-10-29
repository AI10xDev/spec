use crate::{remote::Remote, tests::remote_fixture};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Stdio, time::Duration};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

const PROMPT: &str = "Use the recommended option from your last response and continue the build session. Implement it now; do not stop at a plan. If no recommended option was provided, explain what input is needed rather than guessing.";
const MISSING: &str =
    "This build has no saved session ID. Start a new build to enable continuation.";

fn private_file(path: impl AsRef<Path>, content: impl AsRef<[u8]>) {
    fs::write(&path, content).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

async fn launch(mut command: tokio::process::Command, payload: &str) -> std::process::Output {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let _ = stdin.write_all(payload.as_bytes()).await;
    let output = tokio::time::timeout(Duration::from_secs(8), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    drop(stdin); // EOF must not detach the harness before terminal status.
    output
}

#[test]
fn capture_plugin_merges_config_records_first_root_synchronously_and_cleans_up() {
    let mut runtimes = 0;
    for runtime in ["bun", "node"] {
        let found = std::process::Command::new("bash")
            .args(["-c", &format!("type -P {runtime}")])
            .output()
            .unwrap();
        if !found.status.success() {
            continue;
        }
        runtimes += 1;
        let executable = String::from_utf8(found.stdout).unwrap();
        for config in [
            serde_json::json!({}),
            serde_json::json!({"plugin":["existing-plugin", "file:///custom/plugin.mjs", ["configured-plugin", {"enabled":true,"nested":[1,null]}]], "instructions":["AGENTS.md"], "model":"custom/model", "provider":{"custom":{"options":{"apiKey":"preserved"}}}}),
        ] {
            let root = tempfile::Builder::new()
                .prefix("capture ' $; ")
                .tempdir()
                .unwrap();
            let snapshot = root.path().join("snapshot.md");
            private_file(&snapshot, "unchanged snapshot");
            fs::write(root.path().join(".bash_aliases"), r#"
alias spec=fixture_build
fixture_build() {
    "$TEST_RUNTIME" --input-type=module -e '
import fs from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const pluginURL = config.plugin.at(-1);
const plugin = fileURLToPath(pluginURL);
assert.equal(fs.statSync(plugin).mode & 0o777, 0o600);
const session = process.env.HOME + "/session-id";
const hook = await (await import(pluginURL)).default();
hook.event({event:{type:"other"}});
hook.event({event:{type:"session.created",properties:{info:{id:"ses_child",parentID:"ses_parent"}}}});
hook.event({event:{type:"session.created",properties:{info:{id:"invalid"}}}});
assert.equal(fs.existsSync(session), false);
hook.event({event:{type:"session.created",properties:{info:{id:"ses_First123"}}}});
assert.equal(fs.readFileSync(session, "utf8"), "ses_First123\n");
hook.event({event:{type:"session.created",properties:{info:{id:"ses_Second"}}}});
assert.equal(fs.readFileSync(session, "utf8"), "ses_First123\n");
assert.equal(fs.statSync(session).mode & 0o777, 0o600);
assert.equal(process.env.OPENCODE_CONFIG, "/preserved/config.json");
process.stdout.write(JSON.stringify({config, plugin}));
' || return
    return 7
}
"#).unwrap();
            let output = std::process::Command::new("/bin/bash")
                .args([
                    "--noprofile",
                    "--norc",
                    "-c",
                    include_str!("remote-alias.bash"),
                    "--",
                ])
                .arg(&snapshot)
                .arg(root.path().join("ready"))
                .env("HOME", root.path())
                .env("TEST_RUNTIME", executable.trim())
                .env("OPENCODE_CONFIG_CONTENT", config.to_string())
                .env("OPENCODE_CONFIG", "/preserved/config.json")
                .output()
                .unwrap();
            assert_eq!(output.status.code(), Some(7), "{runtime}: {output:?}");
            let observed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            let mut expected = config;
            let mut plugins = expected["plugin"].as_array().cloned().unwrap_or_default();
            plugins.push(
                observed["config"]["plugin"]
                    .as_array()
                    .unwrap()
                    .last()
                    .unwrap()
                    .clone(),
            );
            expected["plugin"] = plugins.into();
            let mut instructions = expected["instructions"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let instruction = observed["config"]["instructions"]
                .as_array()
                .unwrap()
                .last()
                .unwrap();
            instructions.push(instruction.clone());
            expected["instructions"] = instructions.into();
            assert_eq!(observed["config"], expected);
            assert!(!Path::new(observed["plugin"].as_str().unwrap()).exists());
            assert!(!Path::new(instruction.as_str().unwrap()).exists());
            assert_eq!(fs::read_to_string(snapshot).unwrap(), "unchanged snapshot");
        }
    }
    assert!(runtimes > 0, "fixture requires Bun or Node.js");
}

#[test]
fn capture_rejects_invalid_plugin_config_before_launch_without_leaking_files() {
    for plugin in [
        serde_json::Value::Null,
        serde_json::json!("plugin"),
        serde_json::json!([1]),
        serde_json::json!([["plugin"]]),
        serde_json::json!([["plugin", null]]),
        serde_json::json!([["plugin", []]]),
        serde_json::json!([["plugin", {}, "extra"]]),
        serde_json::json!([[1, {}]]),
    ] {
        let root = tempfile::tempdir().unwrap();
        let snapshot = root.path().join("snapshot.md");
        private_file(&snapshot, "input");
        fs::write(
            root.path().join(".bash_aliases"),
            "spec() { touch \"$HOME/launched\"; }\n",
        )
        .unwrap();
        let output = std::process::Command::new("bash")
            .args(["-c", include_str!("remote-alias.bash"), "--"])
            .arg(snapshot)
            .arg(root.path().join("ready"))
            .env("HOME", root.path())
            .env(
                "OPENCODE_CONFIG_CONTENT",
                serde_json::json!({"plugin":plugin}).to_string(),
            )
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(125), "{output:?}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("plugin must be an array"));
        assert!(!root.path().join("launched").exists());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 3);
    }
}

#[tokio::test]
async fn continuation_uses_explicit_saved_session_fixed_payload_and_new_build_run() {
    for definition in [
        "alias opencode-source=fixture_engine",
        "opencode-source() { fixture_engine \"$@\"; }",
    ] {
        let root = tempfile::Builder::new()
            .prefix("continue ' $; ")
            .tempdir()
            .unwrap();
        let remote = remote_fixture(root.path(), &root.path().join("unused"));
        fs::write(root.path().join(".bash_aliases"), format!(r#"
{definition}
cd /
fixture_engine() {{
    [[ $SPEC_BUILD_FOREGROUND == 1 && $SPEC_BUILD_AUTO == 1 ]] || return 90
    [[ $OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS == 1 && $OPENCODE_QUESTION_AUTO_RECOMMEND == 1 ]] || return 91
    [[ ! -v SPEC_SESSION_DIR && ! -v KIBI_SPEC_SESSION ]] || return 92
    [[ $PWD == "$HOME" ]] || return 93
    printf "%s\0" "$@"
}}
"#)).unwrap();
        let id = Uuid::new_v4().to_string();
        let name = "- ' $(touch injected) `touch injected`; &.md";
        let output = launch(
            remote.continuation_command(PROMPT.len(), &id, name, "ses_Original123"),
            PROMPT,
        )
        .await;
        assert!(output.status.success(), "{output:?}");
        let args: Vec<_> = output.stdout.split(|b| *b == 0).collect();
        assert_eq!(
            args,
            vec![
                b"run".as_slice(),
                b"--dir",
                remote.directory.as_bytes(),
                b"--session",
                b"ses_Original123",
                b"--agent",
                b"build",
                b"--",
                PROMPT.as_bytes(),
                b""
            ]
        );
        let run = root.path().join(format!(".spec-runs/run-{id}"));
        assert!(!run.join("snapshot.md").exists());
        assert_eq!(fs::read_to_string(run.join("status")).unwrap(), "0\n");
        assert_eq!(
            remote.session_id(&id, name).await.unwrap(),
            "ses_Original123"
        );
        assert!(!root.path().join("injected").exists());
        let next_id = Uuid::new_v4().to_string();
        let next = launch(
            remote.continuation_command(PROMPT.len(), &next_id, name, "ses_Original123"),
            PROMPT,
        )
        .await;
        assert!(next.status.success(), "{next:?}");
        assert_eq!(
            remote.session_id(&next_id, name).await.unwrap(),
            "ses_Original123"
        );
        assert!(run.join("status").exists());
    }
}

#[tokio::test]
async fn initial_build_capture_survives_snapshot_cleanup_and_continues_same_session() {
    let root = tempfile::tempdir().unwrap();
    let remote = remote_fixture(root.path(), &root.path().join("unused"));
    fs::write(root.path().join(".bash_aliases"), r#"
spec() {
    runtime=$(type -P bun || type -P node)
    "$runtime" --input-type=module -e '
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const hook = await (await import(config.plugin.at(-1))).default();
hook.event({event:{type:"session.created",properties:{info:{id:"ses_InitialRoot"}}}});
process.stdout.write("Recommended option: continue the implementation.");
'
}
opencode-source() {
    [[ $# == 9 && $1 == run && $4 == --session && $5 == ses_InitialRoot && $6 == --agent && $7 == build && $8 == -- ]] || return 90
    printf '%s' "$9"
}
"#).unwrap();
    let id = Uuid::new_v4().to_string();
    let output = launch(remote.command(5, &id, "a.md"), "input").await;
    assert!(output.status.success(), "{output:?}");
    let run = root.path().join(format!(".spec-runs/run-{id}"));
    assert!(!run.join("snapshot.md").exists());
    let mut names: Vec<_> = fs::read_dir(&run)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            "a.md.out",
            "invocation",
            "lease",
            "provenance",
            "session-id",
            "status"
        ]
    );
    let session = remote.session_id(&id, "a.md").await.unwrap();
    assert_eq!(session, "ses_InitialRoot");
    let continuation = launch(
        remote.continuation_command(PROMPT.len(), &Uuid::new_v4().to_string(), "a.md", &session),
        PROMPT,
    )
    .await;
    assert!(continuation.status.success(), "{continuation:?}");
    assert_eq!(continuation.stdout, PROMPT.as_bytes());
}

#[test]
fn continuation_merges_completion_instructions_without_capture_and_restores_workspace() {
    for config in [
        serde_json::json!({}),
        serde_json::json!({"instructions":["AGENTS.md"], "plugin":["existing", ["configured", {"nested":{"enabled":true}}]], "model":"custom/model"}),
    ] {
        let root = tempfile::Builder::new()
            .prefix("continue ' $; ")
            .tempdir()
            .unwrap();
        let snapshot = root.path().join("snapshot.md");
        private_file(&snapshot, PROMPT);
        private_file(root.path().join("session-id"), "ses_Existing123\n");
        fs::write(root.path().join(".bash_aliases"), r#"
cd /
alias opencode-source=fixture_engine
fixture_engine() {
    runtime=$(type -P bun || type -P node)
    "$runtime" -e '
const fs = require("node:fs");
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const instruction = config.instructions.at(-1);
process.stdout.write(JSON.stringify({config, instruction, text:fs.readFileSync(instruction,"utf8"), mode:fs.statSync(instruction).mode & 0o777, cwd:process.cwd(), args:process.argv.slice(1)}));
' "$@" || return
    return 42
}
"#).unwrap();
        let output = std::process::Command::new("bash")
            .args(["-c", include_str!("remote-alias.bash"), "--"])
            .arg(&snapshot)
            .arg(root.path().join("ready"))
            .current_dir(root.path())
            .env("HOME", root.path())
            .env("OPENCODE_CONFIG_CONTENT", config.to_string())
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(42), "{output:?}");
        let observed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(observed["cwd"], serde_json::json!(root.path()));
        assert_eq!(
            observed["args"],
            serde_json::json!([
                "run",
                "--dir",
                root.path(),
                "--session",
                "ses_Existing123",
                "--agent",
                "build",
                "--",
                PROMPT
            ])
        );
        let mut expected = config;
        let mut instructions = expected["instructions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        instructions.push(observed["instruction"].clone());
        expected["instructions"] = instructions.into();
        assert_eq!(
            observed["config"], expected,
            "continuation must not append a capture plugin"
        );
        assert_eq!(observed["mode"], 0o600);
        let text = observed["text"].as_str().unwrap();
        for rule in [
            "completed, not pending",
            "Preserve completed text as context",
            "Do not implement completed requirements again",
            "only to the marked line",
            "fenced code blocks",
            "Prior-output review is required before planning",
            "including when continuing an existing\nsession",
            "completed features, completed refactors, validation evidence",
            "Briefly report this evidence review before presenting next build steps",
            "Refresh this review",
        ] {
            assert!(text.contains(rule), "missing continuation rule: {rule}");
        }
        assert!(text.contains(&format!(
            "Execution workspace (JSON path): {}",
            serde_json::json!(root.path())
        )));
        assert!(text.contains(&format!(
            "Current run directory to exclude (JSON path): {}",
            serde_json::json!(root.path())
        )));
        let instruction = Path::new(observed["instruction"].as_str().unwrap());
        assert_eq!(instruction.parent().unwrap(), root.path());
        assert!(!instruction.exists(), "instructions leaked on nonzero exit");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 4);
        assert_eq!(fs::read_to_string(snapshot).unwrap(), PROMPT);
        assert_eq!(
            fs::read_to_string(root.path().join("session-id")).unwrap(),
            "ses_Existing123\n"
        );
    }
}

#[test]
fn repository_save_does_not_install_capture_plugin() {
    let root = tempfile::tempdir().unwrap();
    let snapshot = root.path().join("snapshot.md");
    private_file(&snapshot, "context");
    fs::write(
        root.path().join(".bash_aliases"),
        "spec() { printf '%s' \"$OPENCODE_CONFIG_CONTENT\"; }\n",
    )
    .unwrap();
    let output = std::process::Command::new("bash")
        .args(["-c", include_str!("remote-alias.bash"), "--"])
        .arg(&snapshot)
        .arg(root.path().join("ready"))
        .args(["repository-save", "exit 0"])
        .env("HOME", root.path())
        .env(
            "OPENCODE_CONFIG_CONTENT",
            r#"{"plugin":["existing-plugin"]}"#,
        )
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let config: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(config["plugin"], serde_json::json!(["existing-plugin"]));
    assert_eq!(config["model"], "azure/gpt-6-sol");
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 3);
}

#[tokio::test]
async fn continuation_rejects_invalid_ids_before_creating_a_run_and_reports_missing_engine() {
    let root = tempfile::tempdir().unwrap();
    let remote = remote_fixture(root.path(), &root.path().join("unused"));
    for session in [
        "",
        "ses_",
        "other",
        "ses_x; touch injected",
        "ses_$(touch injected)",
        "ses_a\n",
        "ses_a/b",
    ] {
        let id = Uuid::new_v4().to_string();
        let output = launch(remote.continuation_command(0, &id, "a.md", session), "").await;
        assert_eq!(output.status.code(), Some(125), "{session}: {output:?}");
        assert!(!root.path().join(format!(".spec-runs/run-{id}")).exists());
    }
    fs::write(root.path().join(".bash_aliases"), "unset -f opencode-source\nunalias opencode-source 2>/dev/null || true\nPATH=/usr/bin:/bin\n").unwrap();
    let output = launch(
        remote.continuation_command(0, &Uuid::new_v4().to_string(), "a.md", "ses_Valid"),
        "",
    )
    .await;
    assert_eq!(output.status.code(), Some(127), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .contains("opencode-source alias/function/launcher not found")
    );
    assert!(!root.path().join("injected").exists());
}

#[tokio::test]
async fn session_preflight_rejects_missing_unsafe_nonterminal_and_mismatched_metadata() {
    for kind in [
        "valid",
        "missing",
        "invalid",
        "large",
        "nul",
        "extra-line",
        "symlink",
        "hardlink",
        "public",
        "fifo",
        "directory",
        "parent-link",
        "run-link",
        "public-parent",
        "public-run",
        "missing-status",
        "running",
        "invalid-status",
        "status-link",
        "wrong-name",
        "log-link",
    ] {
        let root = tempfile::tempdir().unwrap();
        let remote = remote_fixture(root.path(), &root.path().join("unused"));
        fs::write(root.path().join(".bash_aliases"), "touch sourced\n").unwrap();
        let id = Uuid::new_v4().to_string();
        let parent = root.path().join(".spec-runs");
        let run = parent.join(format!("run-{id}"));
        fs::create_dir_all(&run).unwrap();
        for dir in [&parent, &run] {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).unwrap();
        }
        private_file(run.join("a.md.out"), "output");
        private_file(run.join("status"), "0\n");
        let session = run.join("session-id");
        private_file(&session, "ses_Valid123\n");
        let outside = root.path().join("outside");
        private_file(&outside, "ses_Valid123\n");
        match kind {
            "valid" => (),
            "missing" => fs::remove_file(&session).unwrap(),
            "invalid" => private_file(&session, "ses_x; touch injected\n"),
            "large" => private_file(&session, format!("ses_{}\n", "x".repeat(128))),
            "nul" => private_file(&session, b"ses_Valid123\0"),
            "extra-line" => private_file(&session, "ses_Valid123\n\n"),
            "public" => fs::set_permissions(&session, fs::Permissions::from_mode(0o644)).unwrap(),
            "missing-status" => fs::remove_file(run.join("status")).unwrap(),
            "running" => private_file(run.join("status"), "running\n"),
            "invalid-status" => private_file(run.join("status"), "256\n"),
            "wrong-name" => fs::rename(run.join("a.md.out"), run.join("other.md.out")).unwrap(),
            "public-parent" | "public-run" => fs::set_permissions(
                if kind == "public-parent" {
                    &parent
                } else {
                    &run
                },
                fs::Permissions::from_mode(0o755),
            )
            .unwrap(),
            "parent-link" | "run-link" => {
                let path = if kind == "parent-link" { &parent } else { &run };
                fs::rename(path, root.path().join("elsewhere")).unwrap();
                std::os::unix::fs::symlink(root.path().join("elsewhere"), path).unwrap();
            }
            _ => {
                let path = match kind {
                    "status-link" => run.join("status"),
                    "log-link" => run.join("a.md.out"),
                    _ => session,
                };
                fs::remove_file(&path).unwrap();
                match kind {
                    "hardlink" => fs::hard_link(&outside, path).unwrap(),
                    "fifo" => nix::unistd::mkfifo(&path, nix::sys::stat::Mode::S_IRUSR).unwrap(),
                    "directory" => fs::create_dir(path).unwrap(),
                    _ => std::os::unix::fs::symlink(&outside, path).unwrap(),
                }
            }
        }
        let result = remote.session_id(&id, "a.md").await;
        if kind == "valid" {
            assert_eq!(result.unwrap(), "ses_Valid123");
            for (bad_id, bad_name) in [
                ("../outside", "a.md"),
                ("$(touch injected)", "a.md"),
                (&id, "../a.md"),
                (&id, "$(touch injected).md"),
            ] {
                assert!(
                    remote
                        .session_id(bad_id, bad_name)
                        .await
                        .unwrap_err()
                        .contains(MISSING)
                );
            }
        } else {
            assert!(result.unwrap_err().contains(MISSING), "{kind}");
        }
        assert!(!root.path().join("sourced").exists());
        assert!(!root.path().join("injected").exists());
        assert_eq!(fs::read_to_string(outside).unwrap(), "ses_Valid123\n");
    }
}

#[tokio::test]
async fn session_lookup_bounds_and_validates_ssh_responses() {
    let root = tempfile::tempdir().unwrap();
    let remote: Remote = remote_fixture(root.path(), &root.path().join("unused"));
    for script in [
        "exit 0",
        "printf 'ses_\n'",
        "printf 'ses_x\nextra\n'",
        "head -c 300000 /dev/zero",
        "head -c 5000 /dev/zero >&2",
        "printf 'ses_x\n'; exit 255",
    ] {
        fs::write(&remote.binary, format!("#!/bin/bash\n{script}\n")).unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            remote.session_id(&Uuid::new_v4().to_string(), "a.md"),
        )
        .await
        .unwrap();
        assert!(result.is_err(), "{script}");
    }
}
