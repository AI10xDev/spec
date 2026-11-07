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

## Guided Setup

Starting with v0.1.13, releases include a conversational CLI wizard. From the
release checkout:

```sh
./setup.sh
```

Python 3.9+ is the only additional wizard dependency; no Python packages or AI
service are needed. The existing `./run.sh --local` path remains unchanged.
The wizard checks Linux, Bash, Git, native `cc`, GNU coreutils, Rust/Cargo 1.98+,
and Bun 1.3.14+ or Node.js 22.12+ with npm. These Rust/Bun versions are the tested
baseline, not a claim that all older releases fail. It discovers existing
`~/.cargo/bin` and `~/.bun/bin` installations when absent from `PATH`, but never
installs or upgrades system software for you. Missing tools include remediation
guidance; you can save setup and install them before launching.

The interview uses free-text prompts, not numbered choices or arrow-key menus:

- Describe your workflow and constraints in a multiline input area. A blank line
  finishes it. Notes stay local and are never executed or sent to a model.
- Confirm concrete settings: local spec directory and loopback port. Enter uses
  `~/specs/` (outside the checkout) and `4780`. Select your previous workspace
  explicitly if you already have specs elsewhere. Prose is not silently converted into
  commands; custom requirements are retained in `requirements.txt` for review.
  If `~/specs/` has unsafe permissions or is not a directory, the wizard suggests
  `~/specs-private/` (with a suffix if necessary) without changing existing files.
- For optional builds, enter an SSH alias or `user@host`, local key path (default:
  SSH agent/config), and absolute remote project directory. There is no inferred
  host, developer-specific key, or assumed remote project path.
- Optionally describe your AI provider, for example `I use OpenAI` or
  `Azure OpenAI`, then enter its model/deployment, endpoint, version, and hidden
  key. OpenAI, Azure, Claude, OpenRouter, and local Hugging Face are supported.
  Provider/model defaults match the app's Settings, not guaranteed account access.
- Azure voice is asked independently: resource origin, Realtime deployment,
  and hidden key. A local model runtime, remote coding engine, and
  OpenAI Realtime account are not installed/configured here.
- Review the proposed settings and dependency checklist. Saving defaults to no.
  Downloading/building/starting requires a second, separate confirmation.

The intro reuses Computeruse's colored title reveal and moving progress bar.
`NO_COLOR` disables colors. Non-TTY output and `TERM=dumb` use static output;
`--no-animation` explicitly disables animation. No terminal selection UI is needed.

```sh
./setup.sh --check         # Read-only local dependency check; exit 1 if incomplete
./setup.sh --dry-run       # Full interview/review, no save, launch, SSH or downloads
./setup.sh --no-animation  # Normal interview with static output
bash "$HOME/.spec-setup/start.sh"  # Reuse saved setup without repeating the interview
```

The generated launcher calls the existing `run.sh`, using `--local` unless you
configured SSH. On launch it downloads frontend/Rust dependencies, builds, and
starts the loopback server. With SSH it also checks the connection and can create
the configured remote directory. It never installs a system service or starts a
coding run. Follow the full printed `#token=...` URL and stop with Ctrl+C.

### Private Files And Reruns

The default `~/.spec-setup/` directory is outside the checkout and created with
mode `0700`. Keeping secrets out of the checkout also supports group-writable
source trees without weakening the backend's private-storage requirements.
The launcher is `0700`; notes, optional `profile.json`, and optional `voice.env`
are `0600`. API keys are **plaintext protected by filesystem permissions, not
encrypted**. They never appear in the launcher or review output. Hidden key
input fails rather than falling back to echoing; use a private terminal. Do not
put secrets in the general free-text answers or publish generated setup files.

Choosing `later` leaves existing AI/voice files untouched and inherits the launch
environment plus workspace-default profile/dotenv settings. It does not disable
AI. **A new setup does not import profiles from a previous wizard's launcher.**
Reuse that launcher to keep its chosen files; their path exports do not persist
in your parent shell after stopping it. Choosing a new profile selects its
private file via `SPEC_SETTINGS_FILE`, without overwriting the old profile. A new
voice file is selected via `SPEC_AZURE_REALTIME_ENV_FILE`; the generated launcher
clears inherited Azure voice fields so that the new file takes effect. Other AI
environment settings still follow the existing precedence rules. The launcher
also clears obsolete `SPEC_COMMAND` and custom SSH/UI binary/path overrides.

No provider connectivity, model availability, or remote engine is verified during
setup. Configured cloud features can send unsaved text/audio and incur costs when
used. Remote tools can change files; read the remote prerequisites below.

Existing setup directories are never overwritten. To make a different setup,
choose a **new private directory outside the spec workspace, frontend source/assets,
and backend build output**:

```sh
./setup.sh --output-dir "$HOME/.spec-setup-work"
```

The parent directory must already exist with trusted ownership/permissions and
without symlink ancestors. Custom destinations are not automatically Git-ignored.
Spec workspaces also cannot live in frontend assets or backend build output:
builds can publish or clear these locations.
Cancel before saving to leave configuration untouched. An interrupted write may
leave a partial directory for inspection; the launcher is written last. To remove
a setup, remove only its generated directory after backing up any configuration
you need. This does not delete spec files or uninstall dependencies.

Wizard regression checks (offline; no real credentials or SSH):

```sh
python3 -B -m unittest discover -s scripts -p 'test_setup*.py'
bash -n setup.sh
```

## Install A Release

From a directory where you keep source checkouts:

```sh
git clone --branch v0.1.14 https://github.com/AI10xDev/spec.git
cd spec
unset SPEC_COMMAND
./run.sh --local
```

This selects the release tag in detached-HEAD mode. Use `git switch -c my-work`
before making your own source commits. For the latest development branch instead,
clone without `--branch v0.1.14`. If GitHub requests authentication, authenticate
with an account that has repository access; never embed tokens in clone URLs.

Alternatively, download **Source code (tar.gz)** or **Source code (zip)** from the
[release page](https://github.com/AI10xDev/spec/releases/tag/v0.1.14), extract it,
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
git switch --detach v0.1.14
./build.sh
```

Stop the old **local web backend** and start it again with your original workspace
and SSH settings (`./run.sh --local` for editing only). Reconnect using the newly
printed token URL. No automatic service restart occurs. Back up specs and private
`.spec-output/` records; retain access to the settings file and original remote
host/workspace for recovery. Do not publish those backups.

Version v0.1.14 adds agent memory at `POST /api/memory/graphql`. Back up the
entire `.spec-output/` directory, including JSON records and `memory.sqlite3`.
Existing local jobs are indexed on history queries without rerunning them;
unknown historical times and missing reports remain explicit. New reporting
instructions apply only to builds and continuations launched after upgrading.
See [Build memory](BUILD_MEMORY.md) for query examples and evidence limits.

For wizard-based installations upgraded in place, reuse
`bash "$HOME/.spec-setup/start.sh"` (or your custom setup launcher). It restores
the selected workspace, SSH settings, `SPEC_SETTINGS_FILE`, and private Azure
voice-file selector; calling `./run.sh --local` directly does not restore those
exports. A saved launcher contains an absolute checkout path. If you extracted
the release into a new directory, create a new setup or deliberately update the
launcher to use that checkout while preserving your private settings.

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
