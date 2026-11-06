# Computeruse Shared Instructions

The editor can share one UTF-8 instruction file between the local Spec server
and its SSH remote, then call [AI10xDev/computeruse](https://github.com/AI10xDev/computeruse)
on the **local server computer**. This is explicit bidirectional push/pull, not a
filesystem mount, background watcher, or source-tree synchronization service.
It does not install computeruse or configure a desktop capture session.

## Configure

Run the Spec server in the user's local desktop session. Configure its existing
`SPEC_SSH_TARGET`, `SPEC_SSH_WORKSPACE`, and optional `SPEC_SSH_KEY` as usual.
The remote needs Python 3. The bridge uses the same strict SSH host-key policy
as spec builds; verify the host key before starting the server.

Export all three variables below in the **server process environment** before
starting `./run.sh` without `--local`. These are not AI Settings fields and are
not loaded from the AI-only `.env` file. Substitute your own absolute paths:

```sh
export SPEC_COMPUTERUSE_LOCAL_FILE=/home/alice/shared/instructions.txt
export SPEC_COMPUTERUSE_REMOTE_FILE=/home/builder/shared/instructions.txt
export SPEC_COMPUTERUSE_COMMAND='["/usr/bin/python3","/home/alice/computeruse/scripts/computeruse-wayland.py","{instructions}","--","--max-steps","5"]'
```

Create each file's parent directory on the corresponding computer first. Use
directories owned by that user (or root), not writable by group/others, without
symlinks in their paths. A private directory beneath `/tmp` is allowed, but
`/tmp/instructions.txt` directly is not. The data files may initially be absent;
existing files must be regular, single-link UTF-8 files, without NUL bytes and
no larger than 2 MiB. Writes replace files atomically with mode `0600`.

`SPEC_COMPUTERUSE_COMMAND` is a JSON argument array, not shell syntax. Its first
element must be an absolute executable path; exactly one other element must be
`{instructions}`. That placeholder receives a private **immutable snapshot** of
the successfully shared editor revision, not the mutable shared path. Later
saves cannot change the instructions of an already-running callback. Quotes,
spaces, and shell-looking text in the document are data, never shell commands.
The callback inherits the Spec server's environment and working directory; use
absolute paths for callback resources.

The example uses computeruse's Wayland launcher, which requires a supported
active Wayland session and capture/input dependencies. For a separately prepared
live-frame directory, the native CLI can instead be configured as:

```sh
export SPEC_COMPUTERUSE_COMMAND='["/home/alice/.local/bin/computeruse","agent","--instructions","{instructions}","--frames","/home/alice/live-frames","--max-steps","5"]'
```

Neither example enables input injection. Add `--execute` to the trusted argv
only when you intend to authorize desktop control. **Dry-run can still send
instructions and screenshots to a model and incur costs.** This is not local
inference merely because the callback is local. The bridge never inserts
`--execute` or sends the web app's saved AI profile to computeruse. Configure
computeruse's provider independently in the local server environment.

Unset all three variables to disable the integration. Partial or invalid
configuration fails server startup rather than silently falling back. Restart
the server after configuration changes.

## Editor Workflow

1. Open or create an instruction document. Click **Computeruse: off** to enable
   shared-file mode for that tab. Confirm the destination overwrite: the editor
   is saved locally and pushed to both shared files, but nothing executes.
2. If the remote file already has instructions you want to keep, cancel enabling,
   save or download local edits, and use **Reload remote** first. This pulls the
   remote text into the editor and local shared file without executing anything.
3. While the button says **Computeruse: on**, explicit **Save** and Ctrl/Cmd+S
   update both shared files. Autosave still updates only the editor workspace.
4. **Save & run** or Ctrl/Cmd+Enter asks for confirmation, saves and shares the
   exact editor snapshot, and launches the local callback only after successful
   synchronization. It does not submit or queue a remote spec build.
5. Inspect the separate **Computeruse output** and callback status. Use
   **Stop computeruse** to request local process-group termination.
6. Toggle the button off to restore ordinary spec Save & run. This does not stop
   an existing callback. Mode belongs to one tab and resets on page reload;
   switching to another tab does not silently redirect that tab's builds.

Only one callback can run at a time. Saving and pulling remain possible while
it runs because its instruction snapshot is independent. Reload is disabled
while the editor has unsaved changes; edits typed during a remote read are
preserved as unsaved text. Existing spec queues and Performance runs are separate
and are not cancelled or paused by enabling computeruse.

## Conflicts And Lifecycle

The bridge compares the saved editor revision and the last observed remote
SHA-256 revision. A stale revision rejects synchronization rather than silently
retrying against newer text. Resolve a conflict by comparing the remote text
and your saved/downloaded edits, then explicitly pulling or toggling off/on to
review and authorize a replacement. Do not repeatedly click Save & run to
resolve an uncertain response.

There is no distributed transaction across SSH and the local filesystem. For
example, an SSH acknowledgement may be lost after the remote replacement, or
the remote save may succeed while the local replacement fails. Errors identify
partial/uncertain destinations and instruct you to compare them; no callback
is launched when synchronization reports failure. A lost HTTP response is
different: an **accepted request continues on the server**, including its
callback, even if the browser disconnects. Check callback status before retrying.
There is no durable exactly-once replay key.

Both shared-file writers use an exclusive `flock` on a persistent sidecar named
`.computeruse-lock-<sha256-of-UTF-8-basename>` in the file's parent directory.
For concurrency protection, external writers must take this same lock before
reading/checking a revision, hold it through atomic replacement and directory
`fsync`, then release it. Create the single-link regular sidecar with mode
`0600`, without following symlinks or truncating it. Never delete or replace the
sidecar or lock the replaceable data inode instead. Ordinary editors that do
not participate can still race the revision check and overwrite; coordinate
manual edits rather than relying on a hash check as a filesystem transaction.
Use the Spec API for coordinated editor-workspace saves.

Callback logs retain the latest 256 KiB and only the most recent callback.
They are in memory, not durable history. Closing the page does not stop a run;
graceful server shutdown cancels it. A callback has a 24-hour maximum lifetime.
Stop signals its process group with TERM then KILL; a callback must stay in that
group and must not daemonize or detach children into new sessions. This is
process management, not a sandbox or guaranteed desktop emergency stop.

## API

All endpoints require the existing server bearer token. The browser cannot
select arbitrary callback commands or shared paths.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/computeruse` | Configuration availability, paths, latest callback status and output |
| `GET /api/computeruse/file` | Remote `{content, revision}`; absent file has empty content and null revision |
| `POST /api/computeruse/push` | `{name, revision, remote_revision}`; sync saved editor text without launching |
| `POST /api/computeruse/run` | Same request; sync then launch; response adds `run` |
| `POST /api/computeruse/pull` | `{name, revision}`; pull remote into editor/local mirror, returning a document |
| `POST /api/computeruse/runs/{id}/cancel` | Stop that local callback, not a spec build |

`GET /api/config` includes the boolean `computeruse` capability. Revisions are
SHA-256 hex digests of exact UTF-8 bytes; the first push to an absent remote
uses `remote_revision: null`.

## Validation

Tests use isolated temporary files, a local SSH fixture, and inert callbacks:

```sh
# From backend/
cargo test computeruse -- --test-threads=4
python3 -B -m unittest discover -s src -p computeruse_file_test.py -v

# From frontend/, after building the backend binary
bun run build
bun run test:e2e e2e/computeruse.spec.ts
```

These tests do not validate a physical desktop, real SSH host, model provider,
or the installed computeruse binary. Verify those separately with non-sensitive
instructions and input injection disabled before enabling desktop control.
