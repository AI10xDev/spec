# spec

A local-first **Rust backend + Vite / React / TypeScript frontend** for writing specifications and viewing build output side by side.

This is a source-derived web rewrite of [AI10xDev/specific](https://github.com/AI10xDev/specific), the project behind the development machine's `spec` shell command. “Rust++” was clarified to mean Rust, not a separate language or C++ requirement. The new application has no Bash, Python, or Bun runtime backend. OpenCode is an **optional external execution engine**, not a Rust reimplementation of the model/provider stack.

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

Requirements: Linux, Rust/Cargo (tested with 1.98), and Bun (tested with 1.3.14). Bun is used for frontend dependency management/building only. The backend uses Unix file locking and process groups; Windows is not supported by this version.

```sh
git clone https://github.com/ai10xdev/spec.git
cd spec/frontend
bun install --frozen-lockfile
bun run build

cd ../backend
cargo run --release --locked
```

Open the **full URL printed by the server**, including `#token=…`. Production frontend assets are served by Rust from `frontend/dist`; there is no separate frontend server to start. The default address is `http://127.0.0.1:4780` and the default file workspace is `workspace/` at the repository root. Keep the printed token private.

Create `idea.md` in the left sidebar, enter text, and click **Save**. It now appears in **Saved files**, including after restarting the server. Create or open a second file to get another editor tab.

### Use existing specs

From `backend/`, select an existing **trusted, flat directory**:

```sh
SPEC_WORKSPACE="$HOME/specs" cargo run --release --locked
```

The original shell function mirrors specs into `$HOME/specs`, so this can display those previously written files directly. **This edits the selected files in place.** Back them up first if needed. This version does not automatically read `~/.local/state/spec/saved-files` or traverse unrelated paths from that history. Nested folders, hidden files, symlinks, and non-UTF-8 files are not editable.

### Optional OpenCode execution

Execution is **off by default**. To enable it, first configure a trusted OpenCode CLI with your provider/model and permission policy, then start Rust with its absolute executable path:

```sh
# Replace the executable with the trusted CLI you intend to use.
SPEC_OPENCODE=/absolute/path/to/opencode \
SPEC_WORKSPACE="$HOME/specs" \
cargo run --release --locked
```

The adapter runs `opencode run --dir <workspace> --agent build` and supplies the saved spec on stdin. It does not use a shell, enable `--auto`, request `--thinking`, or launch a command on page load. **The chosen CLI may independently auto-approve actions.** Only run trusted specs. A run can change workspace files, execute tools, access the network, and incur provider costs under that CLI's policy. Configure those controls outside this editor; this UI is not a sandbox or permission-approval client.

The process adapter is tested with a deterministic local process fixture. No live provider calls were made during validation, so compatibility with a particular provider/CLI release must be checked separately.

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
| `SPEC_OPENCODE` | unset | Absolute trusted executable; unset disables execution |

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

Browser tests start an isolated real Rust server and temporary workspace. They never use your specs or invoke a model. See [validation results](docs/REVIEW.md#validation).

## Repository layout and scope

```text
backend/       New Rust HTTP API, filesystem layer, process runner, tests
frontend/      New Vite + React TypeScript UI, unit and browser tests
docs/          Feature guide, review, security notes, screenshot
archive/       Original source collection and license notices (not executed or bundled)
workspace/     Local user files (created at runtime; gitignored)
```

The **new runtime** is Rust + TypeScript, plus HTML/CSS. `archive/` intentionally preserves legacy languages for review/provenance. Persistent V2 session steering/recovery, Azure completion/ranking, `/eval`, `/telle`, plan mode, and the terminal editor are **not ported into the web app**. This is a scoped web rewrite, not a feature-complete replacement for all original integrations.

The private repository is independently created rather than a GitHub fork-network entry. Its source ancestry and captured working-tree revisions are recorded in `archive/manifest.json`.

## License

The new application is MIT licensed. Original sources retain their own notices: `specific` MIT; Kibi MIT OR Apache-2.0; OpenCode MIT. The archived machine launcher carries provenance without an implied new license grant. See [NOTICE](NOTICE).
