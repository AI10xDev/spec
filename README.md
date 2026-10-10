# spec

A local-first **Rust backend + Vite / React / TypeScript frontend** for writing specifications and viewing build output side by side.

This is a source-derived web rewrite of [AI10xDev/specific](https://github.com/AI10xDev/specific), the project behind the development machine's `spec` shell command. “Rust++” was clarified to mean Rust, not a separate language or C++ requirement. The HTTP backend is Rust; optional execution delegates over SSH to the remote `spec build` alias/function. OpenCode is an **optional external execution engine**, not a Rust reimplementation of the model/provider stack.

## Workspace showcase

![Animated tour of the spec workspace showing saved files, multiple editor tabs, and completed remote SSH build output beside the specification](docs/workspace.gif)

[View the original screenshot](Screenshot%20From%202026-10-05%2019-07-10.png). This looping tour uses the October 5, 2026 screenshot to highlight saved files, multiple editor tabs, and side-by-side specification editing and completed remote SSH build output. It is an animated screenshot showcase, not a live execution recording.

## Features

- **Saved files tab:** previously written files in the selected workspace, most-recently-modified first, with timestamps, sizes, filtering, and refresh.
- **Multiple editor tabs:** independent buffers, quick switching, dirty indicators, and confirmation before discarding unsaved edits.
- **Two panes:** the active spec on the left; that file's output and logs on the right. Smaller screens stack them vertically.
- **Reliable saves:** atomic replacement, private file permissions, and revision checks that reject stale saves instead of silently overwriting them.
- **Local file workflow:** create, edit, save, reopen, and download UTF-8 files; Ctrl/Cmd+S saves the active editor.
- **Completed spec lines:** press `/` to toggle the current line's `# ` completion marker; Alt+/ inserts a literal slash. The build agent is instructed to retain completed lines as context and implement only pending requirements.
- **Trailing completions:** optional Azure-powered ghost text for the current sentence part; Tab or **Accept part** inserts it, Escape dismisses it.
- **Optional Save & run:** explicit confirmation, immutable saved-spec input, live output polling, follow toggle, cancellation, concurrency limits, and a 15-minute timeout.
- **Save repo changes:** shown only when the configured remote directory belongs to a Git worktree with uncommitted changes. Uses `azure/gpt-6-sol` with the existing repository workflow and the saved spec as context.
- **Recoverable output:** reopening a saved spec restores its latest build output after browser or server restart, without rerunning the build.
- **Separate session chat:** ask about the current nohup output, written spec, or general topics in a dedicated browser window, without adding chat to the editor/output panes.
- **Local API protection:** loopback binding, a random access token, no permissive CORS, constrained filenames, and symlink rejection.

The output pane displays available stdout/stderr and explanations. It does **not** request or expose hidden model chain-of-thought.

Read the [complete feature guide](docs/FEATURES.md), [code review](docs/REVIEW.md), [security notes](docs/SECURITY.md), and [source collection notes](archive/README.md).

## Quick start

Requirements: Linux, Rust/Cargo (tested with 1.98), and Bun (tested with 1.3.14) or Node.js 22.12+ with npm. Bun is recommended for reproducible frontend installs using `bun.lock`; the launcher's npm fallback does not use that lockfile. These tools are used for frontend dependency management/building only. The backend uses Unix file locking and process groups; Windows is not supported by this version.

```sh
gh repo clone ai10xdev/spec
cd spec
./run.sh
```

`run.sh` loads the remote host from `~/ip` (user `opencode`), uses the local key `$HOME/Downloads/Spec_man.pem`, and creates remote `~/project` if missing. It exports the SSH settings to enable **Save & run**, then installs frontend dependencies, typechecks/builds the UI, and starts the release Rust server. Override the defaults with `SPEC_SSH_TARGET`, `SPEC_SSH_KEY`, and `SPEC_SSH_WORKSPACE`. Use `./run.sh --local` for the editor without SSH. It can be invoked from any working directory; relative workspace/UI paths are resolved from `backend/`. Stop it with Ctrl+C.

For future builds without starting the server, run `./build.sh`. It installs frontend dependencies, typechecks/builds the UI into `frontend/dist`, and builds the release backend in `backend/target/release/spec` (or your configured Cargo target directory). No SSH key is needed to build the app. `run.sh` uses this same build script before launching.

New workspace directories are private. If an existing workspace is writable by group/others, startup stops without changing its permissions. Choose another trusted directory or explicitly run `chmod go-w -- /path/to/workspace` before retrying.

Open the **full URL printed by the server**, including `#token=…`. Production frontend assets are served by Rust from `frontend/dist`; there is no separate frontend server to start. The default address is `http://127.0.0.1:4780` and the default file workspace is `workspace/` at the repository root. Keep the printed token private.

Create `idea.md` in the left sidebar, enter text, and click **Save**. It now appears in **Saved files**, including after restarting the server. Create or open a second file to get another editor tab.

### Use existing specs

From the repository root, select an existing **trusted, flat directory**:

```sh
SPEC_WORKSPACE="$HOME/specs" ./run.sh
```

The original shell function mirrors specs into `$HOME/specs`, so this can display those previously written files directly. **This edits the selected files in place.** Back them up first if needed. This version does not automatically read `~/.local/state/spec/saved-files` or traverse unrelated paths from that history. Nested folders, hidden files, symlinks, and non-UTF-8 files are not editable.

### Remote execution through `spec build` (local web server)

The **browser, Rust web backend, and editable workspace run on your local computer**. Only **`spec build <snapshot-file>` runs on the remote machine over SSH**. No remote web backend, HTTP port forwarding, or remote frontend build is needed.

`./run.sh` configures remote execution automatically using the defaults above. To choose another host and directory, start the app on your **local computer** like this:

```sh
# One-time SSH setup: connect interactively and verify the host fingerprint
# through a trusted channel before accepting it. Load an encrypted key into
# ssh-agent if necessary; builds cannot prompt for passwords/passphrases.
ssh -i "$HOME/.ssh/spec_ed25519" user@build-host
# Exit the remote shell, then run these commands LOCALLY:
unset SPEC_COMMAND
SPEC_SSH_TARGET="user@build-host" \
SPEC_SSH_KEY="$HOME/.ssh/spec_ed25519" \
SPEC_SSH_WORKSPACE="/home/user/project" \
SPEC_WORKSPACE="$HOME/specs" \
./run.sh
```

Adjust the host, local key path, and remote project directory for your environment. `SPEC_SSH_TARGET` also accepts a trusted host alias from your local SSH configuration (including its port/ProxyJump settings). Set `SPEC_SSH_KEY=` to use your SSH agent/default identities with the launchers; omitting it selects the default key above. Keep private keys **on the local computer**; never paste key contents into a spec or commit them. Builds use batch SSH with strict host-key checking, no TTY, no agent/X11 forwarding, and no port forwarding. Unknown hosts, inaccessible keys, and connection/authentication errors fail startup or appear in run output; they do not fall back to local execution.

#### Repeatable remote-build launcher

`./ops.sh` delegates to `run.sh` with the local editor workspace defaulting to `$HOME/specs`. Both launchers check SSH and create remote `~/project` if missing before starting the local app. Override those defaults with the variables above. The key path is converted to an absolute path before starting the backend.

```sh
# One-time key permissions, then build and launch with the defaults:
chmod 600 "$HOME/Downloads/Spec_man.pem"
./ops.sh
# Use another existing local private key:
SPEC_SSH_KEY="$HOME/.ssh/your_existing_key" ./ops.sh
# Or use identities already configured in SSH config/ssh-agent:
SPEC_SSH_KEY= ./ops.sh
# Build the app without starting it:
./build.sh
```

To build **all specs already in remote `~/project`** without starting the web app:

```sh
./remote-build.sh --check   # Connect, create the directory if missing, list inputs
./remote-build.sh           # Build each spec serially in that remote directory
```

This uses the same host/key settings as `ops.sh`. Set `SPEC_SSH_WORKSPACE=/absolute/remote/path` to override the directory. Only top-level regular `.md`, `.txt`, `.spec`, and extensionless files are inputs; hidden files, symlinks, subdirectories, and output logs are excluded. Local specs and remote `~/specs` are not automatically copied. An empty directory prints “No specs found.” Each invocation writes separate logs under remote `project/.spec-runs/batch-*/`, continues after individual failures, and exits nonzero if any build fails. Keep SSH connected until the batch finishes. Use `ops.sh` and **Save & run** for the web app's detached per-file builds.

Both `./ops.sh` and `./run.sh` check an explicitly supplied key before building and convert relative paths (from your current directory) or literal `~/` paths to absolute paths. An empty key is treated as unset. Launching the Rust binary directly still requires an absolute key path.

The error `SPEC_SSH_KEY must be an absolute local private-key file path` could previously mean either a relative path **or a missing file**. The backend now distinguishes those cases. A key must exist on the computer running the local server; a path on the remote host does not work. If this computer has no authorized key or configured SSH identity, provide one before using **Save & run**.

To trace the installed local `spec` command, check `type spec` in your interactive shell. In the Specific installation, `~/.bashrc` sources `~/.local/share/specific/shell/specific.sh`; its `spec build` function calls `bin/specific-run-build`, which invokes `opencode run --agent build`. OpenCode provider credentials may be configured in `~/.config/opencode/opencode.jsonc`. Those API credentials authenticate model requests, not SSH connections, and cannot be used as `SPEC_SSH_KEY`. Remote builds need their own working SSH identity and OpenCode configuration on the remote host.

Open the full localhost URL printed by the **local** Rust server, including its token. **Save & run** first saves locally, then sends just that immutable spec snapshot over SSH. Other local project files are **not synced**. The remote build works in `SPEC_SSH_WORKSPACE`; its file changes remain remote. Prepare that remote checkout separately. `SPEC_WORKSPACE` is the local editor directory and is independent of the remote build directory.

#### Save edited repository changes

**Save repo changes** appears only for a connected, dirty Git worktree in `SPEC_SSH_WORKSPACE` (the remote build directory, not the local editor directory). Status refreshes every five seconds; probe errors hide the button. Staged, unstaged, and untracked files count, but `.spec-runs/`, `.spec-output/`, and `.spec.lock` do not. Select a nonempty spec as context to enable the button.

After explicit confirmation, the UI saves the active spec locally and submits its revision to `POST /api/repository/save`. The backend rechecks the repository and unfinished harnesses, then uses the existing SSH `spec build` launcher with `azure/gpt-6-sol` and repository-save instructions instead of implementing pending spec requirements. Existing provider settings, instructions, and repository workflow are preserved. The model is instructed to validate and make focused commits, excluding secrets, session artifacts, and unrelated edits; pushing, amending, resetting, and bypassing hooks are not authorized. The remote launcher must honor the supplied OpenCode configuration.

An active or unresolved harness blocks repository saves, including runs for other specs. The remote supervisor also excludes overlapping launches and refuses saves when a prior session lacks a valid terminal `status`. Inspect that session rather than assuming missing status means success. Output, cancellation, and recovery use the same **Output & logs**, **Stop run**, and **Load nohup output** controls. Logs are per-session `<spec filename>.out`, not a shared `nohup.out`. A `completed` harness means CLI exit success only: inspect its reported commit and validation results to confirm the changes were saved. No repository commits or provider calls happen merely by checking status.

#### Remote shell requirements

The remote machine needs Linux, Bash, `setsid`, GNU coreutils (including `stdbuf`), findutils, and a configured `spec` build alias/function (or shell launcher on PATH) with its engine/provider credentials. It does **not** need this Rust web server or Bun/Vite for the web UI.

The adapter explicitly sources the trusted remote **`~/.bash_aliases`** in noninteractive Bash with alias expansion enabled, then invokes only:

```sh
export SPEC_BUILD_FOREGROUND=1 SPEC_BUILD_AUTO=1
export OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS=1 OPENCODE_QUESTION_AUTO_RECOMMEND=1
spec build "$snapshot"
```

Before sourcing that file, the adapter prepends the remote user's `~/.local/bin` and `~/.bun/bin` to `PATH` so user-installed engines are available to child launchers. If your alias/function is defined elsewhere, arrange for `~/.bash_aliases` to source its trusted definition and set the required engine PATH. Interactive `.bashrc` and login profiles are not loaded by the adapter; definitions guarded by an interactive-shell check will not work. The `spec` command must remain in the foreground, propagate its exit status, and accept an explicit snapshot filename. Do not resolve `spec` to the Rust web-server binary. The archived scripts are provenance, not installed configuration, and are not modified or automatically sourced.

If a build reports `run-spec.sh: ... opencode-source: command not found`, the remote launcher was found but its engine was not. Verify that `opencode-source` is installed and executable **on the remote host**. For a custom installation, add an exported PATH to the remote `~/.bash_aliases`, outside any interactive-shell guard:

```sh
export PATH="$HOME/path/to/engine/bin:$PATH"
```

Use the actual directory containing the engine. An interactive shell alias for `opencode-source` is not sufficient: `run-spec.sh` starts a child shell that needs an executable on its exported PATH. No local engine installation or SSH forwarding change is needed.

**Automatic tool approval and recommended question answers are requested.** The adapter sets `SPEC_BUILD_AUTO=1`, `OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS=1`, and `OPENCODE_QUESTION_AUTO_RECOMMEND=1` after sourcing aliases, and clears persistent-session settings. A compatible OpenCode harness can then run unattended after the one **Save & run** confirmation. The installed remote alias/engine determines actual approval and answer behavior; verify it supports these flags and the foreground contract. There is no browser runtime-answer channel or blind `yes` fallback for unsupported engines or questions without a recommendation. Assume builds can modify remote files, execute tools, access the network, and incur provider costs using remote credentials. The UI confirmation is not a sandbox or per-tool approval boundary.

#### Sessions and cancellation

The build adapter supplies supplemental OpenCode instructions without rewriting the saved snapshot. A single leading `# ` after optional indentation marks only that line completed; removing it reopens the requirement. `##` headings, inline hashes, and hashes in code blocks are not completion markers. The `/` editor shortcut preserves indentation and native undo; inside fenced code it types a normal slash. Use Alt+/ for literal slashes elsewhere. The remote adapter needs Bun or Node to merge these instructions into OpenCode configuration; the remote launcher must honor that configuration.

Snapshot text is sent as data over SSH stdin, never interpolated into shell code or included in the SSH command line. After a complete upload, a detached supervisor owns the build and its `0600` snapshot in a `0700` run directory under `SPEC_SSH_WORKSPACE/.spec-runs/`. That parent directory must be owned by the remote user, private (`0700`), and not a symlink. The snapshot is removed after completion, cancellation, or watchdog expiry. Later local saves do not change the running input.

**Closing SSH, stdin EOF, closing the browser, and normal server shutdown do not cancel an uploaded build.** The supervisor ignores SIGHUP (no-hangup behavior), runs in its own session, and writes output to a private file rather than the SSH socket. Instead of a shared `nohup.out`, each run uses `<spec filename>.out`, for example `idea.md.out` or `idea.out` for an extensionless spec named `idea`. The full filename and separate run directories keep logs distinct across specs and repeat builds. SSH only tails that log. **Stop run** sends an explicit cancellation control byte after the snapshot; the supervisor kills the build's process group, including ordinary descendants. An independent **15-minute remote watchdog** remains active after disconnect. The local attachment gives up after 15 minutes plus 15 seconds, without cancelling remote work. Stop cannot be guaranteed through a broken connection; an unconfirmed cancellation is reported as detached rather than cancelled.

The output pane prints `[remote] session: /absolute/path/.../run-...`. On the remote host, recover using that exact directory (or list `.spec-runs/` if the connection ended before the notice arrived):

```sh
cd /home/user/project/.spec-runs/run-REPLACE_WITH_ACTUAL_ID
tail -f -- 'idea.md.out'       # Use the spec's log name; Ctrl+C stops viewing, not the build
cat status                    # Absent while running; published atomically after cleanup
touch cancel                  # Explicitly stop a still-running detached build
```

`status` contains the CLI exit code: `0` success, `124` watchdog timeout, `130` cancellation, or `125` supervisor error (these reserved codes can also be returned by a launcher). Completion means CLI exit success, not verification of generated changes. `<spec filename>.out` merges stdout/stderr and retains the **first 8 MiB**; excess output is drained/discarded so a noisy build cannot fill disk indefinitely or fail from a broken log pipe. Files are `0600`; they can contain sensitive spec/tool output. The browser keeps only the latest 256 KiB it received, independently of this remote cap. Recovery also reads legacy `output.log` files for sessions launched before this naming change, including builds still running during an upgrade.

Completed run directories older than seven days are pruned on the next launch in that remote workspace. There is no background retention service or strict total disk quota; manually remove finished directories sooner if needed. Do not delete a live run directory. Host reboot, SIGKILL of the supervisor, disk failure, or children that deliberately create separate process groups remain outside the guarantee and may leave stale snapshots or missing status. Missing status is not proof of a live build after such a failure.

Keep `.spec-runs/` out of remote version control and artifact uploads, for example by adding it to that checkout's `.git/info/exclude`. Private filesystem permissions do not prevent a same-user tool from reading or committing session files.

Run records and latest-run associations persist privately in the local workspace's `.spec-output/` directory. After restarting the server, connect using its newly printed token and open the spec from **Saved files** to restore its latest output and status. Live or unresolved sessions resume polling; **Recover output** retries a failed lookup without launching a build or replacing the editor buffer. Recovery requires the same remote configuration for unfinished sessions; cached finished output remains available without SSH. **Stop run** explicitly cancels a recovered session. Unresolved sessions count toward concurrency limits and block another run for the same file. This recovers logs/status, not interactive session steering or replay. Local records have no automatic disk pruning; protect them like specs because they can contain sensitive runtime output.

Builds are capped at **120 KiB** because some existing launchers forward the prompt as one Linux process argument. Editing/saving support 2 MiB. Remote launchers using Bash command substitution may strip trailing newlines and must use an end-of-options separator when passing prompts to their engine.

`SPEC_COMMAND` and local build execution have been removed: unset the old variable and use the SSH settings above. No model credentials are needed locally for editing or SSH builds. Validation uses an isolated SSH stand-in running the actual remote supervisor and alias scripts; no live SSH host or provider call is required by tests.

### Trailing sentence-part completions

Configure Azure once on the **local Rust server** to enable both ghost text and session chat. Copy the template to a private `.env` in the repository root:

```sh
cp .env.example .env
chmod 600 .env
```

Fill in your Azure endpoint, API key and deployment in `.env`, then start `./run.sh` (or `./run.sh --local` for the editor without remote builds). Restart an already-running server and reload the browser after changing settings. Startup reports whether chat and ghost text are enabled.

The Rust server reads the nearest `.env` in its working directory or an ancestor, so this works with `run.sh` and with `cargo run` from `backend/`. To use a file elsewhere, set `SPEC_AI_ENV_FILE=/absolute/path/to/ai.env`. Only AI settings are consumed from this file; exported environment variables take precedence. You can also configure everything through exports:

```sh
export AZURE_OPENAI_ENDPOINT="https://YOUR-RESOURCE.openai.azure.com/openai/v1"
export AZURE_OPENAI_API_KEY="YOUR-KEY"
export DEPLOYMENT_NAME="YOUR-DEPLOYMENT"
./run.sh
```

If the installed `spec build` command already works, it may be using OpenCode's Azure configuration in `~/.config/opencode/opencode.jsonc`. Map `providers.azure.settings.resourceName` to `https://RESOURCE.openai.azure.com/openai/v1`, its `apiKey` to `AZURE_OPENAI_API_KEY`, and the selected Azure model's `modelID` (or model name when no override exists) to `DEPLOYMENT_NAME`. A value such as `{env:AZURE_OPENAI_API_KEY}` is a reference: use the actual credential from the OpenCode server environment, not that placeholder. The Rust server needs its own exports or private `.env`; credentials available to OpenCode are not automatically inherited by it.

Use your configured deployment name (default `gpt-5.5`). A legacy resource-root endpoint instead requires `AZURE_OPENAI_API_VERSION`. Endpoints must use HTTPS. No credentials are exposed to the browser or bundled in the repo; do not commit keys. Missing endpoint and key disables completions, while partial/invalid configuration fails startup.

When configured, **Trailing completions** starts enabled and can be switched off in the editor. After 500 ms idle at a line's end, the browser sends up to 4,000 recent UTF-16 units (at most 16 KiB UTF-8) before the caret to Azure through the authenticated Rust API. This includes **unsaved text** and may incur provider costs. A muted suffix suggests one sentence part, capped at 160 characters and the first clause/sentence punctuation. **Tab** or **Accept part** inserts it; **Escape** dismisses until typing resumes. Selections, IME composition, and text after the caret on the same line suppress suggestions. Long ghost text is clipped at the pane edge; the Accept part button's tooltip shows the suffix. Suggestions are not saved or downloaded until accepted.

Accepting a part waits for your next edit before requesting another suggestion, including when the accepted suffix has no final punctuation. Requests have a 10-second timeout and four-request concurrency cap. Errors leave editing available and retry on subsequent edits, not in a loop. Tests use provider mocks; no live Azure call is needed. This restores inline completion only, not filename ranking.

### Session chat

Click **Open session chat** near the output controls to open a separate browser window (allow popups for this site). Text chat uses the same server-side Azure configuration as trailing completions; disabling inline suggestions does not disable chat. Click **Ask** or press **Enter** to send; **Shift+Enter** inserts a new line.

The window stays bound to its chosen filename, even when you select another editor tab. While the source workspace remains open, it uses that file's live buffer, including unsaved edits. If the source closes or is unavailable, it explicitly falls back to the saved file; drafts and conversation are not persisted. The current written spec is never presented as the immutable input to an older build.

Before each question, chat reloads the file's latest associated nohup output without launching or cancelling a build. Failed reads block the question rather than silently using stale logs. Context priority is qualitative: current session output/status as execution evidence, written spec as intent, then prior conversation for continuity. A new run clears earlier conversation on the next question. Without a run, spec and general questions still work.

Questions send up to the first **64 KiB of spec**, the last **64 KiB of available output**, and four prior question/answer pairs to Azure through the authenticated API. Truncation is disclosed; remote log retention limits still apply. Questions are capped at 8 KiB, answers at 16 KiB, and provider requests at 60 seconds, sharing the four-request concurrency limit with inline completions. AI answers are read-only, have no tools, and render as plain text. Keep sensitive information out of submitted specs/logs and verify important claims.

**Edit Agent.md** opens an inline editor for creating and saving that workspace file, with revision checks to prevent overwriting concurrent edits. See [chat editing](docs/chat-editing.md) for draft and reload behavior. Saving does not automatically install instructions into remote builds or AI conversations.

The separate **OpenAI voice conversation** mic button opens **OpenAI Realtime** voice input and audio responses. Set server-side `OPENAI_API_KEY` (optionally `OPENAI_REALTIME_MODEL`, default `gpt-realtime`), restart, and reload. Voice is independent of Azure text chat and requires microphone permission on HTTPS or localhost. See [voice setup and privacy](docs/realtime.md).

The **Azure OpenAI mic** button opens a separate **Azure OpenAI Realtime** panel for voice input and audio responses, preserving the OpenAI button. Select **Start Azure voice conversation** and allow microphone access. Starting either provider stops the other voice session in that chat window. Set all three server-side variables `AZURE_OPENAI_REALTIME_ENDPOINT="https://your-resource.openai.azure.com"`, `AZURE_OPENAI_REALTIME_API_KEY`, and `AZURE_OPENAI_REALTIME_DEPLOYMENT`, then restart and reload. The endpoint accepts only a canonical public Azure HTTPS resource origin, optionally ending in `/`, not an `/openai/v1` URL. Partial or invalid configuration fails startup; there is no fallback to OpenAI or Azure text credentials. The authenticated `POST /api/realtime/azure` endpoint and `azureRealtime` capability are independent of OpenAI. Azure uses GA client-secret minting followed by raw-SDP negotiation, keeping both credentials backend-side. Spec/log snapshots and microphone audio go to the selected provider and incur its charges. See [Azure setup, protocol, and privacy](docs/realtime.md#azure-setup).

### Frontend development

Keep the Rust server on its default port, then in a second terminal:

```sh
cd frontend
bun run dev
```

Open the Vite URL and paste the Rust server's token into the connection form. Vite proxies `/api` to `127.0.0.1:4780`. If you change the backend port for development, update `frontend/vite.config.ts` accordingly.

## Configuration

These are the Rust server's defaults when launched directly. `run.sh` supplies the SSH defaults described above and creates the remote build directory before startup; `--local` clears the SSH settings.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPEC_WORKSPACE` | `../workspace` | File directory, relative to the backend process working directory |
| `SPEC_PORT` | `4780` | Loopback HTTP port; `0` chooses an available port |
| `SPEC_UI_DIR` | `../frontend/dist` | Built Vite assets, relative to process working directory |
| `SPEC_SSH_TARGET` | unset | Trusted `user@host` or SSH host alias; enables remote builds together with `SPEC_SSH_WORKSPACE` |
| `SPEC_SSH_WORKSPACE` | unset | Existing absolute remote build directory; not the local editor workspace; no `~` expansion |
| `SPEC_SSH_KEY` | unset | Optional absolute **local** private-key file path; otherwise use SSH agent/default identities |
| `SPEC_SSH_BINARY` | `/usr/bin/ssh` | Absolute trusted local SSH client executable (also used for test stand-ins) |
| `AZURE_OPENAI_ENDPOINT` | unset | Optional local completion provider: HTTPS resource root or `/openai/v1[/responses]` |
| `AZURE_OPENAI_API_KEY` | unset | Server-side Azure completion key; required with the endpoint |
| `DEPLOYMENT_NAME` | `gpt-5.5` | Azure completion deployment name |
| `AZURE_OPENAI_API_VERSION` | unset | Required only for legacy Azure resource-root endpoints |
| `SPEC_AI_ENV_FILE` | nearest `.env` in current/ancestor directories | Optional path to the server-side dotenv file shared by chat and ghost text; explicit files must exist |
| `OPENAI_API_KEY` | unset | Server-side OpenAI Realtime key; enables `/api/realtime` independently of Azure |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime` | OpenAI Realtime model |
| `AZURE_OPENAI_REALTIME_ENDPOINT` | unset | Azure Realtime canonical HTTPS resource origin `https://RESOURCE.openai.azure.com`; all three Azure Realtime variables required together |
| `AZURE_OPENAI_REALTIME_API_KEY` | unset | Independent server-side Azure Realtime resource key |
| `AZURE_OPENAI_REALTIME_DEPLOYMENT` | unset | Explicit Azure Realtime deployment name; no text/OpenAI fallback |

There are no credentials bundled in this repository and no automatic service installation. The existing `spec` shell alias is not modified. Run the new binary explicitly from `backend/target/release/spec` if the old shell function shadows its name.

## Validation

Run checks from the respective package directories:

```sh
cd backend
cargo fmt --check
cargo test --locked
cargo clippy --all-targets --locked -- -D warnings
cargo build --locked

cd ../frontend
bun install --frozen-lockfile
bun typecheck
bun run test:unit
bun run build
bunx playwright install chromium
bun run test:e2e
```

Browser tests start isolated real Rust servers and temporary workspaces. They cover authentication, saved files, tabs, conflicts/downloads, in-flight saves, desktop/mobile layouts, and remote-build streaming/completion/cancellation/failure using a local SSH stand-in and the actual fixed remote scripts. They never use your specs or invoke a model. Screenshots are written under `frontend/test-results/`, not over the documentation image. See [validation results](docs/REVIEW.md#validation).

For a timed output smoke test, run `bun run test` from `frontend/`. It prints integers 1 through 100, starting immediately and waiting 1000 milliseconds between lines, then exits successfully (about 99 seconds total). Use `bun run test:unit` for the automated unit suite.

## Repository layout and scope

```text
backend/       New Rust HTTP API, filesystem layer, process runner, tests
frontend/      New Vite + React TypeScript UI, unit and browser tests
run.sh         Build the frontend and launch the Rust server
build.sh       Build the frontend and release backend without starting a server
ops.sh         Build and launch with configurable remote SSH settings
docs/          Feature guide, review, security notes, screenshot
archive/       Original source collection and license notices (not executed or bundled)
workspace/     Local user files (created at runtime; gitignored)
```

The **new runtime** is Rust + TypeScript, plus HTML/CSS. `archive/` intentionally preserves legacy languages for review/provenance. Persistent V2 session steering/recovery, Azure filename ranking, `/eval`, `/telle`, plan mode, and the terminal editor are **not ported into the web app**. This is a scoped web rewrite, not a feature-complete replacement for all original integrations.

The private repository is independently created rather than a GitHub fork-network entry. Its source ancestry and captured working-tree revisions are recorded in `archive/manifest.json`.

## License

The new application is MIT licensed. Original sources retain their own notices: `specific` MIT; Kibi MIT OR Apache-2.0; OpenCode MIT. The archived machine launcher carries provenance without an implied new license grant. See [NOTICE](NOTICE).
