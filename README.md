# spec

A local-first **Rust backend + Vite / React / TypeScript frontend** for writing specifications and viewing build output side by side.

This is a source-derived web rewrite of [AI10xDev/specific](https://github.com/AI10xDev/specific), the project behind the development machine's `spec` shell command. “Rust++” was clarified to mean Rust, not a separate language or C++ requirement. The HTTP backend is Rust; optional execution delegates over SSH to the remote `spec build` alias/function. OpenCode is an **optional external execution engine**, not a Rust reimplementation of the model/provider stack.

![The Vite workspace with saved files, two editor tabs, and the output pane](docs/workspace.png)

## Features

- **Saved files tab:** previously written files in the selected workspace, most-recently-modified first, with timestamps, sizes, filtering, and refresh.
- **Multiple editor tabs:** independent buffers, quick switching, dirty indicators, and confirmation before discarding unsaved edits.
- **Two panes:** the active spec on the left; that file's output and logs on the right. Smaller screens stack them vertically.
- **Reliable saves:** atomic replacement, private file permissions, and revision checks that reject stale saves instead of silently overwriting them.
- **Local file workflow:** create, edit, save, reopen, and download UTF-8 files; Ctrl/Cmd+S saves the active editor.
- **Optional Save & run:** explicit confirmation, immutable saved-spec input, live output polling, follow toggle, cancellation, concurrency limits, and a 15-minute timeout.
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

`run.sh` installs frontend dependencies, typechecks/builds the UI, and starts the release Rust server. It can be invoked from any working directory and honors the configuration variables below; relative workspace/UI paths are resolved from `backend/`. Stop it with Ctrl+C.

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

Execution is off until an SSH target and remote build directory are configured. On your **local computer**, start the app like this:

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

Adjust the host, local key path, and remote project directory for your environment. `SPEC_SSH_TARGET` also accepts a trusted host alias from your local SSH configuration (including its port/ProxyJump settings). Omit `SPEC_SSH_KEY` to use your SSH agent/default identities. Keep private keys **on the local computer**; never paste key contents into a spec or commit them. Builds use batch SSH with strict host-key checking, no TTY, no agent/X11 forwarding, and no port forwarding. Unknown hosts, inaccessible keys, and connection/authentication errors fail the run and appear in its output; they do not fall back to local execution.

Open the full localhost URL printed by the **local** Rust server, including its token. **Save & run** first saves locally, then sends just that immutable spec snapshot over SSH. Other local project files are **not synced**. The remote build works in `SPEC_SSH_WORKSPACE`; its file changes remain remote. Prepare that remote checkout separately. `SPEC_WORKSPACE` is the local editor directory and is independent of the remote build directory.

#### Remote shell requirements

The remote machine needs Linux, Bash, `setsid`, standard coreutils, and a configured `spec` build alias/function (or shell launcher on PATH) with its engine/provider credentials. It does **not** need this Rust web server or Bun/Vite for the web UI.

The adapter explicitly sources the trusted remote **`~/.bash_aliases`** in noninteractive Bash with alias expansion enabled, then invokes only:

```sh
export SPEC_BUILD_FOREGROUND=1 SPEC_BUILD_AUTO=1
spec build "$snapshot"
```

Before sourcing that file, the adapter prepends the remote user's `~/.local/bin` and `~/.bun/bin` to `PATH` so user-installed engines are available to child launchers. If your alias/function is defined elsewhere, arrange for `~/.bash_aliases` to source its trusted definition and set the required engine PATH. Interactive `.bashrc` and login profiles are not loaded by the adapter; definitions guarded by an interactive-shell check will not work. The `spec` command must remain in the foreground, propagate its exit status, and accept an explicit snapshot filename. Do not resolve `spec` to the Rust web-server binary. The archived scripts are provenance, not installed configuration, and are not modified or automatically sourced.

If a build reports `run-spec.sh: ... opencode-source: command not found`, the remote launcher was found but its engine was not. Verify that `opencode-source` is installed and executable **on the remote host**. For a custom installation, add an exported PATH to the remote `~/.bash_aliases`, outside any interactive-shell guard:

```sh
export PATH="$HOME/path/to/engine/bin:$PATH"
```

Use the actual directory containing the engine. An interactive shell alias for `opencode-source` is not sufficient: `run-spec.sh` starts a child shell that needs an executable on its exported PATH. No local engine installation or SSH forwarding change is needed.

**Automatic tool approval is requested via `SPEC_BUILD_AUTO=1`.** The installed remote alias determines the actual engine and permission behavior; verify it supports the foreground contract. Assume builds can modify remote files, execute tools, access the network, and incur provider costs using remote credentials. The UI confirmation is not a sandbox or per-tool approval boundary.

#### Snapshot and cancellation contract

Snapshot text is sent as data over SSH stdin, never interpolated into shell code or included in the SSH command line. The fixed remote supervisor writes a `0600` snapshot in a `0700` temporary directory. It removes the snapshot after build completion or orderly cancellation. Later local saves do not change the running input.

**Stop run**, local timeout, and normal server shutdown close the SSH input lease. The remote supervisor then kills the build's process group and removes its snapshot. There is also an independent remote 15-minute watchdog for a stalled/lost connection. Network failures may prevent immediate cleanup confirmation; detached processes that create separate groups and remote machine failures remain outside this guarantee. Output/status are in-memory only. Exit success means the CLI completed, not that its generated changes were verified.

Builds are capped at **120 KiB** because some existing launchers forward the prompt as one Linux process argument. Editing/saving support 2 MiB. Remote launchers using Bash command substitution may strip trailing newlines and must use an end-of-options separator when passing prompts to their engine.

`SPEC_COMMAND` and local build execution have been removed: unset the old variable and use the SSH settings above. No model credentials are needed locally for editing or SSH builds. Validation uses an isolated SSH stand-in running the actual remote supervisor and alias scripts; no live SSH host or provider call is required by tests.

### Frontend development

Keep the Rust server on its default port, then in a second terminal:

```sh
cd frontend
bun run dev
```

Open the Vite URL and paste the Rust server's token into the connection form. Vite proxies `/api` to `127.0.0.1:4780`. If you change the backend port for development, update `frontend/vite.config.ts` accordingly.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPEC_WORKSPACE` | `../workspace` | File directory, relative to the backend process working directory |
| `SPEC_PORT` | `4780` | Loopback HTTP port; `0` chooses an available port |
| `SPEC_UI_DIR` | `../frontend/dist` | Built Vite assets, relative to process working directory |
| `SPEC_SSH_TARGET` | unset | Trusted `user@host` or SSH host alias; enables remote builds together with `SPEC_SSH_WORKSPACE` |
| `SPEC_SSH_WORKSPACE` | unset | Existing absolute remote build directory; not the local editor workspace; no `~` expansion |
| `SPEC_SSH_KEY` | unset | Optional absolute **local** private-key file path; otherwise use SSH agent/default identities |
| `SPEC_SSH_BINARY` | `/usr/bin/ssh` | Absolute trusted local SSH client executable (also used for test stand-ins) |

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
bun run test
bun run build
bunx playwright install chromium
bun run test:e2e
```

Browser tests start isolated real Rust servers and temporary workspaces. They cover authentication, saved files, tabs, conflicts/downloads, in-flight saves, desktop/mobile layouts, and remote-build streaming/completion/cancellation/failure using a local SSH stand-in and the actual fixed remote scripts. They never use your specs or invoke a model. Screenshots are written under `frontend/test-results/`, not over the documentation image. See [validation results](docs/REVIEW.md#validation).

## Repository layout and scope

```text
backend/       New Rust HTTP API, filesystem layer, process runner, tests
frontend/      New Vite + React TypeScript UI, unit and browser tests
run.sh         Build the frontend and launch the Rust server
docs/          Feature guide, review, security notes, screenshot
archive/       Original source collection and license notices (not executed or bundled)
workspace/     Local user files (created at runtime; gitignored)
```

The **new runtime** is Rust + TypeScript, plus HTML/CSS. `archive/` intentionally preserves legacy languages for review/provenance. Persistent V2 session steering/recovery, Azure completion/ranking, `/eval`, `/telle`, plan mode, and the terminal editor are **not ported into the web app**. This is a scoped web rewrite, not a feature-complete replacement for all original integrations.

The private repository is independently created rather than a GitHub fork-network entry. Its source ancestry and captured working-tree revisions are recorded in `archive/manifest.json`.

## License

The new application is MIT licensed. Original sources retain their own notices: `specific` MIT; Kibi MIT OR Apache-2.0; OpenCode MIT. The archived machine launcher carries provenance without an implied new license grant. See [NOTICE](NOTICE).
