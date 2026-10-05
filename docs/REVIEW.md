# Code review: original `spec` workflow and web rewrite

Review date: 2026-10-05. Scope: the active shell function/executable, customized editor save/history/output paths, build dispatch, and the persistent-session integration contract. This is a focused review, not a complete security audit of Kibi, OpenCode, providers, telemetry, or the host machine.

## Source identification

`bash -ic 'type spec'` resolves to a shell function. `command -v spec` in the noninteractive environment resolves to a symlink targeting `nextweb/tools/eval/spec`. Ordinary executable invocations source the machine's shell aliases and dispatch to the function.

The function launches a customized Rust Kibi editor installed under `.local/share/specific/editor/`; its source is `/home/opencode/final_spec/specific`, remote **https://github.com/AI10xDev/specific**. The base revision is `71e44a4f19fbbe09c307e5e4915d3c22e9cbe094`. There are uncommitted editor changes, which are captured in the archive rather than silently replaced with the remote revision.

The active persistent runner and workflow dispatch are in the separate OpenCode checkout. Actual working-tree snapshots, base revisions, and SHA-256 digests are in [`archive/manifest.json`](../archive/manifest.json). Neither original working tree nor the installed shell configuration was edited.

## Findings (original implementation)

Paths below refer to the read-only `archive/` snapshot so line references remain stable.

### 1. High: saving truncates the only copy before the write succeeds

**Location:** `archive/specific/editor/src/editor.rs:937–947`, `Editor::save`.

`File::create(file_name)` truncates an existing file immediately. Writing the rows and `sync_all()` happens afterward. A disk-full error, I/O failure, or process crash after truncation can leave a partial/empty original file even when the UI reports a save failure. Syncing the already-truncated destination does not make the operation atomic.

**Recommendation:** create a private temporary file in the destination directory, write and sync the entire content, atomically rename it into place, then sync the directory. Add failure-injection coverage for unsuccessful writes.

**Rewrite:** implements temporary-file replacement and directory sync. Existing-file revision checks also reject stale browser saves. This does not provide a backup/version archive and is not a distributed filesystem transaction.

### 2. High: mirror names collide across source directories

**Location:** `archive/specific/editor/src/editor.rs:311–315` and `417–423`, `mirror_path` / `save_mirror`.

The mirror destination is `copy_dir.join(source.file_name())`. Therefore `/project-a/spec.md` and `/project-b/spec.md` both write `$HOME/specs/spec.md`. Saving the second silently replaces the first mirror; the only guard is against copying a file onto itself. The successful original save and canonical history entry do not preserve both mirror copies.

**Reproduction condition:** save two different source files with the same basename while `KIBI_SAVE_COPY_DIR` selects the same mirror directory.

**Recommendation:** namespace mirrors by project/relative path, use collision-resistant identifiers, or explicitly reject collisions. Do not advertise a basename mirror as a complete backup.

**Rewrite:** does not mirror. It writes one explicitly named workspace file; new-file revision checks reject replacing a file the browser has not loaded.

### 3. Medium: output-log opens follow symlinks and do not enforce existing-file privacy

**Location:** `archive/specific/editor/src/output.rs:93–102`, `Output::start`.

`OpenOptions::append(true).create(true).mode(0o600)` follows a symlink at the log path. The mode applies only to a newly created file, not an existing broader-permission log. If another actor can control that output path, output can be appended to an unintended writable file, or sensitive output can be written to a previously world-readable file. This requires filesystem/path control; it is not a demonstrated remote privilege escalation.

**Recommendation:** reject symlinks, verify the opened descriptor is an owned regular file, enforce private permissions where appropriate, and avoid creation in an untrusted directory.

**Rewrite:** output is bounded in memory, not opened through user-selected log paths. Editor reads use `O_NOFOLLOW | O_NONBLOCK` and descriptor type checks. Workspace trust remains required.

### 4. Medium: prompt text is supplied without an end-of-options separator

**Location:** `archive/specific/bin/specific-run-build:76`; the same pattern appears in `archive/opencode/script/run-spec.sh:30`.

The entire spec becomes a positional argument after `--agent build`, without `--`. A document beginning with CLI syntax such as `--help` or `--model=…` can be interpreted as flags by an option-parsing CLI rather than literal prompt text. Quoting prevents shell splitting; it does not terminate option parsing. Large documents can also exceed process argument-size limits.

**Recommendation:** use a documented stdin/file-input interface, or at minimum insert `--` and enforce a supported argument-size bound. Check parser behavior against each supported CLI release.

