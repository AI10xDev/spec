# Spec: step-by-step manual

This guide describes this machine's `spec` Bash function and executable wrapper,
not the portable `specific` package, whose defaults may differ. Spec combines a
terminal text editor with OpenCode: write requirements, save them, then explicitly
submit them to a build agent. Opening a file does not start a build.

    spec --help                  Short command summary (also spec -h)
    spec --manual                This guide; no model calls or editor launch
    spec --manual | less         Read a page at a time; q exits less
    spec --manual > spec-guide.md Save a copy

## 1. Start in the project you want to change

    cd /path/to/your/project
    spec feature.md

Use your actual project path. The current directory determines the target project
for builds and filename searches, even if the spec is stored somewhere else.
Quote paths containing spaces: `spec "my feature.md"`.

Prerequisites on this installation: Bash, Bun, the installed specific editor,
Linux utilities including nohup/setsid, and a configured OpenCode provider/model.
Normal editing does not require model credentials; builds do.
If your shell has an old function, run `source ~/.bash_aliases` or open a new shell.
Use `type spec` to check which function or executable your shell resolves.

Before building, review project configuration and commit or back up existing work.
Builds can modify files, run commands, send spec/project context to your provider,
and incur charges. This local OpenCode entrypoint enables automatic permission
approval and recommended question answers: do not rely on an approval prompt.
Keep secrets out of specs, logs, and filenames sent to optional model services.

## 2. Write a clear specification

Type plain text or Markdown in the editor. For example:

    # Add a health endpoint
    Goal: add GET /health returning HTTP 200 with {"status":"ok"}.
    Constraints: follow existing routing conventions; add no dependencies.
    Acceptance: include a route test and run the relevant test suite.
    Out of scope: authentication changes and deployment.

Include the goal, relevant files, constraints, acceptance checks, and what must
not change. The build receives the saved specification as its prompt.

## 3. Save without running

Press Ctrl+S. An unnamed buffer asks for a filename; enter one and press Enter.
Check the status bar for save errors before continuing.

Successful saves record the original path in `~/.local/state/spec/saved-files`
and attempt a mirror copy in `~/specs/`. Mirror copies use only the basename:
two files called feature.md can overwrite the same mirror. Keep the original
project file as your source of truth. Ctrl+S alone does not submit model work.

Bare `spec` reopens the most recently saved file. Without save history it opens
an unnamed buffer. `spec another.md` explicitly selects another file. Use a
relative path for reserved names: `spec ./build` or `spec ./--manual`.

## 4. Build and follow the result

Press Ctrl+R to save and submit. On the first submission the default local
launcher starts a persistent OpenCode session. Live output appears in the left
pane; the status bar shows the output log path. Saving must succeed before work
is submitted. Allow time for startup and inspect errors in the output.

The editor appends output to `<filename>.out` in the directory where you started
spec. For `spec feature.md`, this is normally `feature.md.out`:

    tail -f feature.md.out

Run that in another terminal if needed. Ctrl+C stops tail, not the build.
The editor pane shows a bounded, auto-following view; use the log to inspect older
output. Logs may contain sensitive data and are not automatically deleted.

Review the changes and run/check the requested tests. An accepted or queued prompt
is not proof that the model completed successfully.

## 5. Refine the same session

Edit the spec and press Ctrl+R again. With the default persistent launcher this
submits the complete saved text to the same session, including while it is busy.
Busy updates are incorporated at a safe provider-turn boundary; they do not
abort or restart the current turn. Write explicit follow-up instructions so the
agent understands what changed. Ctrl+S still only saves.

A custom KIBI_RUN_COMMAND can use one-shot behavior instead. It must be a single
executable path, not a shell command plus arguments.

## 6. Leave, reopen, or explicitly start fresh

Ctrl+Q leaves the editor. Save first; unsaved changes trigger a quit warning.
Closing the editor or terminal does not stop its background job.

    spec feature.md                 Restore this file's recorded session/output
    spec                            Reopen the most recently saved file
    KIBI_SPEC_RESUME=0 spec feature.md

The last command opts out of restoration; press Ctrl+R to start a fresh session.
It does not stop an older runner. Close the previous editor before reopening the
same session: only one editor may publish to an inbox at a time.

Restoration does not submit a prompt, restart a stopped runner, or retry failed
work. A stopped session's output can still be viewed. Reconcile any work already
performed before explicitly starting fresh.

To stop a persistent session, find its exact inbox path in the `[spec-session]`
output (under `${XDG_STATE_HOME:-$HOME/.local/state}/spec/sessions`), then run:

    touch /exact/inbox/path/STOP

