# Installation

Spec is a single-user, local-first web workspace. The Rust server serves the
React UI and saves specifications on your computer. Optional builds run on a
separate SSH host. Installing this web app does **not** install or replace the
original `spec build` shell command or an AI execution engine.

## Requirements

| Location | Required software |
| --- | --- |
| Local computer | Linux, Bash, Git, Rust/Cargo 1.98 (tested), a native linker/toolchain, and Bun or Node.js 22.12+ with npm |
| Browser | A current browser; Chromium is used for automated desktop/mobile-layout checks |
| SSH execution host, optional | Linux, Bash, OpenSSH access, `setsid`, `flock`, GNU coreutils including `stdbuf`, findutils, a compatible `spec build` launcher, and its configured engine/provider |

Bun is recommended because `frontend/bun.lock` is the committed frontend lockfile.
The npm fallback works but does not use it. The project has been tested with Rust
1.98 and Bun 1.3.14; Windows is unsupported, and macOS is not a validated target.
Install Rust using [rustup](https://rustup.rs/) and Bun using its
[installation guide](https://bun.sh/docs/installation), or use a suitable Node
installation. On Debian/Ubuntu, a native toolchain can be installed with
`sudo apt-get install build-essential git`. Make sure `cargo`, and either `bun`
or both `node` and `npm`, are on your shell's `PATH` before launching.

Edition 2024 support alone is insufficient for all syntax/dependencies used here;
an older minimum toolchain has not been established by this release's checks.

No model account, API key, GPU, or SSH host is required for basic editing.
Source builds download dependencies; `--local` means no remote builds, not an
offline mode or a network sandbox.

## Install A Release

From a directory where you keep source checkouts:

```sh
git clone --branch v0.1.12 https://github.com/AI10xDev/spec.git
cd spec
unset SPEC_COMMAND
./run.sh --local
```

This selects the release tag in detached-HEAD mode. Use `git switch -c my-work`
before making your own source commits. For the latest development branch instead,
clone without `--branch v0.1.12`. If GitHub requests authentication, authenticate
with an account that has repository access; never embed tokens in clone URLs.

Alternatively, download **Source code (tar.gz)** or **Source code (zip)** from the
[release page](https://github.com/AI10xDev/spec/releases/tag/v0.1.12), extract it,
and run `./run.sh --local` from the extracted directory. These archives exclude
historical `.out` and `.spec-runs` artifacts. Git clones still contain tracked
historical artifacts and history; archive exclusions are not a secret audit or
history cleanup. An extracted archive has no Git metadata: obtain a new archive
to upgrade rather than using the Git commands below.

The launcher installs frontend dependencies, typechecks/builds the UI, builds the
release Rust backend, and starts it. It does not install a system service or a
global command. Open the **full printed URL**, including `#token=...`, normally
on `http://127.0.0.1:4780`. The token changes on server restart. Do not share it
or expose this single-user server through a public proxy or tunnel.

Create `first-task.md`, type a requirement, and click **Save**. Reopen it from
**Saved files** to see the disk-backed workspace. The edited active sheet also
autosaves after 500 ms while focused; check its unsaved indicator before leaving.
Stop the server with Ctrl+C.

By default files live in the checkout's `workspace/`. To keep specs independent
of the application checkout, use an absolute path to a trusted flat directory:

```sh
SPEC_WORKSPACE="$HOME/specs" ./run.sh --local
```

Existing files there are edited **in place**. New directories are private. An
existing group/other-writable workspace is rejected; choose another directory or
deliberately remove those write permissions. The editor accepts regular UTF-8
files, not subdirectories, hidden names, or symlinks. Editing/saving is limited to
2 MiB per file; build snapshots are limited to 120 KiB. Back up important specs.

## Enable Remote Builds

Keep these locations distinct:

| Location | Purpose |
| --- | --- |
| `SPEC_WORKSPACE` | Local specifications and private run associations |
| `SPEC_SSH_WORKSPACE` | Absolute execution-host directory containing the project to modify |
| `SPEC_SSH_KEY` | Private key on the local server computer, not on the execution host |

1. Prepare a trusted remote checkout yourself, including its dependencies and
   tests. Spec uploads the saved specification only: it does not sync your local
   project or bring generated code back automatically.
2. Install/configure a compatible execution launcher on that host, for example
   the [Specific project](https://github.com/AI10xDev/specific), and its engine.
   Arrange for remote `~/.bash_aliases` to define/source `spec` outside interactive
   shell guards and export the engine's executable `PATH`. It must support
   `spec build <snapshot-file>`, stay in the foreground, propagate exit status,
   and honor supplemental OpenCode configuration. Do not point it to this web
   server's Rust binary, which also happens to be named `spec`.
3. Connect interactively once and verify the SSH host fingerprint through a
   trusted channel. Use an SSH agent for an encrypted key if needed. Runtime
   connections are batch-mode with strict host-key checks and cannot prompt.
4. Start the web app **locally** with explicit SSH settings:

```sh
unset SPEC_COMMAND
SPEC_WORKSPACE="$HOME/specs" \
SPEC_SSH_TARGET="user@build-host" \
SPEC_SSH_KEY="$HOME/.ssh/spec_ed25519" \
SPEC_SSH_WORKSPACE="/home/user/project" \
./run.sh
```

Replace the host, key, and directory with your own. A trusted SSH configuration
alias works as the target. Use `SPEC_SSH_KEY=` explicitly to use configured
identities/ssh-agent; omitting it selects the launcher's machine-specific default
`$HOME/Downloads/Spec_man.pem`. Without an explicit target the launcher reads
`~/ip` and uses user `opencode`. These defaults are not universal installation
requirements. The launcher checks SSH and creates the remote workspace if absent.

Remote build instruction merging also needs Bun or Node. Saved AI profiles need
Python 3 remotely; retained-run discovery needs Python 3.7+. Continuation requires
compatible remote `opencode-source` and captured session metadata. Performance
and legacy Optimization have additional prerequisites in their linked guides.

**Save & run** asks for confirmation, saves locally, then starts a remote build.
Tools may modify remote files, use the network, access that user's credentials,
and incur costs. Automatic tool approval is requested. Use a least-privilege
account or isolated environment; the UI is not a sandbox. Read the full
[remote execution contract](../REFERENCE.md#remote-shell-requirements).

## Optional AI Features

Open **Settings** to configure Azure OpenAI, OpenAI, Claude, OpenRouter, or a local
Hugging Face model served through a loopback OpenAI-compatible API. This enables
session chat and trailing completions and selects the profile for future agent
runs. Saving settings validates their shape, not provider reachability or model
tool capability. Voice has separate credentials/configuration.

Settings does not install a local model runtime or download weights. A loopback
URL refers to the Rust host for chat/completions and the execution host for remote
runs. If those are different hosts, arrange a service on each as needed.

Keys are stored privately on the server, not encrypted at rest. Remote execution
transfers its selected profile over SSH into a private temporary file. Never put
keys in a spec, screenshot, URL, or Git commit. Completions can send **unsaved
text** to the provider. See [AI settings](../REFERENCE.md#ai-settings) for precedence,
storage, reset behavior, and environment alternatives.

## Upgrade

In an existing checkout, first inspect `git status` and preserve your own changes.
Do not force a checkout or discard work just to upgrade. Then select the release:

```sh
git fetch origin --tags
git switch --detach v0.1.12
./build.sh
```

Stop the old **local web backend** and start it again with your original workspace
and SSH settings (`./run.sh --local` for editing only). Reconnect using the newly
printed token URL. No automatic service restart occurs. Back up specs and private
`.spec-output/` records; retain access to the settings file and original remote
host/workspace for recovery. Do not publish those backups.

Already-uploaded remote runs normally survive server/browser shutdown and keep
their original supervisor behavior. Inspect them before starting new work. An
upgrade does not redeploy remote engines, migrate model runtimes, or upgrade
already-running supervisors. Releases use Git tags; package manifests still say
`0.1.0`. Use `git describe --tags --always` to identify a source checkout.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Missing `~/ip`, key, or unexpected SSH attempt | Use `./run.sh --local` for editing, or provide explicit SSH settings. |
| `cargo` not found or native linker failure | Load the Rust installation's environment, reopen the shell, and install the OS development toolchain. |
| `SPEC_COMMAND` rejected | Unset this removed local-execution variable. |
| Address already in use | Stop the old local server or select `SPEC_PORT=4781`; follow the newly printed URL. |
| Unauthorized after restart | Reconnect using the new token, not a bookmark containing an old token. |
| Autosave paused / stale revision | Preserve the draft using Download, reopen the disk version, and reconcile; repeated Save cannot resolve a stale revision. |
| `opencode-source: command not found` | Install the engine on the execution host and export its executable path from remote `~/.bash_aliases`. |
| SSH exit 255 or missing run directory | Recover/check status before retrying. Missing logs are not proof of completion. See [recovery](../REFERENCE.md#sessions-and-cancellation). |
| Model requests fail | Check the selected profile, model access/tool support, and the host making the request; saving settings is not a connectivity test. |

For developer builds and automated checks, see [Validation](../REFERENCE.md#validation).
