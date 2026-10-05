# specific

`specific` is a portable terminal workflow for spec-driven development. It
bundles a customized [Kibi](https://github.com/ilai-deutel/kibi) editor, records
successful saves, optionally mirrors specs into one directory, and delegates a
chosen specification to OpenCode's `plan` or `build` agent.

OpenCode remains an external runtime dependency. No provider is assumed.

For the source of the development machine's active `spec` command (including its
shell integration, persistent runners, eval tools, and runtime changes), see the
[2026-09-27 live-source snapshot](live-source/README.md). This archive is separate
from the portable package and is not installed by `install.sh`.

## Screenshot Preview

### Original Screenshot

![Original spec editor screenshot showing the output pane and spec buffer](Screenshot%20From%202026-09-27%2019-13-35.png)

The repository's `Screenshot From 2026-09-27 19-13-35.png`, displayed directly
as an unmodified static image.

### Animated Preview

[![Animated overview and close-ups of the spec editor output pane and spec buffer](docs/assets/screenshot-preview.gif)](Screenshot%20From%202026-09-27%2019-13-35.png)

Generated from that same screenshot: a looping overview, output-pane close-up,
and spec-buffer close-up—not a live recording of `spec`. Click the GIF to view
the original full-resolution image.
The [preview generator](docs/assets/generate-preview.py) documents how to rebuild it.

## Runtime Model

```text
interactive Bash
└── shell startup file
    └── source specific shell integration
        ├── run_goal()
        │   └── specific-run-build
        ├── plan_goal
        │   └── specific-run-plan
        └── spec()
            ├── spec [file/options]
            │   └── customized Kibi editor
            │       ├── save original file
            │       ├── append canonical source path to save history
            │       │   └── ${XDG_STATE_HOME:-$HOME/.local/state}/specific/saved-files
            │       └── mirror saved file by basename
            │           └── ${SPECIFIC_SPECS_DIR:-$HOME/specs}/<basename>
            └── spec build [spec-file]
                ├── use explicit spec-file when supplied
                ├── otherwise read the last saved path from history
                └── run_goal <spec-file>
                    └── specific-run-build <spec-file>
                        ├── retain the caller's working directory
                        ├── validate and read the spec file
                        └── opencode run --dir <caller-directory> --agent build <spec-contents>

plan_goal [spec-directory]
└── specific-run-plan [spec-directory]
    ├── default to ${SPECIFIC_PLAN_DIR:-$HOME/specing}
    ├── recursively discover and sort files
    ├── display a numbered selection menu
    ├── read the selected specification
    └── opencode run --dir <caller-directory> --agent plan <spec-contents>
```

## Features

- Portable installation with XDG-aware defaults and no developer-specific paths.
- Terminal editing with syntax highlighting and short, inline optional completion.
- Bottom-input filename search, Azure semantic ranking, and a quick insert/open picker.
- Canonical save history and configurable basename mirror copies.
- Explicit-file or latest-saved build delegation.
- Save-and-build from the editor with live output in a left pane.
- Deterministically sorted, recursive plan selection.
- Safe handling of spaces and special characters in shell paths.
- OpenCode discovery through an override, `opencode`, or `opencode-source`.

## Filename Search in `spec` / Kibi

Start `spec` from the directory you want to explore. Press **Ctrl+:** (usually
Ctrl+Shift+semicolon; **Ctrl+T** is the fallback) to focus the **File query:** text
input below the editor. Type a filename or description, then press **Enter** or
**Ctrl+:** / **Ctrl+T** again to search. No directories are explored until you
submit the query. **Backspace** deletes a character, **Ctrl+U** clears the input,
and **Esc** cancels. UTF-8 queries are supported (up to 4096 bytes).

The editor reads directory listings recursively beneath the working directory,
not beneath the spec file's directory. Query text is separate from the document:
typing or cancelling a search never modifies your spec or marks it unsaved.

The ranked picker supports:

