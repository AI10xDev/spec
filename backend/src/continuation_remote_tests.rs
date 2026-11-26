use crate::{
    remote::{BuildResult, Remote},
    tests::remote_fixture,
};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Stdio, time::Duration};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

const PROMPT: &str = "Use the recommended option from your last response and continue the build session. Implement it now; do not stop at a plan. If no recommended option was provided, explain what input is needed rather than guessing.";
const MISSING: &str =
    "This build has no saved session ID. Start a new build to enable continuation.";

fn assert_memory_directive(text: &str) {
    let lines: Vec<_> = text.lines().collect();
    let start = lines
        .iter()
        .position(|line| *line == "SPEC_BUILD_MEMORY_V1")
        .expect("missing standalone memory directive");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(lines[start + 1]).unwrap(),
        serde_json::json!({"whatChanged":[],"why":[],"whatWasChecked":[],"unresolved":[]})
    );
    assert_eq!(lines[start + 2], "END_SPEC_BUILD_MEMORY_V1");
    assert!(text.contains("final response, outside Markdown code fences"));
    assert!(text.contains("Keep the JSON on one line"));
    assert!(text.contains("unverified agent"));
    assert!(text.contains("never manufacture a successful report for a stopped or failed sweep"));
}

fn private_file(path: impl AsRef<Path>, content: impl AsRef<[u8]>) {
    fs::write(&path, content).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

fn workflow_runner(root: &Path, function: &str) {
    let runner = root.join("workflow-runner");
    fs::write(&runner, format!("#!/bin/bash\nif [[ ${{1:-}} == --workflow-version ]]; then printf 'spec-workflow-v1\\n'; exit 0; fi\n{function} build \"$1\"\n")).unwrap();
    fs::set_permissions(runner, fs::Permissions::from_mode(0o700)).unwrap();
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
fn initial_build_exports_supervisor_scope_without_capture_plugin_and_cleans_up() {
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
                .prefix("supervised ' $; ")
                .tempdir()
                .unwrap();
            let snapshot = root.path().join("snapshot.md");
            private_file(&snapshot, "unchanged snapshot");
            workflow_runner(root.path(), "fixture_build");
            fs::write(root.path().join(".bash_aliases"), r#"
alias spec=fixture_build
cd /
export SPEC_BUILD_SESSION_ID=ses_Inherited SPEC_BUILD_SESSION_FILE=/inherited/session-id
export SPEC_BUILD_SUPERVISED=0 SPEC_BUILD_INVOCATION=repository-save OPENCODE_SESSION_ID=ses_Inherited
export OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS=1 OPENCODE_QUESTION_AUTO_RECOMMEND=1
export SPEC_WORKFLOW_RUNNER="$HOME/workflow-runner"
export SPEC_BUILD_STAGE=integrator SPEC_BUILD_HANDOFF_FILE=/inherited/handoff SPEC_BUILD_RESULT_FILE=/inherited/result
fixture_build() {
    [[ $# == 2 && $1 == build && $2 == "$HOME/snapshot.md" ]] || return 90
    "$TEST_RUNTIME" --input-type=module -e '
import fs from "node:fs";
import assert from "node:assert/strict";
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const session = process.env.SPEC_BUILD_SESSION_FILE;
assert.equal(session, process.env.HOME + "/session-id");
assert.equal(process.env.SPEC_BUILD_SESSION_ID, "");
assert.equal(process.env.SPEC_BUILD_SUPERVISED, "1");
assert.equal(process.env.SPEC_BUILD_INVOCATION, "build");
assert.equal(process.env.SPEC_BUILD_STAGE, "builder");
assert.equal(process.env.SPEC_BUILD_HANDOFF_FILE, undefined);
assert.equal(process.env.SPEC_BUILD_RESULT_FILE, process.env.HOME + "/result.json");
assert.equal(process.env.OPENCODE_SESSION_ID, undefined);
assert.equal(process.env.OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS, "0");
assert.equal(process.env.OPENCODE_QUESTION_AUTO_RECOMMEND, "0");
assert.equal(process.cwd(), process.env.HOME);
assert.equal(fs.readdirSync(process.env.HOME).some(p => p.startsWith("spec-build-session.")), false);
assert.equal(fs.existsSync(session), false);
// The launcher/coordinator persists the builder ID, not a root-session plugin.
fs.writeFileSync(session, "ses_Builder123\n", {mode:0o600, flag:"wx"});
assert.equal(fs.statSync(session).mode & 0o777, 0o600);
assert.equal(process.env.OPENCODE_CONFIG, "/preserved/config.json");
process.stdout.write(JSON.stringify({config, text:fs.readFileSync(config.instructions.at(-1), "utf8")}));
' || return
    return 7
}
export -f fixture_build
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
                .current_dir(root.path())
                .env("HOME", root.path())
                .env("TEST_RUNTIME", executable.trim())
                .env("OPENCODE_CONFIG_CONTENT", config.to_string())
                .env("OPENCODE_CONFIG", "/preserved/config.json")
                .output()
                .unwrap();
            assert_eq!(output.status.code(), Some(7), "{runtime}: {output:?}");
            let observed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            let mut expected = config;
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
            assert_memory_directive(observed["text"].as_str().unwrap());
            assert!(!Path::new(instruction.as_str().unwrap()).exists());
            assert_eq!(
                fs::read_to_string(root.path().join("session-id")).unwrap(),
                "ses_Builder123\n"
            );
            assert_eq!(fs::read_to_string(snapshot).unwrap(), "unchanged snapshot");
        }
    }
    assert!(runtimes > 0, "fixture requires Bun or Node.js");
}

#[test]
fn build_rejects_invalid_plugin_config_before_launch_without_leaking_files() {
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
        "alias spec=fixture_engine",
        "spec() { fixture_engine \"$@\"; }",
    ] {
        let root = tempfile::Builder::new()
            .prefix("continue ' $; ")
            .tempdir()
            .unwrap();
        let remote = remote_fixture(root.path(), &root.path().join("unused"));
        workflow_runner(root.path(), "fixture_engine");
        fs::write(root.path().join(".bash_aliases"), format!(r#"
{definition}
cd /
export SPEC_BUILD_SESSION_ID=ses_Inherited SPEC_BUILD_SESSION_FILE=/inherited/session-id
export SPEC_BUILD_SUPERVISED=0 SPEC_BUILD_INVOCATION=repository-save OPENCODE_SESSION_ID=ses_Inherited
export OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS=1 OPENCODE_QUESTION_AUTO_RECOMMEND=1
export SPEC_WORKFLOW_RUNNER="$HOME/workflow-runner"
fixture_engine() {{
    [[ $SPEC_BUILD_FOREGROUND == 1 && $SPEC_BUILD_AUTO == 1 ]] || return 90
    [[ $OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS == 0 && $OPENCODE_QUESTION_AUTO_RECOMMEND == 0 ]] || return 91
    [[ ! -v SPEC_SESSION_DIR && ! -v KIBI_SPEC_SESSION && ! -v OPENCODE_SESSION_ID ]] || return 92
    [[ $PWD == "$HOME" ]] || return 93
    [[ $# == 2 && $1 == build && $2 == /*/snapshot.md ]] || return 94
    [[ $SPEC_BUILD_SESSION_FILE == "${{2%/*}}/session-id" && $SPEC_BUILD_SESSION_ID == ses_Original123 ]] || return 95
    [[ $SPEC_BUILD_SUPERVISED == 1 && $SPEC_BUILD_INVOCATION == build ]] || return 96
    cat -- "$2"
}}
export -f fixture_engine
"#)).unwrap();
        let id = Uuid::new_v4().to_string();
        let name = "- ' $(touch injected) `touch injected`; &.md";
        let output = launch(
            remote.continuation_command(PROMPT.len(), &id, name, "ses_Original123"),
            PROMPT,
        )
        .await;
        assert!(output.status.success(), "{output:?}");
        assert_eq!(output.stdout, PROMPT.as_bytes());
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
async fn initial_builder_session_survives_snapshot_cleanup_and_continues_same_session() {
    let root = tempfile::tempdir().unwrap();
    let remote = remote_fixture(root.path(), &root.path().join("unused"));
    workflow_runner(root.path(), "spec");
    fs::write(
        root.path().join(".bash_aliases"),
        r#"
export SPEC_WORKFLOW_RUNNER="$HOME/workflow-runner"
spec() {
    [[ $# == 2 && $1 == build && $SPEC_BUILD_SUPERVISED == 1 ]] || return 90
    if [[ -z $SPEC_BUILD_SESSION_ID ]]; then
        printf 'ses_InitialBuilder\n' > "$SPEC_BUILD_SESSION_FILE"
        printf 'Recommended option: continue the implementation.'
    else
        [[ $SPEC_BUILD_SESSION_ID == ses_InitialBuilder ]] || return 91
        cat -- "$2"
    fi
}
export -f spec
"#,
    )
    .unwrap();
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
            "stage",
            "status"
        ]
    );
    let session = remote.session_id(&id, "a.md").await.unwrap();
    assert_eq!(session, "ses_InitialBuilder");
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
        workflow_runner(root.path(), "fixture_engine");
        private_file(root.path().join("session-id"), "ses_Existing123\n");
        fs::write(root.path().join(".bash_aliases"), r#"
cd /
alias spec=fixture_engine
export SPEC_WORKFLOW_RUNNER="$HOME/workflow-runner"
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
export -f fixture_engine
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
        assert_eq!(observed["args"], serde_json::json!(["build", snapshot]));
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
        assert_memory_directive(text);
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
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 5);
        assert_eq!(fs::read_to_string(snapshot).unwrap(), PROMPT);
        assert_eq!(
            fs::read_to_string(root.path().join("session-id")).unwrap(),
            "ses_Existing123\n"
        );
    }
}

#[test]
fn repository_save_is_unsupervised_and_clears_inherited_session_scope_without_capture() {
    let root = tempfile::tempdir().unwrap();
    let snapshot = root.path().join("snapshot.md");
    private_file(&snapshot, "context");
    private_file(
        root.path().join("session-id"),
        "invalid saved build ID ignored by save\n",
    );
    fs::write(
        root.path().join(".bash_aliases"),
        r#"cd /
export SPEC_BUILD_SUPERVISED=1 SPEC_BUILD_INVOCATION=build
export SPEC_BUILD_SESSION_FILE=/inherited/session-id SPEC_BUILD_SESSION_ID=ses_Inherited
export OPENCODE_SESSION_ID=ses_Inherited SPEC_SESSION_DIR=/inherited KIBI_SPEC_SESSION=1
export SPEC_BUILD_STAGE=integrator SPEC_BUILD_HANDOFF_FILE=/inherited/handoff SPEC_BUILD_RESULT_FILE=/inherited/result
export OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS=0 OPENCODE_QUESTION_AUTO_RECOMMEND=0
spec() {
    [[ $# == 2 && $1 == build && $PWD == "$HOME" ]] || return 90
    [[ $SPEC_BUILD_SUPERVISED == 0 && $SPEC_BUILD_INVOCATION == repository-save ]] || return 91
    [[ ! -v SPEC_BUILD_SESSION_FILE && ! -v SPEC_BUILD_SESSION_ID && ! -v OPENCODE_SESSION_ID && ! -v SPEC_SESSION_DIR && ! -v KIBI_SPEC_SESSION ]] || return 92
    [[ $OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS == 1 && $OPENCODE_QUESTION_AUTO_RECOMMEND == 1 ]] || return 93
    [[ ! -v SPEC_BUILD_STAGE && ! -v SPEC_BUILD_HANDOFF_FILE && ! -v SPEC_BUILD_RESULT_FILE ]] || return 94
    runtime=$(type -P bun || type -P node)
    "$runtime" -e '
const fs = require("node:fs");
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
process.stdout.write(JSON.stringify({config, text:fs.readFileSync(config.instructions.at(-1), "utf8")}));
'
}
"#,
    )
    .unwrap();
    let output = std::process::Command::new("bash")
        .args(["-c", include_str!("remote-alias.bash"), "--"])
        .arg(&snapshot)
        .arg(root.path().join("ready"))
        .args(["repository-save", "exit 0"])
        .current_dir(root.path())
        .env("HOME", root.path())
        .env(
            "OPENCODE_CONFIG_CONTENT",
            r#"{"plugin":["existing-plugin"]}"#,
        )
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let observed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let config = &observed["config"];
    assert_eq!(config["plugin"], serde_json::json!(["existing-plugin"]));
    assert_eq!(config["model"], "azure/gpt-6-sol");
    let text = observed["text"].as_str().unwrap();
    assert!(text.contains("Repository-save invocation, not a spec implementation run"));
    assert!(!text.contains("SPEC_BUILD_MEMORY_V1"));
    assert_eq!(fs::read_to_string(snapshot).unwrap(), "context");
    assert_eq!(
        fs::read_to_string(root.path().join("session-id")).unwrap(),
        "invalid saved build ID ignored by save\n"
    );
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 4);
}

#[tokio::test]
async fn continuation_rejects_invalid_ids_before_creating_a_run_and_requires_spec_launcher() {
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
    fs::write(root.path().join(".bash_aliases"), "unset -f spec\nunalias spec 2>/dev/null || true\nunset SPEC_WORKFLOW_RUNNER\nopencode-source() { touch \"$HOME/injected\"; }\n").unwrap();
    let output = launch(
        remote.continuation_command(0, &Uuid::new_v4().to_string(), "a.md", "ses_Valid"),
        "",
    )
    .await;
    assert_eq!(output.status.code(), Some(125), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("Set SPEC_WORKFLOW_RUNNER"));
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

#[test]
fn build_result_contract_is_strict_and_counts_utf8_bytes() {
    let mut value = BuildResult {
        version: 1,
        stage: "builder".into(),
        report: "plan".into(),
    };
    assert!(value.validate("builder").is_ok());
    assert!(value.validate("integrator").is_err());
    value.stage = "other".into();
    assert!(value.validate("other").is_err());
    value.stage = "integrator".into();
    value.report = "\u{e9}".repeat(60 * 1024);
    assert!(value.validate("integrator").is_ok());
    value.report.push('x');
    assert!(value.validate("integrator").is_err());
    value.report = " \n\t".into();
    assert!(value.validate("integrator").is_err());
    value.report = "report".into();
    value.version = 2;
    assert!(value.validate("integrator").is_err());
    for json in [
        r#"{"version":1,"stage":"builder","report":"plan","extra":1}"#,
        r#"{"version":1,"stage":"builder","report":"plan","report":"other"}"#,
        r#"{"version":true,"stage":"builder","report":"plan"}"#,
        r#"{"version":1,"stage":"builder"}"#,
    ] {
        assert!(serde_json::from_str::<BuildResult>(json).is_err(), "{json}");
    }
}

#[tokio::test]
async fn workflow_forwards_trusted_stage_original_handoff_and_session_and_retains_result() {
    let root = tempfile::Builder::new()
        .prefix("workflow ' $; ")
        .tempdir()
        .unwrap();
    let mut remote = remote_fixture(root.path(), &root.path().join("unused"));
    std::os::unix::fs::symlink(root.path(), root.path().join("workspace-link")).unwrap();
    remote.directory = root.path().join("workspace-link").to_str().unwrap().into();
    fs::write(
        root.path().join(".bash_aliases"),
        r#"
export SPEC_WORKFLOW_RUNNER="$HOME/workflow-runner"
export SPEC_BUILD_STAGE=wrong SPEC_BUILD_HANDOFF_FILE=/wrong SPEC_BUILD_RESULT_FILE=/wrong
export SPEC_BUILD_SESSION_ID=ses_Wrong SPEC_BUILD_SESSION_FILE=/wrong
export OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS=1 OPENCODE_QUESTION_AUTO_RECOMMEND=1
cd /
spec() { touch "$HOME/legacy-launched"; return 99; }
"#,
    )
    .unwrap();
    let runner = root.path().join("workflow-runner");
    fs::write(&runner, r#"#!/bin/bash
if [[ ${1:-} == --workflow-version ]]; then printf 'spec-workflow-v1\n'; exit 0; fi
exec python3 -I -c '
import json, os, pathlib, stat, sys
env = os.environ
run = pathlib.Path(sys.argv[1]).parent
assert pathlib.Path(sys.argv[1]).read_text() == "prompt snapshot"
assert env["OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS"] == env["OPENCODE_QUESTION_AUTO_RECOMMEND"] == "0"
assert env["SPEC_BUILD_SESSION_ID"] == env["EXPECTED_SESSION"]
assert env["SPEC_BUILD_SESSION_FILE"] == str(run / "session-id")
assert env["SPEC_BUILD_RESULT_FILE"] == str(run.resolve() / "result.json")
assert not (run / "result.json").exists()
stage = env["SPEC_BUILD_STAGE"]
assert (run / "stage").read_text() == stage + "\n"
assert stat.S_IMODE((run / "stage").stat().st_mode) == 0o600
instructions = pathlib.Path(env["SPEC_BUILD_INSTRUCTIONS_FILE"]).read_text()
assert "Stage scope for this invocation: " + stage in instructions
assert "Implement only pending requirements" not in instructions
if stage == "integrator":
    handoff = pathlib.Path(env["SPEC_BUILD_HANDOFF_FILE"])
    assert handoff == run.resolve() / "handoff.json"
    assert handoff.read_bytes() == env["EXPECTED_HANDOFF"].encode()
    assert stat.S_IMODE(handoff.stat().st_mode) == 0o600
    assert json.loads(handoff.read_text())["stage"] == "builder"
else:
    assert "SPEC_BUILD_HANDOFF_FILE" not in env
    assert not (run / "handoff.json").exists()
with open(run / "result.json", "x") as result:
    json.dump(dict(version=1, stage=stage, report="concrete " + stage + " report"), result)
if not env["SPEC_BUILD_SESSION_ID"]:
    (run / "session-id").write_text("ses_FreshStage\n")
print("not the result report")
' "$1"
"#).unwrap();
    fs::set_permissions(&runner, fs::Permissions::from_mode(0o700)).unwrap();
    let original = "{\n\"version\":1,\"stage\":\"builder\",\"report\":\"original \\u00e9 approved plan\\n$()\"}";
    for (stage, session) in [
        ("builder", ""),
        ("builder", "ses_BuilderRevision"),
        ("integrator", ""),
        ("integrator", "ses_IntegratorFollowup"),
    ] {
        let id = Uuid::new_v4().to_string();
        let handoff = if stage == "integrator" { original } else { "" };
        let mut command =
            remote.workflow_command(15, &id, "a.md", session, 0, stage, handoff.len());
        command
            .env("EXPECTED_SESSION", session)
            .env("EXPECTED_HANDOFF", handoff)
            .env("SPEC_BUILD_STAGE", "inherited")
            .env("SPEC_BUILD_HANDOFF_FILE", "/inherited")
            .env("SPEC_BUILD_RESULT_FILE", "/inherited");
        let output = launch(command, &format!("prompt snapshot{handoff}")).await;
        assert!(output.status.success(), "{stage} {session}: {output:?}");
        let run = root.path().join(format!(".spec-runs/run-{id}"));
        assert!(!run.join("snapshot.md").exists());
        assert_eq!(
            run.join("invocation").exists(),
            stage == "builder" && session.is_empty()
        );
        let result = remote.build_result(&id, "a.md").await.unwrap();
        result.validate(stage).unwrap();
        assert_eq!(result.report, format!("concrete {stage} report"));
        assert_eq!(
            fs::metadata(run.join("result.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            remote.session_id(&id, "a.md").await.unwrap(),
            if session.is_empty() {
                "ses_FreshStage"
            } else {
                session
            }
        );
    }
    assert!(!root.path().join("legacy-launched").exists());
}

#[tokio::test]
async fn workflow_capability_fails_closed_without_using_legacy_runner() {
    for capability in [
        "missing",
        "exit 1",
        "printf 'old-runner\\n'",
        "printf 'spec-workflow-v1\\n\\n'",
        "printf 'spec-workflow-v1\\n'; exit 1",
    ] {
        let root = tempfile::tempdir().unwrap();
        let remote = remote_fixture(root.path(), &root.path().join("unused"));
        fs::write(
            root.path().join(".bash_aliases"),
            format!(
                "spec() {{ touch \"$HOME/provider-started\"; }}\n{}\n",
                if capability == "missing" {
                    String::new()
                } else {
                    "export SPEC_WORKFLOW_RUNNER=\"$HOME/workflow-runner\"".into()
                }
            ),
        )
        .unwrap();
        let runner = root.path().join("workflow-runner");
        fs::write(&runner, format!("#!/bin/bash\nif [[ ${{1:-}} == --workflow-version ]]; then {capability}; exit; fi\ntouch \"$HOME/provider-started\"\n")).unwrap();
        fs::set_permissions(runner, fs::Permissions::from_mode(0o700)).unwrap();
        let output = launch(remote.command(0, &Uuid::new_v4().to_string(), "a.md"), "").await;
        assert_eq!(output.status.code(), Some(125), "{capability}: {output:?}");
        assert!(!root.path().join("provider-started").exists());
    }
}

#[test]
fn workflow_never_reuses_an_existing_result_path() {
    let root = tempfile::tempdir().unwrap();
    private_file(root.path().join("snapshot.md"), "input");
    private_file(root.path().join("result.json"), "old result");
    fs::write(root.path().join(".bash_aliases"), "export SPEC_WORKFLOW_RUNNER=\"$HOME/workflow-runner\"\nfixture() { touch \"$HOME/provider-started\"; }\nexport -f fixture\n").unwrap();
    workflow_runner(root.path(), "fixture");
    let output = std::process::Command::new("bash")
        .args(["-c", include_str!("remote-alias.bash"), "--"])
        .arg(root.path().join("snapshot.md"))
        .arg(root.path().join("ready"))
        .current_dir(root.path())
        .env("HOME", root.path())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(125), "{output:?}");
    assert!(!root.path().join("provider-started").exists());
    assert_eq!(
        fs::read_to_string(root.path().join("result.json")).unwrap(),
        "old result"
    );
}

#[test]
fn legacy_python_workflows_clear_stage_environment_without_loading_aliases() {
    for mode in ["optimize", "performance"] {
        let root = tempfile::tempdir().unwrap();
        private_file(
            root.path().join("snapshot.py"),
            "import os\nassert not any(k in os.environ for k in ('SPEC_BUILD_STAGE', 'SPEC_BUILD_HANDOFF_FILE', 'SPEC_BUILD_RESULT_FILE'))\nprint('legacy')\n",
        );
        private_file(root.path().join(".bash_aliases"), "exit 99\n");
        let output = std::process::Command::new("bash")
            .args(["-c", include_str!("remote-alias.bash"), "--"])
            .arg(root.path().join("snapshot.py"))
            .arg(root.path().join("ready"))
            .arg(mode)
            .current_dir(root.path())
            .env("HOME", root.path())
            .env("SPEC_OPTIM_CONFIG", "/unused/config")
            .env("SPEC_BUILD_STAGE", "integrator")
            .env("SPEC_BUILD_HANDOFF_FILE", "/inherited/handoff")
            .env("SPEC_BUILD_RESULT_FILE", "/inherited/result")
            .output()
            .unwrap();
        assert!(output.status.success(), "{mode}: {output:?}");
        assert_eq!(output.stdout, b"legacy\n");
    }
}

#[tokio::test]
async fn workflow_validates_handoff_and_upload_order_before_runner() {
    let root = tempfile::tempdir().unwrap();
    let remote = remote_fixture(root.path(), &root.path().join("unused"));
    fs::write(
        root.path().join(".bash_aliases"),
        "touch \"$HOME/alias-sourced\"\n",
    )
    .unwrap();
    for handoff in [
        "",
        "{}",
        r#"{"version":1,"stage":"integrator","report":"wrong"}"#,
        r#"{"version":1,"stage":"builder","report":""}"#,
        r#"{"version":1,"stage":"builder","report":"plan","extra":1}"#,
        r#"{"version":1,"stage":"builder","report":"plan","report":"other"}"#,
    ] {
        let output = launch(
            remote.workflow_command(
                1,
                &Uuid::new_v4().to_string(),
                "a.md",
                "",
                0,
                "integrator",
                handoff.len(),
            ),
            &format!("x{handoff}"),
        )
        .await;
        assert_eq!(output.status.code(), Some(125), "{handoff}: {output:?}");
        assert!(!root.path().join("alias-sourced").exists());
    }
    for (stage, bytes) in [
        ("bad; touch injected", 0),
        ("builder", 1),
        ("integrator", 738305),
    ] {
        let output = launch(
            remote.workflow_command(0, &Uuid::new_v4().to_string(), "a.md", "", 0, stage, bytes),
            "",
        )
        .await;
        assert_eq!(output.status.code(), Some(125), "{output:?}");
    }
    assert!(!root.path().join("injected").exists());
    let handoff = r#"{"version":1,"stage":"builder","report":"original plan"}"#;
    let profile = r#"{"provider":"azure","model":"chosen","endpoint":"https://example.test/openai/v1","apiVersion":"2026-01-01","apiKey":"secret"}"#;
    let id = Uuid::new_v4().to_string();
    let output = launch(
        remote.workflow_command(
            1,
            &id,
            "a.md",
            "",
            profile.len(),
            "integrator",
            handoff.len(),
        ),
        &format!("x{profile}{handoff}"),
    )
    .await;
    assert_eq!(output.status.code(), Some(125), "{output:?}");
    let run = root.path().join(format!(".spec-runs/run-{id}"));
    assert_eq!(
        fs::read_to_string(run.join("handoff.json")).unwrap(),
        handoff
    );
    assert!(!run.join("execution-profile.json").exists());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("secret"));
    // A short handoff closes stdin before launch; the control stream is not data.
    let id = Uuid::new_v4().to_string();
    let mut child = remote
        .workflow_command(0, &id, "a.md", "", 0, "integrator", handoff.len() + 1)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(handoff.as_bytes())
        .await
        .unwrap();
    let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(output.status.code(), Some(125));
    assert!(
        !root
            .path()
            .join(format!(".spec-runs/run-{id}/handoff.json"))
            .exists()
    );
}

#[tokio::test]
async fn result_lookup_rejects_bad_envelopes_unsafe_storage_and_wrong_provenance() {
    for kind in [
        "valid",
        "missing",
        "empty",
        "whitespace",
        "oversized-report",
        "oversized-file",
        "bad-utf8",
        "surrogate",
        "version",
        "boolean-version",
        "unknown",
        "duplicate",
        "stage",
        "public",
        "symlink",
        "hardlink",
        "fifo",
        "directory",
        "public-run",
        "public-parent",
        "run-link",
        "parent-link",
        "missing-status",
        "failed-status",
        "status-link",
        "wrong-name",
        "wrong-run",
        "wrong-workspace",
        "wrong-mode",
        "provenance-link",
        "missing-stage",
        "stage-link",
        "wrong-stage",
    ] {
        let root = tempfile::tempdir().unwrap();
        let remote = remote_fixture(root.path(), &root.path().join("unused"));
        let id = Uuid::new_v4().to_string();
        let parent = root.path().join(".spec-runs");
        let run = parent.join(format!("run-{id}"));
        fs::create_dir_all(&run).unwrap();
        for dir in [&parent, &run] {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).unwrap();
        }
        private_file(run.join("status"), "0\n");
        private_file(run.join("stage"), "builder\n");
        private_file(
            run.join("provenance"),
            format!(
                "{}\0build\0a.md\0{}/a.md.out\0",
                root.path().display(),
                run.display()
            ),
        );
        let result = run.join("result.json");
        let valid = r#"{"version":1,"stage":"builder","report":"concrete handoff"}"#;
        private_file(&result, valid);
        let outside = root.path().join("outside");
        private_file(&outside, valid);
        match kind {
            "valid" => (),
            "missing" => fs::remove_file(&result).unwrap(),
            "empty" => private_file(&result, valid.replace("concrete handoff", "")),
            "whitespace" => private_file(&result, valid.replace("concrete handoff", " ")),
            "oversized-report" => private_file(
                &result,
                valid.replace("concrete handoff", &"x".repeat(120 * 1024 + 1)),
            ),
            "oversized-file" => private_file(&result, " ".repeat(120 * 1024 * 6 + 1025)),
            "bad-utf8" => private_file(&result, [0xff]),
            "surrogate" => private_file(&result, valid.replace("concrete handoff", r"\ud800")),
            "version" => private_file(&result, valid.replace(":1", ":2")),
            "boolean-version" => private_file(&result, valid.replace(":1", ":true")),
            "unknown" => private_file(&result, valid.replace("}", ",\"unknown\":1}")),
            "duplicate" => private_file(&result, valid.replace("}", ",\"report\":\"other\"}")),
            "stage" => private_file(&result, valid.replace("builder", "integrator")),
            "public" => fs::set_permissions(&result, fs::Permissions::from_mode(0o644)).unwrap(),
            "public-run" | "public-parent" => fs::set_permissions(
                if kind == "public-run" { &run } else { &parent },
                fs::Permissions::from_mode(0o755),
            )
            .unwrap(),
            "run-link" | "parent-link" => {
                let path = if kind == "run-link" { &run } else { &parent };
                fs::rename(path, root.path().join("elsewhere")).unwrap();
                std::os::unix::fs::symlink(root.path().join("elsewhere"), path).unwrap();
            }
            "missing-status" => fs::remove_file(run.join("status")).unwrap(),
            "failed-status" => private_file(run.join("status"), "1\n"),
            "missing-stage" => fs::remove_file(run.join("stage")).unwrap(),
            "wrong-stage" => private_file(run.join("stage"), "integrator\n"),
            "wrong-name" | "wrong-run" | "wrong-workspace" | "wrong-mode" => {
                let original = fs::read_to_string(run.join("provenance")).unwrap();
                private_file(
                    run.join("provenance"),
                    match kind {
                        "wrong-name" => original.replace("a.md", "b.md"),
                        "wrong-run" => original.replace(&id, &Uuid::new_v4().to_string()),
                        "wrong-mode" => original.replace("build", "repository-save"),
                        _ => original.replace(root.path().to_str().unwrap(), "/wrong"),
                    },
                );
            }
            _ => {
                let path = match kind {
                    "status-link" => run.join("status"),
                    "stage-link" => run.join("stage"),
                    "provenance-link" => run.join("provenance"),
                    _ => result,
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
        let response = remote.build_result(&id, "a.md").await;
        if kind == "valid" {
            assert_eq!(response.unwrap().report, "concrete handoff");
            assert!(remote.build_result("../outside", "a.md").await.is_err());
            assert!(remote.build_result(&id, "../a.md").await.is_err());
            private_file(
                run.join("result.json"),
                valid.replace("concrete handoff", &r"\u0000".repeat(120 * 1024)),
            );
            assert_eq!(
                remote.build_result(&id, "a.md").await.unwrap().report.len(),
                120 * 1024
            );
        } else {
            assert!(response.is_err(), "{kind}");
        }
        // The retained API uses the same result contract, not the log transcript.
        // It may still show a failed run's log, but never that run's result.
        private_file(run.join("a.md.out"), "not a structured report");
        let retained = remote
            .retained::<serde_json::Value>("a.md", Some(&id), false)
            .await;
        match kind {
            "valid" => {
                let retained = retained.unwrap();
                assert_eq!(retained["stage"], "builder");
                assert_eq!(retained["report"].as_str().unwrap().len(), 120 * 1024);
                assert_eq!(retained["approvable"], false);
            }
            "failed-status" => {
                let retained = retained.unwrap();
                assert_eq!(retained["stage"], "builder");
                assert!(retained.get("report").is_none());
                assert_eq!(retained["approvable"], false);
            }
            _ => assert!(retained.is_err(), "retained {kind}"),
        }
        assert_eq!(fs::read_to_string(outside).unwrap(), valid);
    }
}

#[tokio::test]
async fn retained_stage_reports_are_independent_of_capped_logs_and_never_approvable() {
    let root = tempfile::tempdir().unwrap();
    let remote = remote_fixture(root.path(), &root.path().join("unused"));
    for (stage, mode) in [("builder", "build"), ("integrator", "continue")] {
        let id = Uuid::new_v4().to_string();
        let run = root.path().join(format!(".spec-runs/run-{id}"));
        fs::create_dir_all(&run).unwrap();
        for directory in [run.parent().unwrap(), run.as_path()] {
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
        }
        private_file(run.join("status"), "0\n");
        private_file(run.join("stage"), format!("{stage}\n"));
        private_file(
            run.join("provenance"),
            format!(
                "{}\0{mode}\0a.md\0{}/a.md.out\0",
                root.path().display(),
                run.display()
            ),
        );
        // Both fields require worst-case JSON escaping, exceeding the old tail
        // transport bound. Result size is measured in UTF-8, not encoded JSON.
        private_file(run.join("a.md.out"), vec![0; 262145]);
        let report = "\0".repeat(120 * 1024);
        private_file(
            run.join("result.json"),
            serde_json::to_vec(&serde_json::json!({"version":1,"stage":stage,"report":report}))
                .unwrap(),
        );
        for full in [false, true] {
            let retained = remote
                .retained::<serde_json::Value>("a.md", Some(&id), full)
                .await
                .unwrap();
            assert_eq!(retained["stage"], stage);
            assert_eq!(retained["report"], report);
            assert_eq!(
                retained["output"].as_str().unwrap().len(),
                if full { 262145 } else { 262144 }
            );
            assert_eq!(retained["truncated"], !full);
            for field in ["approvable", "recoverable", "continuable"] {
                assert_eq!(retained[field], false, "{field}");
            }
        }
        // No failed or unresolved run can publish a result, even if one is present.
        fs::remove_file(run.join("result.json")).unwrap();
        std::os::unix::fs::symlink("/must-not-read", run.join("result.json")).unwrap();
        for status in [Some("1\n"), Some("130\n"), None] {
            if let Some(status) = status {
                private_file(run.join("status"), status);
            } else {
                fs::remove_file(run.join("status")).unwrap();
                private_file(run.join("lease"), "");
            }
            let retained = remote
                .retained::<serde_json::Value>("a.md", Some(&id), false)
                .await
                .unwrap();
            assert_eq!(retained["stage"], stage);
            assert!(retained.get("report").is_none());
            assert_eq!(retained["approvable"], false);
        }
    }
}

#[tokio::test]
async fn result_lookup_bounds_and_validates_transport_responses() {
    let root = tempfile::tempdir().unwrap();
    let remote = remote_fixture(root.path(), &root.path().join("unused"));
    for script in [
        "exit 0",
        "printf '{}'",
        "head -c 800000 /dev/zero",
        "head -c 5000 /dev/zero >&2",
        "printf '{\"version\":1,\"stage\":\"builder\",\"report\":\"x\"}'; exit 255",
        "printf '{\"version\":1,\"stage\":\"unknown\",\"report\":\"x\"}'",
    ] {
        fs::write(&remote.binary, format!("#!/bin/bash\n{script}\n")).unwrap();
        assert!(
            tokio::time::timeout(
                Duration::from_secs(3),
                remote.build_result(&Uuid::new_v4().to_string(), "a.md")
            )
            .await
            .unwrap()
            .is_err(),
            "{script}"
        );
    }
}