Replace the placeholder with that session's real inbox path. This stops its owned
server and current execution, not just the editor. No further updates are accepted.
Do not delete runner claims or relaunch an old inbox. Session connection metadata
contains credentials; never paste it into an issue or public log.

## 7. Build without opening the editor

    spec build feature.md           Start a one-shot build in the background
    spec build                      Build the last saved spec
    SPEC_BUILD_FOREGROUND=1 spec build feature.md

The foreground form waits and returns the runner's exit status. The default
background form prints a PID and output path; successful launch is not successful
completion. These builds do not join the editor's persistent session.

Unlike the editor, background `spec build feature.md` writes `feature.out` next
to the spec, replacing the previous log. A filename without an extension gets
`.out` appended. Use the printed path rather than assuming the editor log name.

## 8. Useful editor shortcuts

    Ctrl+S       Save only
    Ctrl+R       Save and submit the spec
    Ctrl+Q       Quit (background jobs survive)
    Ctrl+F       Find text in the current document
    Ctrl+G       Go to a line
    Ctrl+K       Remove the current line
    Ctrl+T       Search project filenames (Ctrl+: on supported terminals)
    Ctrl+E       Run an arbitrary shell command; use only commands you trust
    Tab          Accept an inline completion when one is shown; otherwise a tab

For filename search: press Ctrl+T, type a filename/description in the bottom query
input, then press Enter. Use Up/Down or 1-9 to select a result. Enter inserts its
relative path below the document cursor. Ctrl+O opens the file instead (save
first; opening is blocked while a session/command is attached). Esc cancels.

Filename search may send the query and candidate relative filenames, not file
contents, to Azure for ranking. Without Azure it falls back to local ranking.
Inline completion is also optional and separate from the OpenCode build model.
This shell uses `KIBI_ENV_FILE`, defaulting to `~/code.dev/.env`, for editor
integration credentials; do not commit that file.

## 9. Evaluate a hypothesis (optional)

    spec /eval "Assess the health endpoint against the documented requirements"

This selects the restricted hypothesis agent and writes an assessment to `.hyp`
in the current project. It can inspect permitted evidence and propose experiments,
but cannot execute benchmarks or modify source code. Missing measurements are
not treated as proof. This makes a model call and requires provider credentials.

The slash matters: `spec eval` and `spec --eval` invoke a separate, legacy
evaluation tool. Use `spec eval --help` for that tool's own arguments.

## 10. Analyze sanitized telemetry (optional)

1. Run `spec /telle init` to create a `.telle.json` template without overwriting
   an existing one.
2. Edit its objectives/snapshot paths and model; supply real, fresh, sanitized
   inputs in the format documented in `script/telle.md` in this checkout. Init
   does not collect telemetry or create real observations.
3. Run `spec /telle check` to validate inputs without a model call.
4. Supply a supported provider API key in the environment. Telle does not inherit
   normal OpenCode logins or project/global model configuration.
5. Run `spec /telle run` for one paid/provider-backed analysis and read
   `.telle/report.json`. Failures are recorded in `.telle/error.json`.
6. Only if you want recurring calls: `spec /telle install`, then
   `spec /telle start`. Install alone does not start anything. Timer runs need
   credentials in the systemd user-manager environment, not just your shell.
7. Check with `spec /telle status`; disable with `spec /telle stop`.

`spec telle` is equivalent to `spec /telle`; no action means status. There is one
systemd user timer pair per user. Telle analyzes supplied snapshots: it does not
scrape production, automatically redact secrets, deploy, scale, or remediate.
Starting the timer authorizes recurring model calls and associated costs.

## Troubleshooting and further reading

- Help opens as a filename: reload `source ~/.bash_aliases` in an existing shell.
- Last saved file is missing: open its correct path explicitly and save again.
- Build fails or model is unavailable: inspect the output; verify your configured
  model/provider credentials. Persistent V2 sessions use separate credentials from
  legacy auth. Select a connected model with `SPEC_MODEL=provider/model` before
  starting a new persistent session; this does not configure editor completion.
- Session is stopped: reopening only restores output. Use the explicit fresh
  session command above after reviewing prior work.
- Filename shortcut is swallowed by the terminal: use Ctrl+T instead of Ctrl+:.
- Nothing scrolls in the output pane: inspect the printed log with less or tail.

Detailed checkout references: `script/spec-session.md` (session lifecycle and
recovery), `script/spec-workflows.md` (dispatch), `script/telle.md` (telemetry
format, credentials, and timer setup). View this guide again with `spec --manual`.
