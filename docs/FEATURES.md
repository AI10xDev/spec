# Vite version: feature guide

## 1. Connect to your local workspace

Start the Rust server and open its printed URL. The fragment supplies a per-process access token; the UI removes the fragment from the address bar and stores the token in the current tab's session storage. You can also paste the token into the connection form. Restarting Rust rotates the token: use its new URL.

The editor's files are on the server machine, not uploaded to an application cloud. If you enable OpenCode, that external tool may send prompts and tool context to its configured provider. Optional Azure trailing completions send recent editor text, including unsaved text, to the configured Azure provider.

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

Open-tab layout and unsaved buffers are intentionally **not persisted in browser storage**. Save or download before leaving. Closing a tab does not cancel its running process; reopen the file in the same browser page to view its output again.

## 4. Two-pane editor and output view

On desktop, **Spec** occupies the left pane and **Output & logs** the right. Both remain visible while switching editor tabs. On narrow screens they stack vertically to keep each readable.

The spec editor is a plain UTF-8 textarea with spellcheck disabled. It supports native text selection, clipboard operations, and browser textarea undo. It is not Monaco, an IDE, a terminal emulator, or a syntax-aware language server.

With [Azure completion configured](../README.md#trailing-sentence-part-completions), **Trailing completions** offers muted ghost text after 500 ms idle at a line's end. It completes the current word or sentence part, stopping at the first clause/sentence boundary, up to 160 characters. Press **Tab** or click **Accept part** to insert it; press **Escape** to dismiss until the next edit. Acceptance also waits for the next edit before suggesting another part, even without final punctuation. The toggle disables provider requests across editor tabs; editing works without any provider configuration.

Suggestions never modify saved/downloaded text until accepted. Selection, composition, blur, and tab switches clear them; stale requests cannot replace a newer suggestion. Existing text after the caret on the same line suppresses completion. The ghost stays on one visual line, clipped to the pane; its full suffix is in the Accept part tooltip. Native undo includes accepted text in supported browsers; browsers without `insertText` support use a direct insertion fallback. Provider errors appear beside the toggle, without blocking saves or launching a build.

The output pane is associated with the active filename and shows the latest run started for that file by this browser page. Available stdout and stderr appear as plain text, not executable HTML or interpreted terminal escape sequences. Available tool logs and concise explanations can be shown; hidden model reasoning is not requested. The run adapter does not pass `--thinking`.

## 5. Save, conflicts, and download

Click **Save** or press **Ctrl+S / Cmd+S** while focused in the editor. The Rust API writes a temporary file, syncs it, atomically replaces the destination, and syncs the workspace directory. Files written by the app have mode `0600`.

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
3. The local server checks the saved revision and uploads an immutable snapshot over SSH. A fixed remote supervisor writes a private temporary snapshot, sources the remote `~/.bash_aliases`, and invokes `spec build <snapshot-file>` in the remote build directory with `SPEC_BUILD_FOREGROUND=1 SPEC_BUILD_AUTO=1`. It also exports `OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS=1 OPENCODE_QUESTION_AUTO_RECOMMEND=1` and clears persistent-session variables. Automatic approval and recommended question answers are requested to minimize runtime prompting; actual behavior depends on the installed alias/engine. Unsupported questions are not blindly answered. Builds are limited to 120 KiB (local saving still supports 2 MiB). Other local files are not synced, and build changes remain remote.
4. The right pane follows output. Disable **Follow output** to keep your scroll position.
5. **Stop run** sends an explicit control byte to request remote process-group cancellation and snapshot cleanup. EOF or SSH disconnect only detaches the log viewer.

A failure to launch the local SSH client is reported immediately. SSH connection/authentication failures and remote startup errors appear in the run output as failures. Process exit status is shown as completed or failed; completion means **CLI exit success**, not independent verification that generated software is correct. Snapshot creation must succeed before launch; the snapshot is removed after process cleanup. Some remote launchers strip trailing newlines when reading the prompt.

### Run limits and lifecycle

- At most one attached active run per filename and four attached active runs in total; detached remote builds do not count toward these local limits.
- Latest 256 KiB of output per retained run. Truncation is explicitly indicated.
- At most 32 runs retained server-side; oldest finished runs are evicted.
- Polling approximately every 650 ms for the visible active run; slower retry on fetch errors.
- An independent fifteen-minute remote watchdog survives disconnect. The local attachment times out fifteen seconds later. Network loss may prevent Stop confirmation.
- Ctrl+C/SIGTERM detaches on normal server shutdown; uploaded builds continue remotely.
- Closing a browser page does not stop execution.
- Web run records are **in-memory**. Browser reload loses run associations; server restart loses local run records/output. Remote sessions retain private `output.log` (first 8 MiB) and atomic exit `status` under the remote workspace's `.spec-runs/`. Completed sessions older than seven days are pruned on subsequent launches. See [manual recovery and cancellation](../README.md#sessions-and-cancellation); automatic reattachment, replay, and session steering are not implemented.
- Tools that detach into separate process groups may escape group cancellation. Use OS-level sandboxing for stronger containment.

## 7. What changed from the original

| Original capability | Web rewrite |
| --- | --- |
| Terminal Kibi editor | Browser-based TypeScript textarea editor |
| One visible spec at a time | Multiple independent editor tabs |
| Newline-delimited save history | Workspace file listing with filtering and timestamps |
| Spec/output split | Desktop two-pane view; stacked mobile view |
| Background shell build | Opt-in remote foreground build over SSH; local web server, bounded output, cancellation |
| Basename mirror saves | No mirroring; saves only the named workspace file |
| Persistent V2 session inbox | Not ported; one-shot runs only |
| Azure inline completion/filename ranking | Optional sentence-part trailing completions; filename ranking not ported |
| `/eval`, `/telle`, legacy eval, plan picker | Not ported |
| Terminal keybindings/syntax highlighting | Not ported; browser editing and save shortcut only |

## 8. Safety and privacy

Only the server owner should have the token. This is a single-user local application, not a hosted multi-user service. Do not expose it through a public reverse proxy or shared tunnel. Keep the workspace trusted and back up important files. Running a model is a separate, explicitly enabled operation with the chosen CLI's existing privileges and policy. See [SECURITY.md](SECURITY.md).
