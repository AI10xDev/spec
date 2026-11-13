# Spec Feature Report

Date: November 4, 2026. Scope: the current source in `/home/opencode/spec`, including uncommitted changes. This report describes implemented capabilities and their operating boundaries only. It is based on source and test inspection, not a fresh test run or live SSH, model-provider, or microphone validation. Azure voice is undergoing an uncommitted replacement; its description below follows the current implementation rather than older release documentation.

## Product Overview

Spec is a local-first browser workspace for writing task specifications, saving them as text files, and viewing associated coding-agent output. A Rust server serves the React interface and authenticated API. Editing works without an AI account. Optional integrations add writing suggestions, contextual chat, voice, remote coding runs, repository-save jobs, analytics, optimization, and Performance sessions.

The browser, server, and editable spec directory remain local. Coding runs execute on a separately configured SSH host. A build uploads the spec snapshot, not the local project's source tree; generated code remains in the remote project.

Sources: [server routes](../backend/src/main.rs#L1196), [SSH configuration](../backend/src/remote.rs#L42), [workspace interface](../frontend/src/main.tsx#L730).

## Workspace And Files

- **Saved-file browser.** Lists files in the selected workspace with modification times and byte sizes, newest first. Users can filter names and explicitly refresh the list.
- **Open-file browser.** A separate navigation tab lists open buffers. Opening an already-open file selects its existing buffer rather than overwriting it from disk.
- **File creation.** A filename field creates a new text buffer; an existing saved name opens that file. Filenames may be extensionless. The workspace is flat, with ordinary UTF-8 files rather than a directory-tree editor.
- **Independent tabs.** Each open file retains its own text, dirty state, selection, scrolling, and undo/redo history. Switching files does not merge their editing histories.
- **Reload restoration.** The last selected saved file is reopened when available. This restores a saved-file selection, not all tabs or unsaved text.
- **Unsaved-work protection.** Dirty tabs require confirmation before closing, and pending edits trigger a browser navigation warning.
- **Manual save.** Save and Ctrl/Cmd+S write the active buffer without starting an agent.
- **Autosave.** The edited active tab is saved after a 500 ms debounce while the workspace window is focused. Untouched new files and inactive tabs are not automatically saved. A failed write pauses automatic retry until an explicit save attempt.
- **Concurrent-edit protection.** Revision-checked writes reject stale disk revisions and retain the browser draft. Edits made while a save is in flight remain dirty rather than being mistaken for saved content.
- **Download.** Downloads the current buffer, including unsaved edits, without changing the server's saved state.
- **Editor status.** Displays saved/unsaved state, line and byte counts, save messages, and shortcut help.
- **File boundaries.** Editing and saving support files up to 2 MiB and names up to 180 UTF-8 bytes. Hidden files, path traversal, symlinks, and nonregular files are excluded. There is no rename/delete API.

Sources: [workspace state and saves](../frontend/src/main.tsx#L486), [tab state](../frontend/src/tabs.ts#L5), [editor history](../frontend/src/editor.tsx#L58), [file validation and storage](../backend/src/main.rs#L254).

## Specification Editing

- **Source-oriented editing.** Line numbers and syntax colors distinguish headings, lists, completed lines, emphasis, links, inline code, and fenced code without rewriting or rendering away the source syntax.
- **Completion markers.** Pressing `/` toggles the current requirement line's leading `# ` marker while preserving indentation and editing history. Alt+/ inserts a literal slash. Within recognized code blocks, slash remains ordinary text.
- **Line-local completion semantics.** A single leading `# ` marks only that line complete. Markdown headings with multiple hashes, inline hashes, and hashes in code do not complete requirements. Removing the marker reopens a line.
- **Large-document mode.** Large documents switch to a labeled plain-text editor rather than building an expensive highlighted view. Long individual lines also skip inline coloring. This changes display, not saved content or the file-size limit.
- **AI ghost text.** When configured and enabled, a short continuation appears after a pause at an eligible line end. Tab or Accept part inserts it; Escape dismisses it. Suggestions remain outside the buffer until accepted.
- **Suggestion controls.** A shared toggle disables suggestions across tabs. Selection, IME composition, blur, tab changes, and text after the cursor suppress inappropriate requests. Stale responses are discarded. Accepted or dismissed suggestions wait for another edit before requesting again.
- **Short completion context.** The editor sends a bounded preceding-text window; the server normalizes the result into a single-line part of at most 160 characters.

Sources: [editor controls](../frontend/src/editor.tsx#L20), [source highlighting](../frontend/src/highlighting.tsx#L8), [marker handling](../frontend/src/completion-marker.ts#L3), [code-block detection](../frontend/src/code-block.ts#L3), [completion service](../backend/src/completion.rs#L425).

## Remote Coding Runs

- **Explicit Save & run.** The button and Ctrl/Cmd+Enter save the spec and submit its acknowledged revision after confirmation. Empty inputs are rejected; build snapshots have a separate 120 KiB limit.
- **Immutable run input.** Each admitted build receives a fixed snapshot. Subsequent saves and autosaves do not change running instructions.
- **SSH execution.** Builds use the configured remote `spec build` launcher, with support for trusted shell aliases/functions and user-installed engine paths. Local-only mode disables this execution path; it is not a local coding-agent runner.
- **Automatic-approval request.** The adapter requests unattended tool approval and recommended answers from compatible engines. The initial confirmation authorizes a trusted remote workflow, not a sandbox or a per-tool approval dialog.
- **Completion-aware instructions.** Supplemental instructions tell the build agent to retain completed spec lines as context and implement pending requirements without changing the snapshot's markers.
- **History-aware instructions.** Initial builds, continuations, and prose optimization request review of relevant previous `.out` files before planning. Agents are instructed to reconcile historical claims with current code and tests. This is agent-directed review, not automatic proof that requirements were satisfied.
- **Admission and project coordination.** Active and unresolved runs count toward a 16-run limit per state namespace. Duplicate active runs for one spec are blocked. Ordinary builds use shared project locks; repository saves, optimization, and Performance use exclusive project coordination.
- **Detached ownership.** After upload, a remote supervisor owns the workload. Closing the browser, losing SSH, or normally stopping the local server does not itself cancel that remote build.
- **Keep-alives.** The supervisor reports process liveness every 60 seconds. There is no overall execution timeout; individual startup, network, provider, and command limits remain separate.
- **Explicit cancellation.** Stop run requests cancellation of the supervised process group. Unconfirmed cancellation is kept distinct from confirmed cancellation.

Sources: [launch and admission](../backend/src/main.rs#L532), [remote launch adapter](../backend/src/remote-build.bash#L166), [engine instructions](../backend/src/remote-alias.bash#L137), [supervisor](../backend/src/remote-supervisor.bash#L10), [frontend launch](../frontend/src/main.tsx#L565).

## Queues And Continuation

### Saved-Editor Queue

Save & run during an eligible active build can save and queue a new immutable editor snapshot. This is a fresh future build, not a message to the running agent.

- Queue records preserve the submitted revision, snapshot, parent run, and child identity across browser and backend restarts.
- Background dispatch waits for authoritative successful parent completion, attachment cleanup, durable state, and applicable remote/project checks.
- Later autosaves do not replace queued instructions.
- The interface shows waiting, started, and paused entries, reasons, revision information, and child IDs when available.
- Users can refresh, cancel pending work, or dismiss recorded entries. Dismissing a started entry does not cancel its child.
- One queue item is supported per parent, with a 32-item total limit. Identical submissions are idempotent; uncertain dispatches are not silently relaunched after restart.

Sources: [durable queue](../backend/src/queued_builds.rs#L118), [queue interface](../frontend/src/main.tsx#L812).

### Same-Session Follow-Ups

- **Use recommended & continue** resumes an eligible completed build's captured engine session with a fixed recommended-choice prompt.
- **Send & continue** submits custom feedback to that same session. Enter sends; Shift+Enter inserts a newline. Feedback is limited to 16 KiB.
- Each continuation gets a new run and log while retaining the engine session identity.
- Continuation requires a confirmed completed latest ordinary build on the same remote configuration, with usable captured session metadata.
- Feedback does not save or upload the current editor text. Revised requirements belong in a new build or saved-editor queue.
- While a build runs, one feedback message can wait for successful completion. This separate feedback queue is browser-memory-only and requires the page to stay open; switching editor files does not redirect it.
- Failed, stopped, replaced, or uncertain runs pause queued feedback instead of treating it as live stdin or retrying blindly.

Sources: [continuation admission](../backend/src/main.rs#L667), [session capture and resume](../backend/src/remote-alias.bash#L64), [feedback interface](../frontend/src/main.tsx#L597).

## Output And Recovery

- **Associated output.** Each saved spec has its own latest-run association, status, and output view. Live polling also follows recoverable runs belonging to other open tabs.
- **Follow control.** Follow output enables or disables automatic scrolling as logs arrive.
- **Readable logs.** ANSI text styles and severity colors improve readability. Terminal control sequences are stripped rather than executed, and embedded HTML remains text. Dense output falls back to sanitized plain text.
- **Reported progress.** An accessible rainbow bar counts the latest complete CLI `# Todos` list, including cancelled-task accounting. Missing, partial, or truncated evidence shows indeterminate or unavailable progress rather than an invented percentage. Counts represent agent-reported tasks, not verified spec completion.
- **Durable recovery.** Private local records preserve run identity, latest associations, status, and cached output. Restart restores unresolved jobs without launching replacements; completed cached output remains readable without SSH.
- **Load nohup output.** Explicitly reloads the associated remote disk log without rerunning the build or replacing the editor buffer. Legacy `output.log` recovery remains supported.
- **Retained-run browser.** Lists eligible historical spec-named logs by run ID and update time. Selecting one opens a read-only snapshot, without relinking the current run or enabling historical continuation/cancellation.
- **Active-runs inspector.** Lists recoverable runs even when their files are unopened or deleted. Users can inspect output, refresh status, and explicitly stop a selected run without opening its source file.
- **Status distinctions.** Running, completed, failed, cancelled, timed-out, detached, and unavailable states remain distinct. An SSH transport exit is not treated as proof of the remote command's exit status.
- **Bounded output.** Ordinary build and repository-save logs retain the first 8 MiB of agent output while draining excess data. Supervisor keep-alives can make the total log larger. The UI/backend live view retains a 256 KiB tail with truncation notices; analytics uses a separate full-report path.
- **Retention.** Eligible completed ordinary remote run directories older than seven days are pruned on later launches. Runs carrying optimization reports are retained, and local run records have no automatic pruning.

Sources: [recovery storage](../backend/src/recovery.rs#L170), [output endpoints](../backend/src/main.rs#L1001), [remote recovery](../backend/src/remote-recover.bash#L25), [retained lookup](../backend/src/remote-retained.py#L41), [active-runs UI](../frontend/src/active-runs.tsx#L32), [progress](../frontend/src/progress.tsx#L6), [log rendering](../frontend/src/highlighting.tsx#L35).

## Repository Saving

Spec can inspect the configured remote Git worktree and expose Save repo changes when uncommitted changes exist. Status includes staged, unstaged, and untracked files while excluding harness artifacts.

After confirmation, the active spec is saved as context for a dedicated agent-mediated repository-save run. Instructions request validation and focused commits following repository conventions, excluding secrets and unrelated edits. They do not authorize pushing, amending, resetting, changing Git configuration, or bypassing hooks.

The saved AI profile selects the agent configuration, with a fallback when no profile exists. Project/run guards prevent conflicting repository-save admission. Output, cancellation, and recovery use the existing run machinery. A successful harness status describes command completion, not independently verified commit quality.

Sources: [Git status probe](../backend/src/remote-repository.bash#L1), [repository-save instructions](../backend/src/remote-alias.bash#L110), [repository UI](../frontend/src/main.tsx#L824).

## Session Chat

- **Separate window.** Chat opens in its own popup, bound to the selected filename independently of later workspace selection. Existing popups can be reused and reconnect to the workspace.
- **Live draft context.** Checked same-origin messaging supplies the bound editor's unsaved text when available. Otherwise chat falls back to the saved file.
- **Fresh output context.** Idle previews refresh periodically, and each question requests current associated disk-log output before asking the provider.
- **Context inspection.** Users can inspect the current spec/output preview and the snapshot supplied for the last answer. Later polling does not overwrite that last-answer evidence.
- **Session-scoped conversation.** A changed run starts a new text conversation on the next question. Requests include up to eight prior messages plus the current question.
- **Text controls.** Enter sends, Shift+Enter inserts a newline, and Clear chat removes displayed conversation and last-answer context. Errors retain the question for retry.
- **Bounded provider input.** Text questions are limited to 8 KiB. Context uses up to the first 64 KiB of the spec and last 64 KiB of available output, with partial-context disclosure.
- **Read-only answers.** Chat can explain logs, discuss requirements, and answer general questions, but has no file-editing or command-execution tools. Without a configured provider, context remains readable while Ask is disabled.
- **Agent.md editor.** A separate collapsible panel creates, loads, edits, reloads, and revision-checks saves to the workspace's `Agent.md`. It protects dirty edits and requires confirmation before discarding them. Saving this file does not automatically install it into chat or remote agent configuration.

Sources: [chat window](../frontend/src/chat.tsx#L12), [context and conversation service](../backend/src/chat.rs#L84), [Agent.md editor](../frontend/src/agent-editor.tsx#L14).

## AI Settings

- **Five provider choices.** Azure OpenAI, standalone OpenAI, Claude API, OpenRouter, and a local Hugging Face/OpenAI-compatible server.
- **Provider-specific fields.** Model or deployment, endpoint, applicable API version, and API key are configurable, with defaults appropriate to the selected provider.
- **Shared profile.** One saved server profile supplies future text-AI requests and compatible execution workflows. It overrides environment defaults; Reset to environment removes that override. Already-running jobs retain their captured configuration.
- **Key management.** Responses disclose whether a key exists without returning it. Blank input can retain a key for the same provider/endpoint; local-server authentication can be explicitly removed.
- **Private persistence.** Settings use private server-side storage outside the workspace and static asset roots. This is filesystem protection, not encryption at rest.
- **Local-server integration.** Local Hugging Face connects to an already-running compatible service; Spec does not download or launch a model. For remote execution, a loopback endpoint refers to the execution host.
- **Capability refresh.** Saving settings or returning focus to a window refreshes feature availability. Settings navigation preserves mounted editor state.
- **Independent voice configuration.** Voice services are configured separately from the text profile. Saving settings is not a connectivity test.

Sources: [settings UI](../frontend/src/settings.tsx#L3), [profile validation and storage](../backend/src/settings.rs#L74), [provider protocols](../backend/src/completion.rs#L136), [remote profile transfer](../backend/src/remote-provider.bash#L13).

## Voice

### OpenAI Realtime

The OpenAI panel supports continuous microphone conversation using WebRTC, with server-mediated SDP setup and a fixed context snapshot captured at call start.

- Explicit Start, Cancel connection, Stop, and Resume audio controls.
- Secure-context, microphone, and browser capability checks before connecting.
- Microphone transmission begins after connection/session readiness.
- Server voice-activity detection requests automatic responses after speech pauses and permits interruption; the microphone remains live during assistant playback.
- Separate readable voice transcripts, when supplied, retain a bounded recent history and reset for a new call.
- Stopping, closing the panel, or leaving the page releases media/session resources.

Sources: [OpenAI voice UI](../frontend/src/realtime.tsx#L27), [Realtime setup](../backend/src/realtime.rs#L156).

### Azure Recorded Turns

The current, uncommitted Azure implementation uses explicit recorded question/answer turns, replacing the older Azure Realtime path.

- Record question captures browser audio in a supported WebM, MP4, or WAV format with requested echo cancellation and noise suppression.
- Recording is bounded to 60 seconds and 4 MiB. Reaching the time limit stops capture but does not automatically submit it.
- Send recording uploads the audio, fresh spec/output context, and bounded recent voice history to `/api/voice/azure`.
- The backend transcribes speech through a configured Whisper deployment, then requests a text-and-audio answer through the configured audio deployment. The UI presents this workflow as Whisper plus `gpt-audio-mini`.
- Answers include readable text and playable MP3 audio. The microphone is off during context retrieval, generation, and playback.
- Cancel recording, Cancel response, Stop audio, Resume audio, and Interrupt and record question provide deliberate turn control instead of hands-free interruption.

Starting either voice provider stops the other in the same chat window. Voice context is bounded to the first 16 KiB of spec and last 16 KiB of output. Voice conversations and text chat remain separate. English-only behavior is requested through model instructions, not enforced as a language filter.

Sources: [Azure voice UI](../frontend/src/azure-voice.tsx#L12), [Azure transcription and audio service](../backend/src/azure_voice.rs#L234), [shared voice controls](../frontend/src/chat.tsx#L143).

## Analytics

- **Read-only report selection.** Analytics selects a saved spec, associated or retained run report, and optional saved `.eval` file. Eligible local exact-name `<spec>.out` files can also supply report snapshots. Opening analytics neither saves drafts nor runs a build/evaluation command.
- **Numeric metric extraction.** Parses supported explicit evaluation events and baseline/iteration/final objective fields into metric series. Quoted examples, code blocks, and hidden terminal payloads are excluded from measurement evidence.
- **Charts and summaries.** Displays per-metric charts, latest value, sample count, minimum, and maximum. Large chart series are sampled for display while evaluation uses all extracted samples.
- **Declarative checks.** Version-1 JSON `.eval` suites match an exact spec and define 1-64 checks. Aggregations include last, mean, min, max, sum, and count; comparisons include `>=`, `<=`, `>`, `<`, and `==`.
- **Evaluation results.** Tables show observed values, targets, and pass/fail/inconclusive results, with totals. Missing or incomplete evidence yields inconclusive results rather than fabricated scores.
- **Diagnostics.** Shows nonempty-line and error/warning-word counts separately from measured metrics.
- **Provenance.** Displays report identity, run information, report SHA-256, saved evaluation revision, and completeness qualifications. Local snapshots do not claim verified terminal status.
- **Bounded reads.** Full reports are read up to 8 MiB; exact-cap, changing, lossy-decoded, active, and unknown-status reports carry evidence qualifications. Parsing also limits metrics, samples, and individual records.

Sources: [analytics UI](../frontend/src/analytics.tsx#L11), [evaluation rules](../frontend/src/evaluation.ts#L14), [quoted-evidence filtering](../frontend/src/report-quotes.ts#L8), [report retrieval](../backend/src/analytics.rs#L21).

## Performance Sessions

The visible Performance workflow launches a fresh builder session to run an existing built Gemma RL workflow for an explicitly selected remote project. It does not require an editor tab or a prior spec build.

- **Project selection.** Accepts a project path relative to the configured remote workspace or an absolute execution-host path.
- **Explore search.** Explicit Search with Explore inventories bounded directory names beneath the workspace's parent and asks a tool-denied Explore agent to rank candidates. Search excludes hidden/dependency/build directories and symlinks. Selecting a result fills the path without launching a run; only directory names/paths are sent for ranking, not source contents.
- **Optional instructions.** Use current editor as instructions submits unsaved content without saving locally. Any filename extension is accepted; the encoded project-plus-optional-spec payload must fit within 1 MiB, including JSON escaping and metadata.
- **Fresh session.** `/api/performance` invokes a builder directed to inspect and run the project's existing `gemma4-policy` RL workflow. Instructions prohibit rebuilding, silent downloads, fabricated data/evaluators, and substitution of distillation results.
- **Independent lifecycle.** Performance has separate run admission, persisted output, recovery, latest-run association, and cancellation. An unrelated unresolved spec run does not itself block this namespace, while physical-project coordination still applies.
- **Output and recovery.** Performance output shows logs and reported measurements; Recover latest Performance restores the latest session. Stop affects the selected Performance run.
- **Execution boundary.** The wrapper validates builder-session identity and engine errors. RL prerequisites and measurement reporting are agent instructions, not independent verification that a training result is correct.

Sources: [Performance UI](../frontend/src/main.tsx#L407), [project picker](../frontend/src/project-picker.tsx#L30), [search implementation](../backend/src/project-search.py#L90), [Performance session runner](../backend/src/performance-session.py#L14), [separate routes](../backend/src/main.rs#L1196).

## Optimization And Pipeline APIs

### Recursive Optimizer

The standalone Python optimizer and `/api/optimize` request form `{name, content}` support a separate measurement-driven improvement workflow. Uploaded instructions are retained privately on the remote host; this does not save the local editor buffer.

- **Project discovery.** Uses supported build-invocation metadata and narrowly interpreted historical evidence to identify a project. Explicit uploaded configuration paths remain separate from that project directory; missing or ambiguous targets produce diagnostics.
- **JSON mode.** Version-1 configuration supplies objectives with command argv, measurement argv, maximize/minimize direction, tolerances, patience, and optional command timeouts. This scheduler mode does not require model planning.
- **Prose mode.** A model prepares a validated objective plan. Each active-objective iteration uses an OpenCode builder followed by model review/repair and validation. Saved provider settings select compatible planner/reviewer and builder behavior.
- **Independent measurement.** Baselines precede work. Each round remeasures every objective, including plateaued ones. A sufficiently large change, including regression, resets stability and can reactivate an objective.
- **Measured stopping.** All objectives must simultaneously satisfy tolerance/patience rules. Defaults are absolute tolerance `1e-6`, relative tolerance `1e-4`, and three stable rounds. A model's claim of convergence does not stop the scheduler.
- **No overall iteration cap.** Improving, oscillating, or noisy objectives may continue indefinitely. Optional command deadlines are distinct from overall runtime.
- **Structured evidence.** Progress and JSONL reports include scores, directional/cumulative gains, marginal differences, tolerance, stability, and execution context. Invalid measurements and command/provider failures do not count as convergence.
- **Process cleanup.** Linux subreaper/process-group handling cleans up descendants; interruption preserves available reporting. Selected-profile secrets are filtered from report and command output.

Sources: [optimizer configuration](../backend/src/optimize.py#L381), [command execution](../backend/src/optimize.py#L867), [reporting](../backend/src/optimize.py#L980), [measurement scheduler](../backend/src/optimize.py#L1074).

### Fixed Training Pipeline

A different `/api/optimize` request form, `{project, spec?}`, invokes `performance.py`, not the visible fresh-session Gemma RL runner.

- Reads uploaded JSON or a project's `performance.json` without relying on prior-build discovery.
- Runs the configured dataset pipeline through an explicit environment implementation, then a prebuilt training executable.
- Supports a digest-pinned image, contained source directory, editable-file replacements, test commands, and bounded dataset/model timeouts.
- Validates reported dataset outcomes, snapshot-hash format, consistency of before/after accuracy, negative log-likelihood and exact-match measurements, benchmark consistency, and the expected F32 safetensors checkpoint layout. The wrapper does not independently recompute the dataset snapshot hash.
- Publishes completed-stage metrics and artifact paths; interrupted or failed later stages retain only available completed evidence.
- Uses the optimization run lifecycle and does not require model-provider credentials for the fixed pipeline itself.

Sources: [request dispatch](../backend/src/main.rs#L624), [pipeline contract and runner](../backend/src/performance.py#L84).

## Local Access And Operations

- **Loopback service.** The server binds locally, normally on port 4780, and serves the built frontend itself.
- **Token access.** A generated bearer token protects APIs. The UI accepts a token-bearing link or manual token, removes the fragment after capture, and retains it in session storage.
- **Browser protections.** Authenticated responses are noncacheable; static responses use content-security, MIME-sniffing, and referrer protections rather than permissive cross-origin access.
- **Workspace protection.** Private atomic saves, SHA-256 revisions, symlink/special-file rejection, trusted workspace permissions, and a workspace lock protect the file workflow.
- **Private run storage.** Run directories, snapshots, logs, and settings have ownership and permission checks. Secrets/profile payloads travel privately; configured execution profiles are captured at admission and temporary remote profile files are removed on cleanup.
- **Restricted SSH transport.** Uses noninteractive authentication and strict host verification, with forwarding and connection multiplexing disabled. Workloads still execute with the trusted remote user's privileges.
- **Build launcher.** `build.sh` builds frontend assets and the release Rust backend, preferring Bun's frozen lockfile with a Node/npm fallback for the frontend.
- **App launcher.** `run.sh` prepares configured SSH execution, builds, and launches the local application. `--local` skips remote execution setup. `ops.sh` defaults the editable workspace to `~/specs`.
- **Batch launcher.** `remote-build.sh` serially builds eligible top-level `.md`, `.txt`, `.spec`, and extensionless files already on the remote host. It writes per-file logs, continues after individual failures, and returns failure if any build fails. `--check` prepares/checks the remote workspace and lists eligible inputs without building them.
- **Authenticated API families.** Configuration, settings, files, runs, queued builds, recovery/history, analytics, repository status/save, completion, chat, voice, project search, optimization, and independently scoped Performance are exposed through the local API.

Sources: [server startup and authentication](../backend/src/main.rs#L1303), [private state](../backend/src/recovery.rs#L26), [SSH transport](../backend/src/remote.rs#L42), [build script](../build.sh#L6), [app launcher](../run.sh#L6), [workspace launcher](../ops.sh#L6), [batch runner](../scripts/build-projects.bash#L9), [API routes](../backend/src/main.rs#L1196).

## Responsive And Accessible Interface

- Desktop navigation, editor, and output use independently usable panes; narrower screens stack them vertically and wrap controls.
- Scrollable editor tabs and bounded panels accommodate long filenames, logs, settings, chat, and analytics.
- A dark palette and rainbow accents identify branding, selected tabs, primary actions, and reported progress.
- Reduced-motion preferences disable decorative and indeterminate-progress animation.
- Forced-color styles preserve editor text, selections, controls, progress, and chart visibility.
- Keyboard-visible focus, labeled regions, live status announcements, and selected/expanded/progress semantics support assistive navigation.
- Sidebar navigation supports arrow keys and Home/End. Analytics uses a native modal dialog with Escape handling and focus restoration; auxiliary panels restore focus when closed.

Sources: [layout and accessibility styles](../frontend/src/style.css#L2), [sidebar keyboard navigation](../frontend/src/main.tsx#L772), [analytics dialog](../frontend/src/analytics.tsx#L51), [settings focus handling](../frontend/src/settings.tsx#L54).
