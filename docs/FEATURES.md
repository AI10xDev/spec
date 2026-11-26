# Vite version: feature guide

This guide covers the core workspace. See the [technical reference](../REFERENCE.md#features) for the complete current feature list, including [optimization](../REFERENCE.md#optimization), [repository saving](../REFERENCE.md#save-edited-repository-changes), and [session chat, context inspection, and voice](../REFERENCE.md#session-chat).

## 1. Connect to your local workspace

Start the Rust server and open its printed URL. The fragment supplies a per-process access token; the UI removes the fragment from the address bar and stores the token in the current tab's session storage. You can also paste the token into the connection form. Restarting Rust rotates the token: use its new URL.

The editor's files are on the server machine, not uploaded to an application cloud. If you enable OpenCode, that external tool may send prompts and tool context to its configured provider. Optional trailing completions send recent editor text, including unsaved text, to the selected provider.

## 2. Saved files tab — previously written files

The **Saved files** navigation tab lists visible regular files from the workspace directory:

- Newest filesystem modification first; filename breaks ties.
- Filename, last modification time, and byte count.
- Case-insensitive filename filtering.
- Refresh button for changes made by other programs.
- Clicking a file opens it in an editor tab, or selects its existing tab without replacing unsaved edits.

Every successful save writes a real file. The list therefore survives page reloads and server restarts without a browser database. Existing files in the configured directory are also shown. Point `SPEC_WORKSPACE` at `$HOME/specs` to use the original command's mirror directory, or copy selected files into a separate workspace yourself.

**“History” means a list of previously written files, not version history.** There is no undo across server restarts, revision archive, deleted-file recovery, recursive project explorer, or automatic import of the legacy newline-delimited history. Directory listing is capped at 10,000 entries; use a smaller workspace for predictable complete listing.

## 3. Multiple open editor tabs

Use the **New file** input to create a named buffer, or select a saved file. Each file has one independent buffer per browser page. The horizontal editor tab strip can scroll when many files are open. The **Open tabs** navigation tab provides another searchable list of open buffers.

- Selecting another tab preserves edits to the first file.
- A dot and **Unsaved** badge identify changed/new buffers.
- Closing a dirty tab asks for confirmation.
- Browser navigation/reload prompts when dirty buffers remain, where browser policy permits.
- Opening a file already in a tab does not silently reload it from disk.
- Edits typed while a save is in flight remain in the buffer and remain dirty if different from the acknowledged snapshot.

Open-tab layout and unsaved buffers are intentionally **not persisted in browser storage**. Reloading reopens only the last selected saved file if it still exists. Save or download before leaving. Closing a tab does not cancel its running process; reopen the saved file to recover its latest output, including after browser or server restart.

## 4. Two-pane editor and output view

On desktop, **Spec** occupies the left pane and **Output & logs** the right. Both remain visible while switching editor tabs. On narrow screens they stack vertically to keep each readable.

The spec editor is a plain UTF-8 textarea with spellcheck disabled. It supports native text selection, clipboard operations, and browser textarea undo. It is not Monaco, an IDE, a terminal emulator, or a syntax-aware language server.

Press `/` to toggle the current line's leading `# ` completion marker, preserving indentation, caret, and native undo. Alt+/ types a literal slash; slash input inside fenced code and IME composition remains native. Supplemental build instructions tell the agent to retain marked lines as context and implement only pending lines. Completion applies to that line only, not the following section. Headings (`##`), inline hashes, and hashes inside code blocks are not completion markers.

With a [completion provider configured](../REFERENCE.md#trailing-sentence-part-completions), **Trailing completions** offers muted ghost text after 500 ms idle at a line's end. It completes the current word or sentence part, stopping at the first clause/sentence boundary, up to 160 characters. Press **Tab** or click **Accept part** to insert it; press **Escape** to dismiss until the next edit. Acceptance also waits for the next edit before suggesting another part, even without final punctuation. The toggle disables provider requests across editor tabs; editing works without any provider configuration.

Suggestions never modify saved/downloaded text until accepted. Selection, composition, blur, and tab switches clear them; stale requests cannot replace a newer suggestion. Existing text after the caret on the same line suppresses completion. The ghost stays on one visual line, clipped to the pane; its full suffix is in the Accept part tooltip. Native undo includes accepted text in supported browsers; browsers without `insertText` support use a direct insertion fallback. Provider errors appear beside the toggle, without blocking saves or launching a build.

The output pane is associated with the active filename and recovers its latest saved run when the file is opened. **Load nohup output** explicitly reads the latest run's remote `.spec-runs/run-<id>/<spec filename>.out` file, even when the run is still attached or its completed output is cached. This is the spec-named replacement for shared `nohup.out`; the button uses SSH and never reruns the build or changes the editor buffer. It reports missing runs or read failures and keeps the current output on failure. Only webapp-managed runs with a saved association are loaded, not arbitrary shell jobs. Automatic startup recovery still uses cached completed output when SSH is disabled. Available stdout and stderr appear as plain text, not executable HTML or interpreted terminal escape sequences. Available tool logs and concise explanations can be shown; hidden model reasoning is not requested. The run adapter does not pass `--thinking`.

## 5. Save, conflicts, and download

Click **Save** or press **Ctrl+S / Cmd+S** while focused in the editor. The Rust API writes a temporary file, syncs it, atomically replaces the destination, and syncs the workspace directory. Files written by the app have mode `0600`.

Changed text in the active sheet also autosaves after a 500 ms debounce while the browser window is focused. Background sheets and untouched new files are not automatically written. Saves are serialized, preserve newer edits, and pause after a write error or revision conflict until an explicit Save retry.

Each loaded file has a SHA-256 content revision. The browser supplies its last acknowledged revision on save. If the file has changed since then, the API returns `409 Conflict` and keeps the browser's unsaved buffer intact.

To resolve a conflict:

1. **Download** your current buffer if you want to preserve it separately.
2. Close that editor tab and confirm discarding its unsaved copy.
3. Refresh **Saved files**, reopen the file, and merge the changes manually.

Creating an existing filename opens it rather than overwriting it. New empty files are considered unsaved until saved. Download creates a browser download of the current buffer; it does not mark the server file saved.

Limits: 2 MiB per UTF-8 file; no NUL bytes; filenames up to 180 UTF-8 bytes; no hidden names, slashes, backslashes, colons, control characters, or leading/trailing whitespace. Paths are intentionally flat. The app has no delete/rename API.

## 6. Save & run

With `SPEC_SSH_TARGET` and `SPEC_SSH_WORKSPACE` set on the **local** Rust server, **Save & run** becomes available. The web backend stays local; only builds run remotely:

1. A confirmation warns about tools, filesystem changes, provider costs, and inherited permissions.
2. The current buffer is saved.
3. The local server checks the saved revision and uploads an immutable snapshot over SSH. A fixed remote supervisor writes a private temporary snapshot and sources trusted remote `~/.bash_aliases`. It requires an absolute executable `SPEC_WORKFLOW_RUNNER`, probes `--workflow-version` for exactly `spec-workflow-v1` plus a newline and exit 0, then invokes that same runner directly with the snapshot path. There is no generic `spec build` fallback. Builds are limited to 120 KiB (local saving still supports 2 MiB). Other local files are not synced, and build changes remain remote.
4. The **Builder** explores/plans, may edit preliminary unit/smoke tests and run experiments, and reports a handoff. It is not read-only, but must not implement end-to-end. The right pane follows runtime output; disable **Follow output** to keep your scroll position.
5. **Stop run** sends an explicit control byte to request remote process-group cancellation and snapshot cleanup. EOF or SSH disconnect only detaches the log viewer.

The runner must come from the separately installed external **AI10x/opencode-fork**
checkout (`main` commit `e60a017d878486eb6b143e55cb9b9f320091d46d` or equivalent),
with its dependencies and rebuilt compatible engine. The Spec web server is not
that runner and does not deploy it. See [host setup](INSTALLATION.md#install-the-external-runner).
Interactive `.bashrc` and login profiles are not loaded; export the absolute runner
path in trusted `~/.bash_aliases`, outside interactive-shell guards.

Both stages require executing model `azure/gpt-6-astra` on the host; selected
execution profiles are rejected. Sol (`azure/gpt-6-sol`) is optional read-only,
nonblocking advice, never an approval gate. The adapter keeps
`SPEC_BUILD_FOREGROUND=1 SPEC_BUILD_AUTO=1` with `SPEC_BUILD_SUPERVISED=1`, but sets
`OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS=0 OPENCODE_QUESTION_AUTO_RECOMMEND=0`.
Read/edit are allowed; `task`, `external_directory`, `glob` and `grep` are denied.
Other permitted tools receive automatic per-request `once` approval by the runner,
not global `always` grants. Questions are not autoanswered, even recommended
options; the agent must report questions/options/blockers for later user feedback.
Host policy lists are advisory and do not sandbox tool or shell effects.

A failure to launch the local SSH client is reported immediately. SSH
connection/authentication and remote startup errors appear in output. An SSH
attachment exit 255 leaves completion unconfirmed; it is not proof of remote
failure. A staged run needs both successful remote status and a validated separate
result to complete. Neither verifies that generated software is correct. The
temporary snapshot is removed after process cleanup, while the original snapshot
remains in private local run records for approval and recovery.

### Reports, Approval And Feedback

The **Builder report** or **Integrator report** appears separately from runtime
logs. It is read from private `result.json`, checked for valid envelope, stage,
provenance and successful status, and persisted independently of the truncated log
tail. Reports are at most 120 KiB UTF-8 and come from the executing actor, not Sol.
Validation does not verify implementation or report claims. Read the report and
inspect actual remote diffs/checks before proceeding. The task bar counts only
the current executing stage's reported todos; Sol's checklist is separate advice
and does not change execution progress or establish correctness.

Use **Send & revise builder** or **Use recommended & revise builder** to revise a
successful Builder in the same session. Only explicit **Approve & implement**
posts `{}` to authenticated `POST /api/runs/{id}/approve` and starts a **fresh
Integrator session** for further exploration and end-to-end implementation.
Approval requires the latest successful Builder, a durable validated report and
matching remote configuration. The server also rejects approval if the saved spec
content differs from the original snapshot or that Builder has a pending saved-build
queue entry. This is not just a browser guard. The UI additionally blocks approval
for unsaved changes and feedback drafts; approval never sends those drafts/edits.
Run a new Builder for changed requirements and resolve queued revisions first.

Integrator receives the original snapshot and approved Builder handoff. **Send &
continue** or **Use recommended & continue** resumes that Integrator within the
same stage/session and approved scope, always with the original approved handoff.
The handoff is context, not new permissions. Stage, original snapshot, validated
result and approved handoff persist in private local `.spec-output/` records.
Legacy runs without staged metadata need a new Builder; old logs cannot substitute
for a validated report or explicit approval.

Feedback accepts Enter to submit and Shift+Enter for a newline. During an active
run, **Queue follow-up** holds one browser-memory message for same-stage/session
delivery after confirmed success. Keep the page open; this is not live stdin.
Failure, Stop, replacement or ambiguous delivery pauses it, not a blind retry.
Saving, editing, recommended-choice feedback and both queue types **never
autoapprove integration**. See [staged workflows](WORKFLOWS.md#choose-the-right-action).

### Queue saved editor follow-ups

During an active supported build, **Save & run** (or **Ctrl+Enter / Cmd+Enter**) offers to save and queue the current editor snapshot instead of starting overlapping work. Ordinary Save and autosave still never schedule execution.

- The backend captures the acknowledged saved revision, not a later editor buffer. Later edits and autosaves do not replace queued instructions or get overwritten when the queue dispatches.
- One snapshot may be queued per parent run. The **Saved build queue** shows its filename, revision, and waiting, started, or paused state. Cancel the entry before replacing it.
- Snapshots persist in private local `.spec-output/` storage. Execution does not require the browser to stay open; restarting the backend resumes waiting entries with the same remote configuration.
- A fresh **Builder** starts only after authoritative successful parent completion, attachment cleanup, and conflicting runs have resolved. It does not start an Integrator, even if queued from one. Unknown remote status waits; failed or stopped parents pause the entry. A changed latest-run association or remote configuration also prevents dispatch.
- **Cancel queued build** removes waiting work; dismissing an already-started entry does not stop its child. Use **Stop run** for a dispatched build. Stop on the parent revokes its queued work even if final success races the cancellation.
- An uncertain launch is never automatically resubmitted. Inspect the recorded child output before scheduling another build. The queue holds up to 32 entries, with a maximum 120 KiB per snapshot; dismiss old entries to release space.

This differs from the feedback queue: feedback continues the same stage/session
and remains page-local. Saved editor follow-ups start fresh Builders using the
preserved snapshot, including completion markers. Neither queue grants approval;
a pending saved-build queue entry for a Builder also blocks server-side approval.

API: `GET /api/queued-builds` lists queue metadata; `POST /api/runs/{id}/queued-build` accepts `{name, revision}`; `DELETE /api/runs/{id}/queued-build` removes that parent's entry without cancelling an already-started child. All require the existing server token.

### Run limits and lifecycle

Builds (including continuations), repository saves, and [optimization](../REFERENCE.md#output-and-safety) have no overall supervisor runtime limit or UI attachment deadline. Ordinary builds and repository saves cap agent output; optimization output remains uncapped and has separate retention rules.

The inner staged runner still enforces host-policy `runTimeoutMs` and any numeric
`maxTokens` budget for the executing actor's reported usage per sweep, excluding
Sol. `reviewTimeoutMs` only bounds optional advice. Outer keep-alives do not disable
these limits, and reported-token budgets are not hard provider billing caps.

- At most one unresolved run per filename and 16 in total, including recovered or detached sessions whose completion is unconfirmed. Admission errors distinguish a blocked filename from the total run limit.
- Latest 256 KiB of output per retained run. Recovery reads a bounded latest-256-KiB tail for all modes. Truncation is explicitly indicated.
- At most 32 runs retained in memory; finished entries can be evicted but durable records remain on disk without automatic pruning.
- Polling approximately every 650 ms for recoverable file runs, including background tabs, and independently for optimization; slower retry on fetch errors or unavailable/unknown recovered sessions.
- Every 60 seconds while the child remains alive, the supervisor appends a message such as `[remote] keep-alive: build still running (60s elapsed); no execution timeout.` The mode is `build`, `repository-save`, or `optimize`, and elapsed seconds increase. This indicates process liveness, not model progress.
- Normal process exit and explicit cancellation still end runs. The 10-second startup-readiness check, cleanup safety timers, SSH network keepalives, and individual provider/tool timeouts are unchanged. Network loss may prevent Stop confirmation. Exit code `124` can still indicate a child timeout or an older supervisor's watchdog timeout.
- Ctrl+C/SIGTERM detaches on normal server shutdown; uploaded builds continue remotely.
- Closing a browser page does not stop execution.
- Run records and file associations persist in private local `.spec-output/` storage. Reopen a saved spec after restarting to recover output without another build; use the new server token when reconnecting. Unfinished sessions require the same remote configuration; finished cached output needs no SSH. Remote sessions retain private `<spec filename>.out` (spec-named instead of shared `nohup.out`) and atomic exit `status` under `.spec-runs/`. Ordinary builds and repository saves retain the first 8 MiB of agent stdout/stderr and drain/discard excess agent output. Supervisor keep-alives bypass this cap, so the total log can exceed 8 MiB and slowly grows while the process remains alive. Legacy `output.log` sessions remain recoverable. Completed ordinary remote sessions older than seven days are pruned on subsequent launches; optimization reports are exempt. See [recovery and cancellation](../REFERENCE.md#sessions-and-cancellation). Interactive replay and session steering are not implemented.
- Tools that detach into separate process groups may escape group cancellation. Use OS-level sandboxing for stronger containment.

The Rust backend embeds the supervisor and sends it over SSH. To deploy this behavior, rebuild and restart the actual SSH-launching backend, not just the execution VM. Already-running supervisors retain their original behavior, including older watchdog deadlines.

The external engine/runner, provider configuration and runtime `~/projects/Agent.md`
require separate explicit host-owner installation. The repo's [Agent.md](../Agent.md)
is only a versioned snapshot; editor changes do not deploy it. No live host
deployment or provider validation was performed for this documentation update.

## 7. What changed from the original

| Original capability | Web rewrite |
| --- | --- |
| Terminal Kibi editor | Browser-based TypeScript textarea editor |
| One visible spec at a time | Multiple independent editor tabs |
| Newline-delimited save history | Workspace file listing with filtering and timestamps |
| Spec/output split | Desktop two-pane view; stacked mobile view |
| Background shell build | Staged remote runner under a detached SSH supervisor: Builder, explicit approval, fresh Integrator; capped logs plus separate reports, cancellation, host-policy execution limits |
| Basename mirror saves | No mirroring; saves only the named workspace file |
| Persistent V2 session inbox | Not ported; explicit [continuation of completed builds](../REFERENCE.md#continue-a-completed-build) resumes the captured session in the same stage, never approves integration |
| Azure inline completion/filename ranking | Optional sentence-part trailing completions; filename ranking not ported |
| `/eval`, `/telle`, legacy eval, plan picker | Not ported |
| Terminal keybindings/syntax highlighting | Browser editing, save/run shortcuts, slash completion-marker toggle, and display-only source highlighting |

## 8. Safety and privacy

Only the server owner should have the token. This is a single-user local application, not a hosted multi-user service. Do not expose it through a public reverse proxy or shared tunnel. Keep the workspace trusted and back up important files. Running a model is a separate, explicitly enabled operation with the chosen CLI's existing privileges and policy. See [SECURITY.md](SECURITY.md).