- **↑ / ↓**: select a result; **1–9**: jump to one of the first nine results.
- **Enter**: insert the selected relative path on a new line below the document cursor.
- **Ctrl+O**: open the selected file directly in the current Kibi editor. This
  also works while a spec session or command is running: its background build
  continues writing to its log, but the editor detaches from it so edits to the
  new file cannot enter the previous spec's inbox. Reopen the original spec to
  restore its session. Binary/non-UTF-8 files and files larger than 2 MiB are
  rejected; a failed open preserves both the buffer and session attachment.
- **Ctrl+S**: save the current document without leaving the picker, then press
  **Ctrl+O** to open the selected result. Unsaved edits are never discarded.
  An unnamed document must first be saved via Esc, Ctrl+S, then searched again.
- **Esc**: dismiss the picker without changes.

Exact filename/path matches come first, followed by exact stems and filename
prefixes. Remaining candidates are ranked by Azure using the **`gpt-6-astra`**
deployment by default. Set `KIBI_FILENAME_MODEL` to override its deployment name;
this setting is independent of the inline completion deployment. The ranker uses
`AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, and (for legacy Azure endpoints)
`AZURE_OPENAI_API_VERSION` from the environment or the same `KIBI_ENV_FILE` dotenv
file used by completions. Both Azure Responses and legacy Chat Completions
endpoints are supported. Python 3 is required for semantic ranking.

```bash
export KIBI_FILENAME_MODEL=gpt-6-astra
spec feature.md
# Example query line: authentication configuration
```

Only the query and up to 200 relative filenames are sent to Azure—never file
contents. This makes a model request when non-exact/non-prefix candidates need
ranking. Exact/prefix-only lists need no request. If Azure is unavailable or
returns an invalid selection, the picker explicitly says **Local ranking only**
and uses local token/fuzzy matches; it does not claim those were model-ranked.

Search runs in the background. Any key pressed while it is running dismisses the
pending results and continues normal editing, preventing stale insertions. Only
one request can be outstanding. Discovery is bounded to 50,000 entries, 32 nested
directory levels, and approximately two seconds of scanning; API I/O has a
20-second timeout. At most 20 results are displayed. Truncated/unreadable searches
are labelled partial. Dependency/build/cache directories (including `.git`,
`node_modules`, `target`, `dist`, `.venv`, and `.cache`) are skipped, symlinks are
not followed, and control-character/non-UTF-8 filenames are excluded. Other dotfiles
are included. This is not a full `.gitignore` implementation.

### Terminal compatibility

**Ctrl+T** is the portable fallback. Kibi recognizes CSI-u sequences `ESC[58;5u`,
`ESC[58;6u`, and `ESC[59;6u`, and xterm modified-key sequences for Ctrl+colon.
Legacy terminals sending byte 26 also work (indistinguishable from Ctrl+Z).
If your terminal swallows Ctrl+:, configure that key to send `\x1b[58;6u`, or
use Ctrl+T. Kibi does not globally enable an extended keyboard protocol.

## Platforms

The workflow targets Linux and other Unix-like systems with Bash 4 or newer.
Shell integration is specifically written for interactive Bash. CI validates on
Linux. Kibi also contains upstream platform support, but this installer and the
shell workflow are not designed for native Windows shells.

## Prerequisites

- Bash 4+
- `nohup` (normally provided by coreutils)
- Git
- Rust and Cargo compatible with the `rust-version` in `editor/Cargo.toml`
- Python 3, used by optional completion and portable plan-file discovery
- OpenCode available as `opencode`, `opencode-source`, or through
  `SPECIFIC_OPENCODE_BIN`

For development checks, install Bats and ShellCheck as well.

## Installation

```bash
git clone https://github.com/AI10xDev/specific.git
cd specific
./install.sh
source "${XDG_DATA_HOME:-$HOME/.local/share}/specific/shell/specific.sh"
```

The default prefix is `${XDG_DATA_HOME:-$HOME/.local/share}/specific`; command
links go to `${SPECIFIC_BIN_DIR:-$HOME/.local/bin}`. Ensure the latter is on
`PATH`. Override locations when needed:

```bash
./install.sh --prefix "$HOME/tools/specific" --bin-dir "$HOME/bin"
export SPECIFIC_HOME="$HOME/tools/specific"
source "$SPECIFIC_HOME/shell/specific.sh"
```

The installer never edits startup files by default. `--configure-shell`
idempotently appends its exact source line to `~/.bashrc`. Run `./install.sh
--help` for all options. See [Quick Start](QUICK_START.md) for the shortest path
to a first build.

## Usage

```bash
spec                         # open an unnamed buffer
spec feature.md              # open or create a file
spec -- build                # edit a file literally named build
spec build feature.md        # send an explicit file to the build agent
spec build                   # send the final save-history entry
plan_goal                    # select recursively from the default plan directory
plan_goal "$HOME/my plans"   # select from an explicit directory
```

`run_goal <spec-file>` remains available as a compatibility function and calls
the portable build runner.

### Editor Commands

| Shortcut | Action |
| --- | --- |
| `Ctrl+R` | Save and build the current spec; Save As prompts for an unnamed buffer |
| `Ctrl+E` | Prompt for an arbitrary shell command and run it with `bash -c` |
| `Ctrl+K` | Remove the current line (formerly `Ctrl+R`) |
| `Ctrl+Q` | Quit the editor, leaving background jobs running |

Builds and shell commands stream live output to the left pane, never into the
text buffer. The pane auto-tails a bounded number of lines and discards older
output; manual output scrolling is not available. The editor prevents overlapping runs.
`Ctrl+R` builds are noninteractive and start only after a successful save.
Both shortcuts launch jobs with `nohup` in a separate session, with stdin closed.
Combined stdout/stderr appends to `<filename>.out` in the directory where you
launched `spec`, even when the spec lives elsewhere (for example, `plan.md.out`).
An unnamed buffer uses `untitled.out`. New logs are private (mode `0600`), and
the status bar shows the path at launch. The pane follows only the new run's
output. Jobs and their logs survive editor exit or terminal hangup; logs are
not automatically removed or size-limited by the editor.

`spec` supplies `KIBI_RUN_COMMAND` as the resolved path to `specific-run-build`,
unless you provide a nonempty override. It is an **executable path, not a shell
command string**; the editor passes the saved filename as a single argument.
Paths containing spaces are supported. Use an executable wrapper for custom
arguments or build logic. `Ctrl+E`, by contrast, accepts shell syntax.

`spec build [spec-file]` and `run_goal` retain their portable foreground behavior
and do not use `KIBI_RUN_COMMAND`.

### Saves And History

`Ctrl-S` first saves the original file. After that succeeds, the editor:

1. Canonicalizes the original path and appends it to `saved-files`.
2. Creates the configured mirror directory when necessary.
3. Writes the current content to `<mirror-directory>/<basename>` unless that is
   the original file itself.

A mirror failure is shown in the status bar but does not turn the original save
into a failure. History is append-only: repeated saves create repeated entries.
`spec build` uses the most recently appended entry, not modification time.

Mirror copies intentionally use only the basename. Sources with the same
basename overwrite the same mirror target. History can become stale when a
source is moved or deleted; the build shortcut detects this before OpenCode runs.

## OpenCode Delegation

Runners locate OpenCode in this order: `SPECIFIC_OPENCODE_BIN`, `opencode` on
`PATH`, then `opencode-source` for local-development compatibility. They read the
entire selected spec and pass it as one prompt argument to `opencode run`.

Both runners preserve the directory from which they were invoked via `--dir`.
This matters because project-local OpenCode configuration, provider/model
selection, agent permissions, and tool availability can depend on that target
project. The runner does not change those settings.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `SPECIFIC_HOME` | Installation location used by shell integration | `${XDG_DATA_HOME:-$HOME/.local/share}/specific` |
| `SPECIFIC_BIN_DIR` | Installed command-link directory | `$HOME/.local/bin` |
| `SPECIFIC_SPECS_DIR` | Mirror destination | `$HOME/specs` |
| `SPECIFIC_STATE_DIR` | State and history directory | `${XDG_STATE_HOME:-$HOME/.local/state}/specific` |
| `SPECIFIC_PLAN_DIR` | Default plan source directory | `$HOME/specing` |
| `SPECIFIC_OPENCODE_BIN` | Explicit OpenCode executable | auto-detected |
| `KIBI_RUN_COMMAND` | Editor build executable path, not a shell string | resolved `specific-run-build` |
| `KIBI_ENV_FILE` | Optional completion environment file | nearest `.env` when present |
| `AZURE_OPENAI_ENDPOINT` | Optional completion endpoint | unset |
| `AZURE_OPENAI_API_KEY` | Optional completion credential | unset |
| `AZURE_OPENAI_API_VERSION` | Legacy Azure API version | unset |
| `DEPLOYMENT_NAME` | Completion deployment | `gpt-5.5` |

The shell wrapper owns the supported save settings and translates them to the
editor's internal `KIBI_SAVE_COPY_DIR` and `KIBI_SAVE_HISTORY_FILE` variables.
See [Configuration](docs/CONFIGURATION.md) for details.

### Optional Azure Completion

Completion is optional and independent from OpenCode delegation. Leave the
Azure variables and `KIBI_ENV_FILE` unset to omit it. To enable it, use process
environment values or a local ignored file:

```bash
export AZURE_OPENAI_ENDPOINT="https://example-resource.openai.azure.com"
export AZURE_OPENAI_API_KEY="replace-with-your-key"
export AZURE_OPENAI_API_VERSION="replace-with-supported-version"
export DEPLOYMENT_NAME="replace-with-deployment"
```

The editor limits displayed completion to one inline suffix of at most 160
characters. Never commit a completion environment file.

## Repository Architecture

- `bin/`: strict-mode build and plan runners.
- `shell/`: interactive Bash functions.
- `editor/`: customized Kibi source, tests, syntax definitions, and licenses.
- `tests/`: Bats integration tests with fake external commands.
- `docs/`: design and configuration details.
- `install.sh`: idempotent source build and installation.

See [Architecture](docs/ARCHITECTURE.md) for component boundaries and data flow.

## Development And Testing

Run the same checks as CI:

```bash
cargo fmt --check --manifest-path editor/Cargo.toml
cargo clippy --manifest-path editor/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path editor/Cargo.toml
bats tests
shellcheck install.sh shell/specific.sh bin/*
```

Before a release, run an installation smoke test with temporary `HOME`, prefix,
and bin directories; inspect tracked files for credentials and generated
artifacts; tag the tested commit; and publish source archives. Generated editor
binaries do not belong on the default branch.

## Troubleshooting

**OpenCode is missing:** Install the OpenCode CLI, put `opencode` on `PATH`, or
set `SPECIFIC_OPENCODE_BIN` to an executable. `opencode-source` is only a fallback.

**No save history exists:** Save a file with `Ctrl-S` from an editor launched by
`spec`, or call `spec build <file>` explicitly.

**The latest history entry is stale:** The source was moved or deleted. Open and
save its new path, remove stale local history entries, or pass the current path.

**Rust or Cargo is missing:** Install a Rust toolchain that satisfies
`editor/Cargo.toml`, then rerun `./install.sh`.

**`spec` is not found:** It is a shell function, not a standalone link. Source
`$SPECIFIC_HOME/shell/specific.sh` in the current Bash session and add that line
to the appropriate Bash startup file.

**Commands are not found:** Add `SPECIFIC_BIN_DIR` (default `$HOME/.local/bin`)
to `PATH`, or let shell integration resolve runners directly from `SPECIFIC_HOME`.

## Security And Privacy

- Build and plan send the complete selected specification as the OpenCode prompt
  to whatever provider your OpenCode configuration selects.
- Project-local OpenCode settings may change the provider, model, permissions,
  and tools used by an agent. Review them before delegation.
- `.env` files, keys, credentials, logs, history, saved specs, and generated
  binaries are ignored and must never be committed.
- Save history is local state. It contains canonical paths to files on your
  machine.
- Shell code quotes paths and does not use `eval`.

## Licensing And Attribution

New shell integration, installer, tests, and documentation are MIT licensed; see
[LICENSE](LICENSE). The editor derives from Kibi by Ilaï Deutel and contributors,
licensed under MIT OR Apache-2.0. Its original [copyright](editor/COPYRIGHT),
[MIT license](editor/LICENSE-MIT), and [Apache license](editor/LICENSE-APACHE)
are preserved. See [NOTICE](NOTICE).

OpenCode is MIT licensed and remains an external dependency; no OpenCode source
is included in this repository.
