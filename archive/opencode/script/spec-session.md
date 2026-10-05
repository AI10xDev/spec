# Interactive Spec Sessions

`run-spec.sh <spec-file>` remains one-shot unless `SPEC_SESSION_DIR` is nonempty.
Only the interactive editor should set it. Auto/standalone callers must leave it
unset. The local `~/.bash_aliases` enables `KIBI_SPEC_SESSION=1` only when its
`spec` editor uses this launcher. The editor at
`/home/opencode/final_spec/specific/editor` creates a private inbox under
`${XDG_STATE_HOME:-$HOME/.local/state}/spec/sessions` on the first Ctrl+R and
publishes subsequent successful saves to it without relaunching. Custom
launchers and standalone `spec build` remain one-shot. The local `spec` function
also enables `KIBI_SPEC_RESUME=1`: bare `spec` opens the last saved file, while
`spec path/to/file` selects that file. The editor restores the latest recorded
session for the selected file, replays its output log, and follows the existing
runner. Opening the editor does not submit a prompt or launch another runner.
Close the previous editor before reopening the same session; an exclusive editor
lock prevents two windows from publishing to one inbox.

Restoration also displays output from stopped sessions, but never restarts their
runner or retries provider work. To explicitly start fresh, use
`KIBI_SPEC_RESUME=0 spec path/to/file`, then Ctrl+R. Sessions without editor
restore metadata are not automatically guessed or adopted.

## Editor Contract

1. Create a unique, user-owned **0700** directory per editor under a trusted parent
   (`mktemp -d` is suitable). Do not use a symlink or share it with another editor.
2. Before launching, write the initial prompt as UTF-8 JSON `{"text":"saved spec"}`
   into a **0600** temporary file inside that directory. Flush and close it, then
   atomically rename it to `00000001.json`. Use fsync on the file before rename and
   the directory after rename if durability across machine failure is required.
3. Launch `SPEC_SESSION_DIR=/absolute/inbox/path /checkout/script/run-spec.sh spec.md`
   from the target project directory. The spec path must still exist but its
   contents are NOT submitted in this mode. The inbox is the only prompt source.
4. Each Ctrl+R saves the spec and publishes another complete `{text: string}` file
   the same way. Text is submitted verbatim; include any update instructions in
   that text. Never modify a published file or reuse a filename. Temporary names
   must NOT end in `.json`. Zero-padded increasing names give ordering; random
   unique names work but sort lexically, not by creation time. Each poll processes
   the currently visible names in lexical order. Files are limited to 8 MiB;
   nonempty text and private, owned regular files are required.
5. Do NOT relaunch on subsequent Ctrl+R. The same process, server and build-agent
   session remain available both during execution and after idle.

The launcher uses `setsid --wait`, disconnects stdin, and the runner ignores
SIGHUP. It does not background itself: launch once as a background child with
stdout/stderr redirected to the editor's regular log file, opened privately in
append mode. Do not leave output attached to a pipe the editor will close.
`run-spec.sh` stays running until shutdown and returns the runner's exit status.

## Admission And Logging

The runner owns a password-protected, loopback-only `opencode-source serve`
process with mDNS disabled, and creates one V2 session with `agent: "build"` and
the caller's project directory. It calls `/api/session/:id/prompt` sequentially,
waiting for **durable admission, not model completion**, with `delivery: "steer"`.
The existing session runner incorporates busy updates at a safe provider-turn
boundary. No abort, restart, wait-for-idle gating, synthetic continuation, or
autonomous task generation is added. Model selection uses `SPEC_MODEL=provider/model`,
then the configured build-agent model, then the configured default, then the most
recent available model saved by the CLI. The selected model is printed and pinned
to the session. Missing or unavailable selections fail before consuming the inbox;
the runner does not silently switch to a free provider. Permissions are inherited.
**This does not imply manual approval:** the existing
CLI entrypoint (`packages/opencode/src/index.ts`) unconditionally sets
`OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS=1` and `OPENCODE_QUESTION_AUTO_RECOMMEND=1`.
The server inherits that existing auto-approval/auto-recommendation policy. This
runner does not change or override it. Any requests that remain outstanding are
logged and may require a separate API client to answer. Do not treat this runner
as a new permission boundary.

The caller's umask is preserved for the server and build tools. Inbox state uses
explicit private modes without changing global process permissions.
`SPEC_SESSION_DIR` and `KIBI_SPEC_SESSION` are removed from the server environment
so its tools do not inherit the editor's persistent-session opt-ins.

The live `/api/event` SSE subscription is established before the first prompt.
Session-filtered assistant text deltas are written verbatim to stdout, preserving
Markdown, whitespace and code fences without JSON escaping or ANSI/TUI rendering.
The completed text event is not printed again after deltas; when no deltas were
received, its full text is printed instead. Provider reasoning is streamed as
`Thinking: ...` without provider metadata; a completed-only reasoning event is
printed in the same form. Todo updates are rendered as a `# Todos` block with
status markers. Tool starts/completions, permission requests and questions use
short labeled lines. Prompt echoes, tool input/output payloads and protocol
metadata are not dumped into the pane. Full tool results remain in session
history. Lifecycle/admission notices are deferred while text or reasoning is
streaming so they do not split its Markdown.

