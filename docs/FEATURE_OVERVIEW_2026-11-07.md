# Spec Feature Overview And Functional Review

Review date: November 7, 2026. Repository: [AI10xDev/spec](https://github.com/AI10xDev/spec).
Reviewed `/home/opencode/spec` at `28b4f34` (v0.1.15), including the pre-existing,
uncommitted feedback-recall changes in `frontend/src/main.tsx` and
`frontend/e2e/continuation.spec.ts`. Application source was not changed by this
review. This document describes that working tree, not just the released tag.

## Executive Summary

Spec is a local-first specification editor and coding-agent orchestration
workspace. A Rust server serves a React/Vite frontend and authenticated APIs.
Basic editing needs no AI account. Optional services provide text suggestions,
chat, Realtime voice, SSH coding runs, local Computeruse callbacks, Azure backups,
and specialized optimization/Performance workflows.

**Fresh verification:** all **260 existing Chromium tests** and **174 frontend
unit tests passed** after rebuilding the current source. Memory-filtered Rust
tests passed **30/30**; storage-filtered Rust tests passed **29/29**, including
15 storage-module tests and a real-server storage-settings restart test. These
filters overlap and are not a complete backend-suite run.

Passing suites do not mean defect-free behavior. Additional probes reproduced
three frontend defects, one Analytics navigation gap, and a retained-log lookup
inconsistency. Details and operating limits follow.

## Findings

### 1. Medium: Recommended Continuation Strands Unsent Feedback

On a completed run, type a custom follow-up without submitting it, then click
**Use recommended & continue**. When the child run replaces the parent, the
feedback input becomes empty. Up Arrow does not recover that unsent draft.
Reproduced in Chromium at 1440, 390, and 320 px. Only the expected continuation
request with an empty body was sent; no draft was submitted or saved elsewhere.

The parent-keyed draft is not migrated when `message` is undefined, and the UI
switches to the child ID. This is inaccessible browser state, not deletion of a
saved spec. Preserve/migrate it or warn before replacing its composer context.
Source: [main.tsx:722-746](../frontend/src/main.tsx#L722).

### 2. Medium: Large Retained Logs Are Silently Omitted

A valid synthetic retained run with an 8,388,608-byte log can be listed and its
256-KiB tail read. At 8,388,609 bytes, direct tail lookup exits 125 and tail-mode
listing returns `{"runs":[],"truncated":false}` with no warning. Full-report
mode still lists the same run and returns a bounded report.

This was reproduced directly against the real Python helper with valid private
storage, UUID, provenance, invocation, and terminal status, not through a live
SSH host or the browser. Existing tests intentionally assert oversized rejection,
so this is established behavior, not evidence of a new release regression.

Ordinary agent output is capped at 8 MiB, but supervisor keep-alives append
outside that cap. A path to larger ordinary logs therefore exists in source;
production frequency and a full supervisor-to-browser reproduction were not
measured. A bounded tail need not reject the entire file; at minimum omissions
should be disclosed.
Sources: [remote-retained.py:91-98](../backend/src/remote-retained.py#L91),
[listing:155-169](../backend/src/remote-retained.py#L155),
[supervisor:46-78](../backend/src/remote-supervisor.bash#L46),
[existing assertion:978-980](../backend/src/retained_tests.rs#L978).

### 3. Medium, Conditional: Blocked Session Storage Blanks The App

Injecting a `SecurityError` from the browser's `sessionStorage` getter causes an
uncaught initialization error and empty application root, with or without a token
fragment. No connection fallback renders. Storage access is unguarded in token
initialization. Catch storage failures and allow an in-memory/manual connection.

This establishes fault-handling behavior with an injected browser failure, not
its prevalence in normal profiles, private browsing, or a particular browser
privacy configuration. Source: [main.tsx:29-35](../frontend/src/main.tsx#L29).

### 4. Low: Performance Recovery Leaves A Stale Failure Alert

Return one 503 from the selected Performance poll, then a successful completed
response. The output updates to the completed result, but **Performance polling
failed** remains visible. Reproduced at all three widths. Successful polling
does not clear the corresponding failure state; clear only the recovered polling
error without masking unrelated errors.
Source: [main.tsx:495-515](../frontend/src/main.tsx#L495).

### 5. Low: Analytics Retained Picker Has No Direct Way Back

After **Browse retained runs** returns a nonempty list, a required selector
prevents **Open analytics** from opening the associated report with no retained
selection. There is no associated/latest option in that selector. Closing and
reopening the dialog restores access. Reproduced at all three widths, including
successful associated-report rendering after reopening. This is a navigation
gap, not corrupted analytics data.
Source: [analytics.tsx:82-85,131](../frontend/src/analytics.tsx#L82).

### Documentation Drift

The pre-existing [November 4 feature report](FEATURE_REPORT_2026-11-04.md) describes
a now-removed Azure Whisper/recorded-turn implementation and omits Computeruse,
build memory, Azure backups, and guided setup. The current app uses **Azure
WebRTC Realtime**, not that recorded-audio API. Parts of
[SECURITY.md:35-65](SECURITY.md#L35) also retain older fixed-prompt/provider-transfer
descriptions. Current code and release notes take precedence. The historical
report and other existing files were left untouched.

## Feature Inventory

In the verification column, **browser** means current Chromium with local API
fixtures or intercepted responses unless explicitly described as a real local
API. It does not mean live provider/SSH/GPU validation.

| Area | Implemented capabilities | Verification and boundaries |
| --- | --- | --- |
| Connection and shell | Per-process token link, manual connection, saved-file and open-tab navigation, Settings view, Analytics dialog, independent chat popup, Active runs and Performance panels. | Browser token lifecycle, invalid-token rejection, navigation and keyboard tests passed. Storage-denial exception above. No multi-user account system. |
| Files and tabs | Create/open flat text files; filter and refresh; independent buffers/history/selection/scroll; explicit Save, active-tab focused-window autosave after 500 ms, download, dirty-close protection, restore last saved selection. | Real local API and browser tests passed for conflicts, in-flight edits, downloads and reloads. Saved-selection restoration is not recovery of all unsaved buffers. No rename/delete API or directory-tree editor. |
| File safety | Revision-checked writes, maximum 2 MiB files and 180-byte UTF-8 names; rejects traversal, hidden names, symlinks, nonregular files and invalid text. | Local API/browser conflicts passed; backend validation inspected. List is bounded at 10,000 eligible entries. This is an editor workspace, not an arbitrary project filesystem browser. |
| Specification editor | Line numbers, source-preserving syntax colors, independent undo/redo, `/` line-completion toggle, Alt+/ literal slash, ordinary slash in recognized code blocks, large-document plain-text fallback. | Browser and unit checks passed for IME, CRLF, history, scrolling, code-block semantics and large documents. A single `# ` completes only its line; multiple hashes remain Markdown headings. |
| AI ghost text | Optional short trailing suggestions, partial acceptance/Tab, dismissal, cross-tab toggle, stale-response suppression and bounded context. | Browser/unit checks passed. Suggestions can send unsaved text to the configured provider; acceptance changes the buffer, mere display does not. No live quality assessment. |
| Ordinary builds | Confirmed Save & run and Ctrl/Cmd+Enter; acknowledged revision frozen into immutable snapshot; SSH upload and external compatible `spec build` execution. | Real local backend plus fake SSH/engine workflows passed. Snapshot limit 120 KiB; empty input rejected. Local-only mode disables SSH builds. No built-in local coding engine. |
| Durable editor queue | Save and queue a fixed revised spec during an eligible active run; persisted parent/child identity, restart recovery, reasons, refresh/cancel/dismiss; dispatch after authoritative successful completion. | Browser queue states/races and backend memory/queue interaction checks passed. One item per parent, 32 recorded items total. Later editor saves do not change the queued snapshot; uncertain dispatch is not blindly retried. |
| Continuation and feedback | Recommended/custom same-session follow-ups; new run/log per sweep; Enter sends, Shift+Enter adds newline; duplicate guards; browser-only queued feedback. Local changes add empty-input Up Arrow recall. | Current browser suite passed, including new recall tests. Custom feedback limit 16 KiB. Continuation does not submit edited spec text. Browser feedback queue is not durable; page must stay open. Unsent-draft defect above. |
| Output and progress | ANSI/severity rendering, sanitized terminal content, Follow output, separate per-file output, accessible agent-reported todo progress and explicit missing/truncated evidence. | Browser and unit tests passed. Progress is agent-reported, not independently verified feature completion. Live/cached view retains a 256-KiB tail. |
| Recovery and active runs | Detached ownership, cached output/status, restart attachment without replacement launch, Load nohup output, retained read-only snapshots, inspect unopened/deleted-file runs, explicit cancellation. | Browser lifecycle/cancellation/recovery tests passed using fixtures. Transport uncertainty remains distinct from confirmed failure. Retained >8-MiB issue above. Closing a browser or normally stopping the backend does not itself cancel remote builds. |
| Repository saving | Remote dirty-worktree probe; confirmed dedicated agent run to validate and commit relevant changes with saved spec context; shared output/stop/recovery machinery. | Browser/fake-engine workflow passed; instructions inspected. This is not a direct deterministic Git commit implementation. It does not authorize push, amend, reset, hook bypass or unrelated edits. |
| Session chat | Filename-bound popup; live unsaved editor context from checked opener messaging; fresh log before each question; preview and last-answer context; session-scoped history; clear/retry/keyboard controls. | Browser popup/context/isolation tests passed. Text chat has no editing or execution tools. Questions max 8 KiB; context first 64 KiB spec/last 64 KiB output, up to eight prior messages. No live provider quality test. |
| Agent.md | Separate load/edit/reload/save panel with revision checks and dirty-state protection. | Browser conflict and navigation tests passed. Saving Agent.md does not automatically install it into chat or remote agent configuration. |
| AI settings | Azure OpenAI, OpenAI, Claude, OpenRouter, and local Hugging Face/OpenAI-compatible server; provider-specific fields, redacted key state, key retention/removal, reset to environment, capability refresh. | Browser tests passed for all choices, errors and narrow keyboard layout. Saving is not a connectivity test. Local-server choice does not download or launch models. Reset can restore execution-host Azure defaults. |
| OpenAI and Azure voice | Shared continuous WebRTC component; authenticated server SDP setup; start/cancel/stop/resume audio, delayed microphone activation, server VAD/interruption, transcripts, provider switching and resource cleanup. | Mocked WebRTC/microphone/browser tests passed for both providers. Azure uses `/api/realtime/azure`. Fixed call-start context, not continuously refreshed context; voice configuration is separate from text settings. Actual audio/VAD/network traversal untested. |
| Analytics | Saved/associated/retained/local exact-name report sources; explicit metric extraction and sampled charts; optional declarative v1 `.eval` checks, pass/fail/inconclusive, provenance digest and completeness warnings. | Browser/unit checks passed, including quoted-evidence exclusion, responsive charts and forced colors. Read-only: does not run a build or evaluation command. Missing evidence is not a fabricated score. Picker gap above. |
| Computeruse | Opt-in shared-file synchronization, revision checks, reload remote instructions, local callback run/stop/output. Manual Save synchronizes; autosave stays local. | Real local backend/fake SSH/browser workflows passed. Save & run targets the configured local callback in this mode, not ordinary SSH build. External callback supplies actual desktop/model behavior. Callback state is in memory and backend shutdown cancels it. |
| Visible Performance | Explicit project path or Explore search; optional unsaved editor instructions; fresh Gemma RL builder session; independent output, recovery, cancellation and run namespace. | Browser project-picker and lifecycle tests passed at desktop/mobile widths. No GPU run. Selecting a project does not launch work. Instructions ask for an existing built workflow; they are not independent proof of RL correctness. |
| Build memory | Durable per-build/per-continuation sweep capture; SQLite index; authenticated GraphQL queries and lexical, cited chronological retrieval with missing/unverified reports explicit. | 30 memory-filtered Rust tests passed, including HTTP validation, restart/backfill, filters, budgets and queue/session relationships. API-only: no dedicated frontend browser tested. Caller-driven retrieval is not automatically inserted into prompts. |
| Azure backups | Separate server-side account/container/key settings; explicit confirmed Upload all specs; stale-destination rejection; private-container checks; uploaded/skipped/failed summary. | Browser settings/upload fixtures and all 15 storage-module tests passed; storage-filtered integration restart passed. No actual Azure upload. Manual backup, not automatic sync, restore or transaction. |
| Guided setup | Linux/Python conversational wizard; dependency checks, dry run, optional SSH/AI/voice settings, private saved launcher/configuration, separate save/build consent. | Source/documentation inspected; wizard tests not rerun here. Does not automatically install OS packages, remote engines, models or services. |

### Source Map

- Workspace, builds, queues and output controls: [main.tsx](../frontend/src/main.tsx), [editor.tsx](../frontend/src/editor.tsx), [active-runs.tsx](../frontend/src/active-runs.tsx), [main.rs](../backend/src/main.rs), [queued_builds.rs](../backend/src/queued_builds.rs), [recovery.rs](../backend/src/recovery.rs).
- Chat, AI and voice: [chat.tsx](../frontend/src/chat.tsx), [agent-editor.tsx](../frontend/src/agent-editor.tsx), [settings.tsx](../frontend/src/settings.tsx), [realtime.tsx](../frontend/src/realtime.tsx), [completion.rs](../backend/src/completion.rs), [chat.rs](../backend/src/chat.rs), [azure_realtime.rs](../backend/src/azure_realtime.rs).
- Analytics: [analytics.tsx](../frontend/src/analytics.tsx), [evaluation.ts](../frontend/src/evaluation.ts), [analytics.rs](../backend/src/analytics.rs).
- Computeruse and Performance: [computeruse.rs](../backend/src/computeruse.rs), [project-picker.tsx](../frontend/src/project-picker.tsx), [project-search.py](../backend/src/project-search.py), [performance-session.py](../backend/src/performance-session.py).
- Memory and backups: [memory.rs](../backend/src/memory.rs), [BUILD_MEMORY.md](BUILD_MEMORY.md), [storage.rs](../backend/src/storage.rs), [storage-settings.tsx](../frontend/src/storage-settings.tsx).
- Setup: [setup.py](../scripts/setup.py), [INSTALLATION.md](INSTALLATION.md), [run.sh](../run.sh), [build.sh](../build.sh).

## Specialized APIs

These are implemented, but should not be confused with the visible Performance
button or claimed as fresh end-to-end training validation.

| Workflow | Behavior and limits |
| --- | --- |
| Recursive optimizer | `/api/optimize` with `{name, content}` invokes the standalone optimizer. JSON mode schedules explicit command/measurement argv; prose mode adds model planning/build/review. Measures baselines and every objective each round. Simultaneous tolerance/patience stability stops the scheduler; regressions reset stability. Stability is not proof of improvement. No overall iteration cap. [optimize.py](../backend/src/optimize.py) |
| Fixed pipeline | `/api/optimize` with `{project, spec?}` invokes `performance.py`, not the fresh-session RL runner. Uses explicit dataset/environment configuration and a prebuilt training executable; validates declared outcomes, metrics and checkpoint contract. Does not independently recompute dataset snapshot hashes or prove evaluation quality. [performance.py](../backend/src/performance.py) |
| Memory queries | `/api/memory/graphql` exposes `sweep`, `sweeps`, `memoryContext`; no mutations/subscriptions. Retrieval examines at most 500 filtered candidates and returns at most 20 whole entries within a 1-32 KiB context budget. Lexical claim matching, not embeddings, full-log search or automatic ancestor expansion. Reports remain untrusted. [memory.rs:832-1058](../backend/src/memory.rs#L832) |

## Operational Boundaries

- **Trusted execution, not a sandbox.** Loopback binding, bearer authentication, CSP, private files and SSH checks reduce accidental exposure. Coding runs request automatic tool approval and can use the remote user's files, credentials and paid services. Computeruse runs with the local user's authority.
- **No source-tree synchronization.** Ordinary runs upload task snapshots, not the local application checkout. Generated changes remain remote until brought back through the user's normal workflow.
- **Distinct lifecycles.** Durable editor queues survive restart. Queued chat-like feedback requires the browser to stay open. Remote builds outlive normal browser/backend closure; local Computeruse callbacks do not.
- **Coordination is not isolation.** Ordinary builds can share project locks; exclusive workflows coordinate repository saves, optimization and Performance. This does not prevent unrelated external processes changing the same tree.
- **Secrets are private, not encrypted at rest.** Saved execution profiles, including API keys, are transferred privately to the trusted execution host. `--local` disables remote builds, not previously configured AI network requests.
- **Backup scope matters.** Saved top-level eligible UTF-8 documents up to 2 MiB are uploaded, including extensionless names. Unsaved buffers, `.out`, Agent.md, hidden files, directories and symlinks are excluded. There is no secret-content scanner. Matching blobs are overwritten; no restore UI or deletion reconciliation. A failed batch can already have uploaded files and some terminal errors omit accumulated counts.
- **Historical evidence is bounded.** Ordinary remote agent output is capped at 8 MiB before extra supervisor messages; eligible completed ordinary remote directories are pruned after seven days on later launches, with report-bearing exceptions. Local records have no automatic pruning.
- **Platform limits.** Linux is the documented host. Browser evidence here is Chromium viewport emulation, not Safari/Firefox, physical phones, real touch/virtual keyboards, or a formal accessibility/security audit.

## Fresh Validation

| Check | Result |
| --- | --- |
| `bun run build` in `frontend/` | Typecheck and Vite production build passed; tests consumed freshly built assets. |
| `/home/opencode/.cargo/bin/cargo build --locked` in `backend/` | Passed. Initial bare `cargo` invocation failed because Cargo was not on PATH; explicit installed binary resolved it. |
| `bun run test:unit` | 174 passed across 9 files. |
| Full existing Playwright suite | 260 passed, 0 failed, 0 skipped, no retries; 11 suites, one Chromium worker, about 4.7 minutes. Includes current uncommitted feedback-recall assertions. |
| `cargo test --locked memory` via explicit Cargo path | 30 passed; all other tests filtered out. |
| `cargo test --locked storage` via explicit Cargo path | 28 unit plus 1 integration passed; includes 15 storage-module tests. Two tests also appear in the memory filter. |
| Additional browser probe | 11 recorded cases reproduced the documented behavior: three scenarios at 1440/390/320 px plus storage-denial initialization with/without token. A reproduced defect is not a functionality pass. |
| Retained-log boundary probe | 10 helper invocations/assertions passed, establishing tail/full behavior at 8 MiB and 8 MiB + 1 byte. |
| Screenshot inspection | Existing suite's 10 desktop/mobile images reviewed; additionally inspected 320 px polling and 390 px Analytics screenshots. Layout wraps/stacks in those images. No measured contrast/screen-reader compliance claim. |
| Final hygiene | `git diff --check` and a separate whitespace check of this new untracked report passed. Existing application changes remained intact. Read-only source review also syntax-checked nine launcher/backend shell scripts. |

The full browser command ran from `frontend/` with a stripped environment:

```sh
env -i HOME=/tmp/opencode PATH="$PATH" TMPDIR=/tmp/opencode \
  PLAYWRIGHT_BROWSERS_PATH=/home/opencode/.cache/ms-playwright \
  node node_modules/@playwright/test/cli.js test \
  --output=/tmp/opencode/spec-overview-9d65-e2e --reporter=list
```

Existing fixtures combine real local API/file/process flows with fake SSH/engines
and mocked provider/browser APIs. Settings uses Vite; most other suites serve
the rebuilt production assets through the Rust server. Additional browser probes
intercepted every API request and blocked non-local origins. Chromium reported
version `153.0.8010.12` in the independent probe.

Temporary evidence retained outside the repository:

- `/tmp/opencode/spec-overview-9d65-e2e/`: existing-suite results and screenshots.
- `/tmp/opencode/spec-overview-9d65-probe.mjs` and `/tmp/opencode/spec-overview-9d65-probe/results.json`: independent browser probe, results and nine screenshots.
- `/tmp/opencode/spec-overview-9d65-retained/reproduce.py` and its fixture/output directory: synthetic helper reproduction with exact byte-range assertions.

The first independent browser attempt stopped on an ambiguous selector because
both the output pane and Analytics dialog had a Browse retained runs button.
Scoping the temporary probe selector to the dialog fixed the test harness; the
complete rerun then reproduced all cases. No application change was needed.
Probe browsers/servers shut down after execution. These temporary probes are
review evidence, not committed regression tests.

Not run: complete Rust/Python/setup suites, strict Clippy in this sweep, live SSH
or coding engines, AI quality, Azure uploads, real microphones/WebRTC provider
sessions, GPU/optimizer training workloads, Firefox/WebKit, physical devices,
formal accessibility/security audit, or release/deployment operations.

## Prior Evidence Review

The saved request was read unchanged. The execution workspace was a different
repository (`AI10xDev/model`); its existing `FEATURE_OVERVIEW.md` concerns that
workspace's mail/research features and was not treated as Spec evidence.
Target identity was checked through Git/GitHub before testing.

- Completed features/refactor: `/home/opencode/project/.spec-runs/run-be8fa21e-3bab-447b-95af-09bbb59f2c73/release.out:1738-1755,1925-1935` records v0.1.15 memory retrieval, private backups, provider explanations and a test-only storage type alias for Clippy. Current `memory.rs`, `storage.rs`, settings UI and [release notes](releases/v0.1.15.md) corroborate these; none were reimplemented.
- Earlier completed integrations: `/home/opencode/project/.spec-runs/run-d205c3ff-0867-4699-9493-3ce6f3ee89fc/commiting_spec.out:668-674` records durable editor queues, Computeruse, setup and restored Azure Realtime. Current routes/components corroborate the rollback and supersede the November 4 recorded-voice report.
- Historical validation: v0.1.15 reported 292 Rust, 259 Chromium and 174 frontend unit passes. Fresh results above replace browser/unit counts for this working tree; the complete historical backend count was not rerun or presented as current evidence.
- Unresolved historical uncertainty: [v0.1.15 notes:106-117](releases/v0.1.15.md#L106) describe an intermittent Performance cancellation test and untested live integrations. That flake was not reproduced or investigated here; it is not established as a production cancellation bug.
- Target-repository outputs were also discovered under `/home/opencode/spec/*.out` and hidden `.spec-runs/`. `run-871c0b89-487c-4cad-a584-f0f77ce1cec3/testing.out` contains only a readiness response, not tests. Older chat output contains historical browser claims; another testing output concerns CLI authentication rather than Spec functionality. None establish present completion. Binary provenance metadata was unreadable, so relevance used readable content, paths, commits and release metadata.
- No prior log's proposed plan or successful exit was accepted as implementation proof. No previous completed feature/refactor was reimplemented. Existing application changes and historical reports were preserved.

## Recommended Follow-Up

1. Preserve unsent feedback across recommended continuation and add a browser regression.
2. Make retained tail lookup bounded by bytes read, or explicitly disclose size-based omissions.
3. Add graceful token handling when browser storage is unavailable.
4. Clear recovered Performance polling errors and add an associated-report option in Analytics.
5. Reconcile older feature/security documentation; separately validate live integrations in a controlled environment before relying on them operationally.