**Current adapter:** invokes an explicitly configured `SPEC_COMMAND` launcher with `build` and a private saved-snapshot path. The backend never interpolates content into shell code. The existing launcher forwards the prompt as one argument after `--`, so builds are capped at 120 KiB and trailing newlines are stripped by Bash command substitution. See the execution contract in the README.

### 5. Medium: line-delimited history cannot represent every allowed Unix path

**Location:** `archive/specific/editor/src/editor.rs:301–308`; `archive/specific/shell/specific.sh` history reader; `archive/shell/spec.bash` latest-entry lookup.

Canonical paths are appended as one unescaped line. Unix filenames may contain newlines, so a single save can produce multiple apparent history records. A subsequent latest-file build can select the wrong path or fail. The history also appends repeatedly without deduplication or a retention bound.

**Recommendation:** use a structured format with escaped paths and bounded retention, or forbid control characters consistently in both save and restore paths.

**Rewrite:** file discovery uses actual directory entries; control characters and directory separators are rejected in filenames. The UI lists each visible workspace file once.

### 6. Operational risk: original runner is not a new approval boundary

**Location:** `archive/opencode/script/spec-session.md:61–69`.

The original integration explicitly documents that the selected local OpenCode CLI enables automatic permission approval/question recommendations. A protected local server and durable prompt admission do not imply a user must approve each tool action. Reusing this behavior behind a browser UI without warnings would create a misleading safety expectation.

**Recommendation:** make execution an explicit opt-in, disclose the inherited policy, and enforce permissions/sandboxing in the execution engine or OS rather than in presentation code.

**Current adapter:** disabled by default, trusted launcher path selected at server startup, confirmation before every UI run, and no shell interpolation by the backend. `SPEC_BUILD_AUTO=1` selects the existing launcher’s foreground build branch, which explicitly adds `--auto`. UI and startup warnings disclose automatic approval. The rewrite is not a sandbox.

## Positive observations

- The original save path distinguishes a primary save failure from later mirror/history failures rather than pretending nothing was written.
- The original persistent runner uses private inbox files, stable message identifiers, explicit durable admission, and a permanent runner claim to avoid accidental replay. The runner contract clearly distinguishes admitted inputs from completed model execution.
- The editor's filename scanner skips symlinks and bounds traversal by entries, depth, and time.
- Existing workflow tests cover many operational boundaries. Passing tests do not negate gaps outside their assertions, such as basename collisions or write interruption.

## Changes and constraints in the rewrite

New application code is separate under `backend/` and `frontend/`; archived source is not imported or executed. Rust owns HTTP, authentication, file I/O, concurrency limits, child processes, and bounded output. Vite TypeScript owns the browser interface and tab state.

Design tradeoffs:

- Single-user, loopback-only service; no multi-user/cloud claims.
- Flat trusted workspace, not arbitrary host filesystem access.
- Atomic saves and stale-edit detection; no transactional protection against a malicious same-user process changing paths concurrently.
- One-shot process execution; no claim to reproduce persistent V2 session admission, steering, replay, or crash recovery.
- Browser output is plain text; no hidden chain-of-thought request or HTML execution.
- Logs and run associations are not durable; saved files are durable.
- New files are mode `0600`; replacing an existing file also changes its permissions to `0600` and replaces its inode. Do not use this editor to maintain executables or files whose ACLs/hard-link identity must be retained.

## Validation

Executed on the development machine:

| Check | Result |
| --- | --- |
| Original editor: `cargo test save_` | 2 passed; other tests filtered |
| Original OpenCode: selected run-spec/session/workflow tests | 49 passed, 1 skipped, 0 failed |
| New Rust backend: `cargo test --locked` | 11 passed |
| New Rust: `cargo clippy --all-targets -- -D warnings` | Passed |
| New Rust: `cargo fmt --check`, build | Passed |
| Frontend: `bun typecheck` | Passed |
| Frontend: `bun run test` | 5 passed |
| Frontend: `bun run build` | Passed |
| Browser: `bun run test:e2e` | 7 passed against isolated real Rust servers |

Backend coverage includes authentication on every API route, encoded traversal, symlinks/FIFOs, filename/content limits, durable file reload/listing, stale-write rejection, default execution denial, bounded logs, and deterministic child-process tests for streaming/cancellation, build-size boundaries, launcher arguments, immutable snapshots, private permissions, cleanup, and exit status. The process fixtures make no provider calls.

Browser coverage includes saved-file discovery, independent buffers, preserving edits when reopening an already-open file, close confirmation, desktop two-pane geometry, reload persistence, mobile overflow, default disabled execution, and conflicts between two browser pages.

No live model execution, full original-editor regression suite, cloud deployment, Windows behavior, power-loss simulation, exhaustive security audit, or external CLI/provider compatibility matrix was tested.