Errors and retry reasons go to stderr. The server is started with
`--print-logs --log-level WARN`, forwarding warning/error diagnostics (including execution
failures reported only via Effect logging) to stderr rather than only a separate
OpenCode log file. Admission is not model success: a later execution failure can
leave an accepted file in place. Stream disconnects reconnect without submitting any new prompt; live output can have
a gap, explicitly reported on stderr. The OpenCode database retains durable
session history; the live output log is not a guaranteed complete transcript.

## State And Shutdown

The runner reserves `.runner/` inside the inbox.

The editor separately reserves `.editor-state` (canonical spec and output paths)
and `.editor-lock` (exclusive publishing lock). Restoring scans both the inbox
and the runner's accepted/pending/rejected folders to avoid reusing message names.
Publication never overwrites an existing inbox file. A migrated legacy session
may also contain `.legacy-editor-pid`; its original editor must exit before the
new editor can acquire the publishing lock.

Runner files:

- `pid`: runner PID as a JSON number.
- `status`: atomic JSON with `state: "starting" | "ready" | "stopped" | "failed"`
  and an error on failure. `ready` means the session/event stream are ready, not
  that the initial prompt has completed or even been admitted.
- `session.json`: private connection details (`sessionID`, `directory`, `pid`,
  `serverPID`, `url`, `username`, `password`). Never include this file in logs.
- `pending/`: claimed input awaiting admission acknowledgement.
- `accepted/`: original files whose durable admission was acknowledged, NOT
  necessarily completed successfully by the model.
- `rejected/`: malformed, unsafe, or reused-name files, with diagnostic on stderr.

HTTP retries use the same message ID derived from session ID and filename, so
an ambiguous response cannot submit the prompt twice. This includes lost or
truncated bodies after a successful HTTP status; acknowledgement requires the
entire JSON response to decode. Accepted-name reuse is rejected. Permanent API
failures or exhausted retries stop the runner and leave
the current input pending. A permanent exclusive `.runner` claim prevents two
launchers and prevents accidental replay after shutdown/crash. There is NO
automatic crash recovery, server restart, or claim takeover. Do not remove the
claim and relaunch an old inbox: create a new editor/inbox instead and reconcile
any pending admission with the recorded session first.

To stop, create a file named `STOP` in the inbox, or send SIGTERM/SIGINT to the
recorded runner PID. STOP is checked between admissions; an in-flight admission
may finish first. Shutdown stops the owned server (SIGTERM, then SIGKILL after
five seconds if needed), including any current model execution. No updates are
accepted afterward. Closing the editor need not stop the session unless the
editor explicitly requests it. There is no idle timeout. SIGKILL/machine crashes
cannot guarantee process cleanup; use recorded PIDs only after verifying their
identity, since PIDs can be reused. Keep the directory until the runner has exited,
then delete it explicitly when its inputs/diagnostics are no longer needed.
Deleting the inbox does not delete the session history in OpenCode's database.

## Runtime Requirements

Requires Linux/POSIX ownership/permissions, Bash, util-linux `setsid`, and Bun on
PATH. Script-only changes do not need a rebuild; provider support changes in Core
do require rebuilding the `opencode-source` binary and starting a new editor session.
`SPEC_OPENCODE` optionally selects a trusted executable (a single path, not a
shell command); default is `opencode-source`. It must implement V2 durable prompt
admission with idempotent message IDs and `/api/event`, NOT just legacy
`/session/:id/prompt_async`. Startup checks the binary's advertised routes and
fails rather than falling back. The installed binary at
`/home/opencode/.local/bin/opencode-source`, version `0.0.0-dev-202609191307`,
advertises the required APIs. Normal model credentials are required for actual
build work. The editor integration must point to this checkout's `run-spec.sh`
and keep `spec-session.ts` alongside it.

V2 credentials are stored separately from legacy `auth.json`. A model connected in
the legacy CLI is not necessarily available in `/api/model`; its credentials must
also be present in V2. Do not work around a missing connection by silently choosing
another provider or placing keys in `SPEC_MODEL`.

## Verification

Run from `packages/opencode`:

```sh
bun test test/cli/run-spec.test.ts test/cli/spec-session.test.ts
bun typecheck
SPEC_SESSION_SMOKE=1 bun test test/cli/spec-session.test.ts
```

The default tests use a separate fake HTTP/SSE server process, including busy and
idle updates, duplicate/lost/truncated-response handling, private files, inherited
umask, editor environment isolation, server diagnostics, readable Markdown,
output reconnects, incompatible binaries, and shutdown. The opt-in smoke test uses
the installed binary with isolated temporary configuration/storage. It verifies
authentication and idempotent admission with `resume: false`, then requests
execution with an intentionally nonexistent provider to verify that server-only
model-resolution errors reach stderr. It makes no model calls.
