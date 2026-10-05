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

## Completion boundary

Optional Azure completions are separate from SSH builds. Configuring an endpoint and key on the local Rust server enables automatic requests while typing, including unsaved text. The editor toggle disables requests for the browser page. Recent text goes to the configured provider and may incur costs; do not enable this for text that must stay entirely local. Credentials remain server-side. Anyone with the app token can invoke the configured completion provider.

The authenticated completion endpoint accepts at most 16 KiB of prefix text. It uses HTTPS, rejects redirects, limits provider responses to 64 KiB, times out after 10 seconds, and permits at most four concurrent requests. The provider cannot invoke tools through this API. Returned text is displayed as escaped, untrusted ghost text and changes the buffer only on explicit acceptance. The Responses request sets `store: false`; provider-side retention remains subject to the provider's policy. Errors do not expose upstream response bodies or credentials. No persistent completion cache is kept.

## Execution boundary

Execution is disabled unless the local server operator configures `SPEC_SSH_TARGET` and `SPEC_SSH_WORKSPACE`. Partial/invalid configuration fails startup; legacy `SPEC_COMMAND` is rejected. The browser cannot select an executable, SSH target/key, remote directory, or arbitrary command. It can request only a build of a saved revision. The web backend and editor filesystem remain local; only the snapshot and fixed build supervisor are sent over SSH.

The adapter invokes a trusted local SSH binary with batch mode, strict host-key checking, no TTY, no agent/X11/port forwarding, and connection keepalives. Operator SSH configuration, proxy commands, the selected binary, the remote account, `~/.bash_aliases`, and the remote build directory are trusted. SSH credentials stay local and build-engine provider credentials stay remote; optional editor-completion credentials are configured locally as described above. The web app does not collect private keys through its API. Establish and verify host trust separately; never disable host-key checks to resolve connection failures.

SSH executes a fixed Bash supervisor with shell-quoted operator arguments. Snapshot content is byte-counted stdin data, not command text. A complete upload is required before the build starts. Remote snapshots use `0600` files in `0700` temporary directories and are removed after process cleanup. Build input is capped at 120 KiB because some remote launchers forward the prompt as a single Linux argument; it may then be visible to same-user process inspection. The remote launcher must use an end-of-options separator for prompt arguments; launchers using Bash substitution may strip trailing newlines.

The remote child prepends the remote user's trusted `~/.local/bin` and `~/.bun/bin` to `PATH`, then sources trusted `~/.bash_aliases` with alias expansion enabled and invokes only `spec build <snapshot>`. Login profiles and interactive `.bashrc` are not loaded; custom engine paths belong in `~/.bash_aliases`. Both `SPEC_BUILD_FOREGROUND=1` and `SPEC_BUILD_AUTO=1` are set. The installed alias must support foreground execution and determines the actual approval policy. Assume automatic tool approval and the remote user's full filesystem/network authority. Restricting the adapter to `spec build` is **not** a sandbox: the build agent itself can execute arbitrary tools. UI confirmation is disclosure, not a separate tool authorization boundary. No local project tree is synchronized; build modifications stay remote.

The adapter also exports `OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS=1 OPENCODE_QUESTION_AUTO_RECOMMEND=1` after sourcing aliases. Compatible harnesses automatically select recommended answers instead of interrupting for routine questions. Actual behavior depends on the remote engine; no browser answer channel or blind-answer fallback exists. Review the spec before the single launch confirmation.

At most four attached builds run at once, one per filename. **Stop run** sends an explicit stdin control byte and waits briefly for remote process-group cleanup confirmation. EOF, SSH disconnect, and normal server shutdown detach instead of cancelling. A separate-session supervisor ignores HUP and enforces a 15-minute watchdog independently of SSH. Disconnects never fall back to local execution, but remote work may continue incurring costs; local limits do not count detached sessions. Immediate termination cannot be guaranteed through a network outage. Children that create another group, a killed supervisor, disk failure, or host failure can escape cleanup or leave stale snapshots. Closing the browser does not cancel builds.

Remote session directories under `SPEC_SSH_WORKSPACE/.spec-runs/` are owned/private (`0700`, no parent symlink); snapshots, merged output logs, and atomic exit status files use `0600`. Logs retain the first 8 MiB and drain/discard excess output. They may contain sensitive data after disconnect. Finished directories older than seven days are removed on subsequent launches; there is no background retention service or strict aggregate quota, and abnormal supervisor termination can leave artifacts requiring manual cleanup. Web records remain in-memory, with no automatic reattachment or restart. See the README for manual log/status recovery and explicit cancellation of detached sessions.

Use a dedicated OS account/container/VM and a reviewed execution policy if stronger isolation is needed. Do not run untrusted downloaded specs or expose this service to shared networks/tunnels.

## Source archive

`archive/` is historical material, not installed configuration. Its scripts preserve original behaviors and absolute paths, including auto-approval-related integration. Do not run its installers or source its shell files without independent review. No runtime inboxes, saved user documents, provider credentials, shell startup files, or logs were intentionally copied.
