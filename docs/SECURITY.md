# Security model

This is a **single-user local editor**, not a multi-tenant service or execution sandbox.

## HTTP and browser boundary

- Rust binds only to `127.0.0.1`.
- All API routes require a random bearer token generated for each server process.
- The printed URL carries the token in its fragment, which is not sent as an HTTP request target. The browser removes the fragment and keeps the token in tab session storage.
- API responses carry `Cache-Control: no-store`. No permissive CORS headers are configured.
- Production static responses include a self-only Content Security Policy, frame-ancestor protection, MIME sniffing protection, and no-referrer policy.
- React escapes displayed filenames/errors. Output is plain text in a `pre`, not HTML.
- Vite development mode is for local development; the Rust production headers do not control Vite's HTML responses.

Anyone with the token can edit files and, if enabled, invoke the trusted execution engine. Do not publish the token, terminal output containing it, browser storage, or URLs containing the fragment. The token is not a replacement for OS account isolation. There is no TLS, multi-user authorization, token revocation API, or login session management.

## Filesystem boundary

The operator selects one trusted directory. The app rejects paths, hidden names, and control characters. Reads reject symlinks and nonregular files using Unix descriptor flags/type checks. Writes use atomic replacement and a content-revision comparison. A workspace lock prevents two cooperative server processes from serving the same directory simultaneously. Group/world-writable workspaces are refused.

This boundary assumes the directory and its ancestors are controlled by the server user and are not concurrently renamed or modified by hostile local processes. Same-user software can change files outside the editor's cooperative lock; revision checks detect ordinary changes, not every possible check/write race. The editor is not safe against a malicious local process with the user's filesystem authority.

Files are at most 2 MiB; listing is capped at 10,000 visible files. The JSON request limit allows UTF-8 escaping overhead. Output is at most 256 KiB per run, 32 retained runs total. File operations are synchronous local filesystem operations; do not use an untrusted or potentially blocking network/FUSE filesystem.

Atomic replacement writes private `0600` files and does not preserve executable bits, custom ACLs, inode identity, or hard-link relationships. No deleted-file recovery or revision backup exists. Keep independent backups.

## Execution boundary

Model execution is disabled unless the operator sets `SPEC_COMMAND` to an absolute trusted `spec` shell launcher. The API never accepts executable paths or arbitrary shell commands from the browser. The backend invokes the launcher directly with `build` and a private snapshot path as separate arguments, without shell interpolation. Snapshots use `0600` files in `0700` temporary directories and are removed after process cleanup (an abrupt server kill may leave a temporary snapshot). Build input is capped at 120 KiB because the existing launcher subsequently forwards the prompt as a single argument to OpenCode, after `--`; that argument may be visible to same-user process inspection. Bash command substitution in the launcher strips trailing newlines.

The external CLI and its model tools run with the server user's privileges and inherited environment. Existing provider credentials and permission policies may be used. The adapter sets `SPEC_BUILD_AUTO=1` to keep the existing launcher in the foreground; that branch explicitly enables OpenCode `--auto` and automatic tool approval. UI confirmation is disclosure, **not** a separate tool authorization boundary. No cloud keys are managed by the web app itself.

At most four processes run at once, one per filename. Cancellation/timeout terminates the owned process group; normal shutdown requests cancellation. Detached processes that create another group, fatal server crashes, SIGKILL, or machine failure can escape orderly cleanup. There is no durable process recovery, job registry across restarts, or automatic restart.

Use a dedicated OS account/container/VM and a reviewed execution policy if stronger isolation is needed. Do not run untrusted downloaded specs or expose this service to shared networks/tunnels.

## Source archive

`archive/` is historical material, not installed configuration. Its scripts preserve original behaviors and absolute paths, including auto-approval-related integration. Do not run its installers or source its shell files without independent review. No runtime inboxes, saved user documents, provider credentials, shell startup files, or logs were intentionally copied.
