# Session Chat Editing

The existing session chat keeps its selected spec and nohup output context.
Press **Enter** to send a question or **Shift+Enter** to insert a new line.
IME composition does not submit. Questions remain available for retry on errors.

Select **Edit Agent.md** inside chat to create or edit the workspace's exact
`Agent.md` filename. **Save Agent.md** writes it using the existing authenticated,
revision-checked file API. The editor works even when AI chat is unconfigured.
Enter inserts normal newlines in this editor; it never sends a chat message.

Drafts stay in memory when the editor is hidden. Leaving the page warns about
unsaved edits; drafts are not persisted across reloads. A failed save retains
the draft. If another window changed the file, copy your draft before using
**Reload Agent.md**, which asks before discarding unsaved content. Saving never
overwrites a newer on-disk revision automatically.

This is an explicit user-controlled file editor, not model-side tool execution.
Saving does not automatically load `Agent.md` into AI instructions or synchronize
it into remote builds. Existing workspace tabs retain their own buffers and
revision checks, so edits in those tabs are not silently replaced.

The separate mic button opens an [OpenAI Realtime voice conversation](realtime.md).
Voice requires server-side `OPENAI_API_KEY`; Azure text chat remains independent.

## Repository Save Locking

Repository saves exclude both backend builds and `remote-build.sh` batch builds
in the same Git worktree, including sibling workspace directories and symlinks.
Normal builds can still run concurrently. Linked Git worktrees have separate
indexes and locks.

The private Git-directory `spec-harness` registry records the session directory
and operation type. A lost lock alone does not prove completion: unresolved saves
block all launches, and unresolved builds block saves. Legacy path-only records
are treated as potentially unresolved saves. Interrupted batch runs retain their
records; only a validated terminal status permits retirement. Do not delete an
unresolved record merely to retry: first establish that its work has stopped.
