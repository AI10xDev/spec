# Code Review And Feature Report

Review date: 2026-10-28. Repository: `AI10xDev/spec`.
Reviewed source: `a15e200d100a50ada705ebdbdd947b6f2ee29a9a`.

## Findings

The implementation has substantial passing coverage, but it is not defect-free.
This review identified **one P1, eleven P2, and one P3 finding**, plus a failing
formatting check. P1 is a high-priority execution-safety defect; P2 denotes
correctness or accessibility issues to fix; P3 denotes a lower-impact issue.
The initial review changed documentation only and left all findings open.
The 2026-10-29 follow-ups fix F1-F13. The numbered descriptions below preserve
the original reproductions and repair recommendations, not current open defects.

## Repair Follow-Up: 2026-10-29

All thirteen findings have implementation fixes and regression coverage in this
change. The `editor_features` build in
`/home/opencode/project/.spec-runs/run-3f678964-935b-4fee-8582-24aa605798ba/`
timed out with status `124` after passing 153 backend tests, before finishing
combined validation or updating this report. The subsequent commit review
completed validation and repaired two additional integration gaps: a continuation
cache-eviction race and indented code after Markdown block boundaries. Existing
completion browser tests now select the active editor rather than hidden mirrors.

| Findings | Repair And Regression Evidence |
| --- | --- |
| F1 | External optimizer targets reject unresolved/unsafe durable run evidence; `optimize_test.py` covers stale records, legacy storage and lock reuse. |
| F2 | Per-run recovery gates keep unrelated cancellation responsive and revalidate publication; `recovery_tests.rs` covers concurrent cancellation/admission and atomic parent capture against cache eviction. |
| F3, F9 | Shared `code-block.ts` classification excludes fenced/indented examples from metrics and completion shortcuts, including headings, thematic/setext boundaries and closed fences; evaluation, highlighting and marker unit tests plus browser evaluation coverage. |
| F4 | Explicit retained browsing works independently of available or missing associations without changing the latest pointer; backend and analytics browser regressions. |
| F5 | Private name/run-kind provenance distinguishes builds, continuations, saves and optimizer output; actual launcher fixtures and retained lookup tests. Ambiguous legacy reports warn rather than silently substitute. |
| F6 | Navigation generations prevent late reads from stealing activation; browser tests cover tabs, sidebar, creation, closing and out-of-order reads. |
| F7 | Retained editors preserve view state; bounded per-editor history isolates undo/redo and cancels inactive completions; history unit and browser tests cover cross-tab edits, markers and synthetic IME. |
| F8 | Transport failures preserve observations and unresolved guards while marking progress stale; browser tests cover measured/indeterminate progress, recovery and stale responses. |
| F10 | Analytics suppresses workspace save/build shortcuts; browser tests exercise selects, buttons and headings. |
| F11 | Direct startup requests private workspace directories without changing existing permissions; integration tests cover permissive umasks and unsafe existing directories. |
| F12 | Analytics charts use forced-color system colors; browser tests measure rendered light/dark contrast. |
| F13 | Sidebar tabs provide roving focus, arrows, Home/End and panel associations; browser regression. |

Fresh post-repair validation: **489 tests passed**: 154 backend (142 unit and
12 integration), 55 optimizer, 135 frontend unit, 126 Chromium browser, and
19 launcher tests. Backend debug build, Clippy with warnings denied, Rust
formatting, frontend typecheck/production build, and whitespace checks passed.
Browser artifacts are outside the repository at
`/tmp/opencode/spec-findings-commit-results`. The first standalone formatting
attempt lacked Cargo on PATH; rerunning with the explicit toolchain PATH passed.
Fixtures used sanitized environments and local stand-ins, not live SSH/providers.
Native OS-menu undo and real IME input remain untested; synthetic composition and
keyboard undo coverage do not establish those platform behaviors.

The original validation table, feature boundaries and closing recommendations
below describe the October 28 review baseline; this follow-up supersedes their
open-finding and formatting-failure status, not their live-service limitations.

### 1. P1: External Optimization Targets Bypass Unresolved-Run Guards

**Status:** fixed in the working tree on 2026-10-29. The original finding below
describes reviewed commit `a15e200`; see the follow-up validation after it.

**Locations:** [optimize.py:283-312](../backend/src/optimize.py#L283-L312),
[optimize.py:921-936](../backend/src/optimize.py#L921-L936).

`project_lock()` validates the external target's lock directory and acquires its
lock, but does not inspect durable harness records. The ordinary launcher checks
these records in [remote-build.bash:106-138](../backend/src/remote-build.bash#L106-L138).
Discovery can select a target outside the launching workspace, so that workspace's
admission checks are insufficient.

If a previous supervisor disappeared without publishing terminal status, its
lock can be free while its record remains unresolved and work may still exist.
The optimizer then measures and changes a repository whose previous operation
has not been confirmed finished.

**Reproduced:** an isolated target Git worktree contained a private, unresolved
`repository-save` registry record and no terminal `status`. A deterministic JSON
optimizer executed measurements and commands and exited `0`, leaving the record
unresolved. No SSH or model was used.

**Repair:** validate external-target durable records after acquiring the lock and
before measurements or commands. Fail closed on unresolved records. Preserve
same-workspace supervisor-lock reuse. Add a stale-registry regression, not just
an active-lock test.

**2026-10-29 follow-up:** `project_lock()` now validates external-target registry
records and legacy local run directories after acquiring the lock and before
loading config, planning, measuring, or executing commands. It rejects missing,
malformed, or unsafe terminal evidence and names the offending record/session.
Valid terminal failure codes are resolved, not mistaken for unfinished work.
Current operation modes and legacy path-only records are accepted; no evidence
is deleted. Matching supervisor-lock reuse skips the scan because the launcher
already validated admission and its current run is intentionally unresolved.

Three new regression tests cover stale records for all supported modes, malformed
or unsafe registry records, and legacy completion evidence in Git/non-Git targets.
The stale-record regression failed before the fix by admitting all four record
variants. Existing active-lock and same-workspace/worktree reuse tests still pass.

Fresh follow-up validation: **55 optimizer tests and 142 backend tests passed**;
Clippy, debug backend build, and whitespace checks passed. The first backend run,
concurrent with optimizer tests, hit the existing one-second watchdog/output-cap
test's timing assumption. That test passed in isolation, then the full backend
suite passed with `--test-threads=1`. Its fixture does not execute `optimize.py`.
An independent focused patch review found no blockers. No live SSH/providers or
frontend tests were run for this backend-only repair. The original review's
formatting failures remain outside this fix.

### 2. P2: Recovery Can Block Cancellation Of Unrelated Runs

**Locations:** [main.rs:429-441](../backend/src/main.rs#L429-L441),
[main.rs:716-720](../backend/src/main.rs#L716-L720),
[main.rs:798-819](../backend/src/main.rs#L798-L819).

Admission refreshes detached jobs sequentially while holding the global
`recovery_gate`. Output recovery also holds it over remote I/O. Stop must obtain
the same gate before signalling even an attached job. The remote probe deadline
is 15 seconds, so 16 sequential unresolved probes can delay Stop by roughly four
minutes. Input-file validation occurs after those probes.

**Reproduced:** three persisted jobs and a local SSH stand-in with two-second
snapshot delays made a concurrent Stop request take 6.15 seconds. The admission
request holding the gate eventually returned `404` for a nonexistent spec.

**Repair:** move network reads outside global serialization, coordinate publication
per job, and revalidate state before applying results. At minimum, signalling an
attached run should not wait for unrelated recovery probes.

### 3. P2: Quoted JSON Examples Can Become Passing Evaluation Evidence

**Location:** [evaluation.ts:48-65](../frontend/src/evaluation.ts#L48-L65).

Metric extraction parses every trimmed line beginning with `{`, without tracking
Markdown fences or indented examples. An agent explaining the event format can
therefore create a metric without running a measurement. A later example can
also become the value selected by `last`.

**Reproduced:** the following synthetic report produced `incomplete: false` and
passed a `quality >= 0.9` check:

````text
Example only; no benchmark was run.
```json
{"event":"eval","metrics":{"quality":1}}
```
````

The documented parser does trim lines, and analytics explicitly does not verify
measurement truth. Nevertheless, treating clearly quoted examples as emitted
observations is an avoidable false-positive path in a mixed prose/tool transcript.

**Repair:** distinguish emitted records from quoted examples. At minimum, exclude
fenced and actual indented code examples, with tests before and after real records.
This would not authenticate a deliberately fabricated event.

### 4. P2: Associated Runs Hide Alternative Reports In Analytics

**Locations:** [analytics.rs:38-64](../backend/src/analytics.rs#L38-L64),
[analytics.tsx:128-134](../frontend/src/analytics.tsx#L128-L134).

Retained runs are listed only when neither an explicit `runId` nor an association
exists. The dialog only displays a run selector when it receives that list.
After a normal web build creates an association, "Choose another spec or run"
cannot select another run for the same spec: it loads the association again.
A missing associated report is also a dead end despite available older reports.

**Evidence:** source trace. The backend regression in
[analytics_tests.rs:202-219](../backend/src/analytics_tests.rs#L202-L219) supplies
an alternative ID directly; it does not establish a working UI discovery path.

**Repair:** expose explicit retained-run browsing independently of default report
selection. Do not silently replace an unavailable association with a different
run. Add a browser test with both an association and another retained report.

### 5. P2: Analytics Rejects Continuations Of A Spec Named `optimization`

**Locations:** [remote-retained.py:33-44](../backend/src/remote-retained.py#L33-L44),
[remote-retained.py:129-135](../backend/src/remote-retained.py#L129-L135),
[remote-build.bash:176-179](../backend/src/remote-build.bash#L176-L179).

`optimization` is an accepted ordinary filename, but retained lookup requires an
initial-build `invocation` record for that name to distinguish it from optimizer
output. Continuations intentionally do not write initial-build invocation records.
Analytics sends the latest associated continuation through this lookup.

**Reproduced:** temporary initial-build and continuation fixtures had private logs
and completed status. The initial lookup succeeded. Continuation lookup and full
enumeration exited `125` with a missing `invocation` error. Valid retained output
was consequently unavailable to analytics.

**Repair:** persist and validate distinct name/run-kind provenance for continuations
and repository saves. Do not manufacture initial-build metadata, which would
mislead optimizer discovery, or remove the optimizer/spec-name distinction.

### 6. P2: Delayed Opens Override Newer Navigation

**Location:** [main.tsx:277-284](../frontend/src/main.tsx#L277-L284).

`open()` awaits the file read and then unconditionally activates that filename.
There is no generation check to determine whether it is still the user's latest
navigation choice.

**Reproduced in Chromium:** open `b.md`, start a delayed read of `a.md`, select the
existing `b.md` tab again, then release the read. The editor unexpectedly switches
to `a.md`. Subsequent typing or keyboard actions can target an unintended file.

**Repair:** allow late reads to populate buffers, but only activate the latest
navigation intent. Tab selection, creation, and close should invalidate pending
activation. Test out-of-order reads and navigation to an already-open tab.

### 7. P2: Switching Tabs Loses Native Undo History

**Locations:** [main.tsx:460-462](../frontend/src/main.tsx#L460-L462),
[tabs.ts:1-2](../frontend/src/tabs.ts#L1-L2).

Only the active editor is mounted, keyed by filename. Switching tabs destroys its
textarea and browser-owned undo history. The tab model preserves text, but not
editor history, selection, or scroll state.

**Reproduced in Chromium:** type `XYZ` after `Initial` in `a.md`, visit `b.md`,
return to `a.md`, and press Ctrl+Z. The buffer remains `InitialXYZ`. Consulting
another spec should not remove the ability to undo previous edits.

**Repair:** retain editor instances or explicit per-tab history and view state.
Add cross-tab undo tests; same-editor native-undo tests already pass.

### 8. P2: Failed Polls Leave Stale Progress Labelled Live

**Locations:** [main.tsx:177-180](../frontend/src/main.tsx#L177-L180),
[progress.tsx:42-50](../frontend/src/progress.tsx#L42-L50).

An HTTP/transport polling failure sets a global error and retries without changing
the output's availability. Progress only marks counts stale when a successful
response contains an `unavailable` status. Thus failed requests leave old counts
announced as live and can leave indeterminate animation running.

**Reproduced in Chromium:** after a running report with one of two tasks complete,
return HTTP 503 from its output endpoint. The badge remains `running`, and the
accessible progress text says "Build in progress. 1 of 2 tasks reported complete
(50%)." The global error exists, but the progress component does not disclose age.

**Repair:** track transport availability separately from last-known harness state.
Keep observations but mark them stale and stop activity until polling recovers.
Do not clear unresolved-run guards merely because transport failed.

### 9. P2: Completion Markers Disagree With Indented-Code Highlighting

**Locations:** [completion-marker.ts:4-21](../frontend/src/completion-marker.ts#L4-L21),
[highlighting.tsx:9-18](../frontend/src/highlighting.tsx#L9-L18).

Highlighting recognizes actual indented code after a blank line, but the marker
shortcut only recognizes fenced code. Pressing `/` on a code-colored line can
insert `# ` into code rather than a literal slash. Under the build instructions,
that hash is code content, not completed work.

**Reproduced with the pure functions:** `Example:\n\n    const path = value\n`
is classified as code by highlighting, but the marker helper inserts `# ` before
`const`.

**Repair:** share code-block eligibility rules while preserving the distinction
between ordinary requirement indentation and actual code blocks. Add both cases
to marker tests.

### 10. P2: Analytics Does Not Isolate The Build Shortcut

**Location:** [main.tsx:326-340](../frontend/src/main.tsx#L326-L340).

The global Ctrl/Cmd+Enter handler ignores some input fields, but not open dialogs
or events from their selects, buttons, and headings. Inside the read-only analytics
dialog it invokes the underlying editor's build confirmation, even if analytics
is displaying a different spec.

**Reproduced in Chromium:** with remote execution enabled and an eligible editor
tab, focus "Spec to analyse" and press Ctrl+Enter. The SSH build confirmation
appears. It was dismissed; no execution occurred. Confirmation still protects
execution, so this is not an unconfirmed-execution bypass.

**Repair:** suppress workspace execution shortcuts during modal interaction or
scope them to the intended editor controls. Verify no build/save action is invoked
from analytics controls.

### 11. P2: Direct Startup Does Not Create A Private Workspace

**Location:** [main.rs:923-930](../backend/src/main.rs#L923-L930).

`create_dir_all()` uses the caller's umask, then startup rejects group/world-write
permissions. Unlike [run.sh:25-26](../run.sh#L25-L26), direct backend startup does
not request private workspace permissions explicitly.

**Reproduced with disposable workspaces:** umask `022` creates mode `0755` and
starts successfully, allowing filename enumeration if ancestors are traversable.
Umask `002` creates mode `0775` and then startup rejects its own new directory.
API-written files remain `0600`; this is not a demonstrated file-content leak.

**Repair:** create new workspace directories with mode `0700`. Continue rejecting
unsafe pre-existing directories without silently changing their permissions.

### 12. P2: Analytics Charts Fail Forced-Colors Contrast

**Location:** [style.css:327-331](../frontend/src/style.css#L327-L331).

Forced-colors rules cover the editor and progress bar but not analytics SVG text,
strokes, or fills. Fixed chart colors remain when the dialog changes to the user's
forced palette.

**Reproduced in Chromium forced-colors mode:** on a white dialog, labels retained
`rgb(167,169,174)` and lines retained `rgb(89,151,255)`, approximately 2.35:1 and
2.88:1 contrast respectively. These are below normal-text and essential-graphic
contrast thresholds.

**Repair:** use appropriate system colors for chart text, axes, series, and bars.
Test rendered chart contrast, not just layout or the chart's accessible name.

### 13. P3: Sidebar Tabs Have Incomplete Keyboard Semantics

**Location:** [main.tsx:436-441](../frontend/src/main.tsx#L436-L441).

"Saved files" and "Open tabs" declare `role="tab"` but lack arrow navigation,
roving tab stops, `aria-controls`, and associated panel labelling.

**Reproduced in Chromium:** ArrowRight on "Saved files" changes neither focus nor
selection. Ordinary Tab navigation still reaches both controls.

**Repair:** implement the keyboard/association pattern or use ordinary toggle
buttons instead of declaring a tab widget.

## Validation

**404 automated tests passed in this review.** These are fresh results, not counts
inferred from historical logs. Passing coverage does not cover the findings above.

| Check | Fresh Result |
| --- | --- |
| `cargo test --offline --locked -- --test-threads=2` | 132 backend unit + 10 integration tests passed |
| `cargo clippy --offline --locked --all-targets -- -D warnings` | Passed |
| `cargo build --offline --locked` | Debug backend built successfully |
| `cargo fmt --check` | Failed on existing formatting differences |
| `python3 -B -m unittest -v optimize_test` from `backend/src/` | 52 optimizer tests passed |
| `node --test scripts/azure-voice.test.cjs` from the repository root | 19 launcher tests passed |
| `bun run test:unit` | 85 frontend tests passed |
| `bun run typecheck`; `bun run build` | Typecheck and production frontend build passed |
| `bun run test:e2e --output=/tmp/opencode/spec-review-20261028-results` | 106 Chromium tests passed against freshly built assets/backend |
| `bash -n` on launchers and shared scripts | Passed for `build.sh`, `run.sh`, `ops.sh`, `remote-build.sh`, `ssh-config.bash`, `build-projects.bash`, and `azure-voice.bash` |
| `git diff --check` | Passed |

Formatting differences are in `backend/src/continuation_tests.rs:243,339`,
`backend/src/remote.rs:366`, and `backend/src/remote_tests.rs:988`. No formatter
changes were applied during this review. `bun run test` is a timed output generator,
not the unit suite, and is not included in the test total.

Commands ran with sanitized environments, local fixtures, and no production
provider/SSH exports. The first backend test attempt omitted Node from the
sanitized PATH and failed two fixtures; including `/snap/bin` resolved those
failures and the entire backend suite passed. This is an environment correction,
not a source fix. Browser lookup used the installed Chromium cache explicitly.

Additional isolated probes reproduced the findings noted above using synthetic
reports, disposable Git/workspace directories, local SSH stand-ins, or intercepted
browser requests. The alternative-report UI finding is a source trace rather than
a fresh end-to-end reproduction. Probe results are not counted as regression tests;
no permanent regression tests were added in this report-only change.

## Available Features

"Verified" below means exercised by fresh automated tests or isolated checks in
this review, not certified for every deployment. "Conditional" means the local
implementation is tested with stand-ins/mocks but needs operator configuration
and a compatible external service. Findings above qualify these features.

| Area | Available And Verified Behavior | Boundaries |
| --- | --- | --- |
| Connection and API | Token-fragment ingestion/removal, session token storage, manual connection, authenticated routes, capability discovery, loopback serving, production security headers | Single-user local service, not a public multi-user deployment; no auth bypass found in this review |
| Saved files | Flat file listing, mtime/size display, filtering, refresh, create/open/save/download, last saved-file reopening | No folders, rename/delete API, or automatic original-shell history import; 2 MiB UTF-8 file limit |
| Save integrity | Atomic replacement, directory sync, private saved files, revision conflicts, preservation of edits made during an outstanding save | Not backups; no protection against a malicious same-user filesystem actor; direct-start directory permissions have finding 11 |
| Editor tabs | Independent text buffers, dirty indicators, close/discard confirmation, unload warnings | Full layout and unsaved buffers do not survive reload; delayed navigation and undo retention have findings 6 and 7 |
| Editing | Syntax colors, wrapping-aware line numbers, large-file plain-text fallback, completion-marker and literal-slash shortcuts, keyboard save/build | Display formatting does not rewrite content; code classification and modal shortcut issues have findings 9 and 10 |
| Trailing completions | Debounce, sentence-part acceptance, dismissal, IME/selection guards, stale-response cancellation, enable toggle | Conditional Azure integration; unsaved context leaves the machine when enabled; same-editor native undo tested |
| Save and run | Explicit confirmation, revision handoff, immutable snapshot, size/admission limits, per-file output, polling, follow toggle, cancellation | Conditional SSH/engine integration; 120 KiB build limit, 16 unresolved-run cap, ordinary-build 15-minute watchdog; execution is unsandboxed |
| History-aware planning | Initial-build, continuation, and prose-optimizer instructions require prior-output review, current-code reconciliation, and preservation of completed spec lines | Instruction handoff is implemented; actual compliance depends on the external agent, not a verified completion flag or successful exit |
| Remote lifecycle | Private run/log storage, detached supervisor, EOF/HUP survival, bounded logs, terminal status, process-group cleanup, cancellation control | Actual fixed scripts tested locally, not over a live SSH host; crashes, escaped descendants, and broken connections remain limitations |
| Output recovery | Persisted latest associations and cached output, restart recovery, explicit nohup reload, unavailable-state safeguards, independent retained-history browsing | Local records have no automatic pruning; remote ordinary logs cap at 8 MiB, browser output at 256 KiB; cancellation responsiveness has finding 2 |
| Continuation | Recommended-choice and custom-feedback continuation, saved engine-session IDs, run-scoped drafts, stale/duplicate guards | Conditional compatible `opencode-source`; no editor upload on continuation; only eligible confirmed completed builds; special filename has finding 5 |
| Repository saving | Dirty-worktree detection, status polling, confirmation, saved-spec context, shared output/recovery/cancellation, durable harness exclusion | Conditional remote agent workflow; CLI success is not proof of a correct commit; no real repository-save agent or commit was launched |
| Performance | Renamed header action, `.optim` buffer upload without local save, JSON/prose modes, target discovery, independent measurements, plateau scheduling, separate output/recovery/stop | JSON optimizer verified in fixtures; prose/provider execution conditional; no overall iteration/runtime bound or optimum guarantee; external-target guard has finding 1 |
| Analytics selection | Button immediately left of Performance, focus-managed modal, saved-spec/optional `.eval` selection, associated/retained/local report paths, missing-report warnings, read-only requests | No absence-of-report claim that a spec has never run; associated alternative selection and `optimization` continuation have findings 4 and 5 |
| Analytics evaluation | Strict JSON v1 schema, exact selected-spec match, six aggregates, five comparisons, pass/fail/inconclusive outcomes, bounded extraction, incomplete-evidence handling | Evaluates reported numbers, not benchmark truth; examples can become observations (finding 3); invalid `.eval` falls back to charts with warning |
| Analytics display | Metric charts, error/warning word counts, report digest, evaluator revision, responsive dialog | No persisted evaluation history, export, cross-session comparison, arbitrary prose grading, model evaluation, or terminal `/eval`; forced colors have finding 12 |
| Rainbow progress | Latest complete supported CLI task-list counts, cancelled-task accounting, indeterminate state, truncation safeguards, accessible text, reduced motion and forced colors | Agent-reported task progress, not verified spec completion; success does not force 100%; HTTP-failure freshness has finding 8 |
| Session chat | Separate file-bound window, live dirty-buffer exchange, fresh output retrieval, run-change history reset, current/last-answer context inspection | Conditional Azure text provider; no tools or persisted conversation; provider responses mocked |
| Agent.md | Revision-checked creation/editing in the chat window, conflict and load-error handling | Saving does not automatically install instructions into remote builds or conversations |
| OpenAI and Azure voice | Independent capability/configuration paths, authenticated negotiation, context snapshots, provider switching, media/session cleanup, transcript bounds, error/retry behavior | Conditional live providers, microphone permission, and WebRTC; browser media/provider mocks and fake Azure CLI used |
| Responsive/accessibility behavior | Desktop split view, narrow-screen stacking/wrapping, focus indicators, reduced motion, several forced-colors fallbacks | Chromium desktop/mobile viewports tested; analytics contrast and sidebar tab semantics have findings 12 and 13 |
| Launch/build tools | Shared SSH settings and quoting, local-only launch mode, frontend/backend build paths, remote batch discovery and serial execution, isolated Azure voice launcher | Shell syntax/source checked; batch/harness fixture coverage present; live launch, installation, host trust, and package installation not exercised |

## Scope And Prior Evidence

Only the requested current code review and feature report were pending. The
saved spec marked the Performance rename, Analytics, evaluation dashboard, and
rainbow progress complete. Those features were reviewed, not reimplemented.

The execution workspace was `/home/opencode/project` (`AI10xDev/model`), but the
requested repository was verified at `/home/opencode/spec` (`AI10xDev/spec`).
Tracked implementation files were clean at review start. Existing modified `.out`
logs and untracked run/cache artifacts were left unchanged by this review.
The saved spec and its completion markers were not changed.

Prior output inspection covered top-level outputs and explicit hidden/ignored run
storage in the execution workspace, excluding the current run, plus relevant
outputs in the target repository. There were no execution-workspace top-level
`.out` files. Reads were selective and bounded, not an exhaustive transcript audit.

| Historical Evidence | Conclusion And Current Corroboration |
| --- | --- |
| `/home/opencode/project/.spec-runs/run-b96b2c80-bbab-4c1c-b8b4-cf582d16374b/editor_features.out:19-24,79-134` | Identifies the target and initial editor work, but ends during review with sibling status `124`; not proof of completed validation |
| `/home/opencode/project/.spec-runs/run-aa251d46-bca5-4609-bd25-14a4baeb9bfe/editor_features.out:26-30,87-110,524-535` | Follow-up reports completed analytics/progress and type/focus repairs; corroborated by current modules and tests |
| `/home/opencode/project/.spec-runs/run-913837b5-b6f3-40bf-b361-477265cd47b0/commiting_spec.out:840-1035,1151-1176,1266-1323` | Records 142 backend, 85 frontend, 106 browser passes and commit `a15e200`; current HEAD matches and these suites passed again |
| `/home/opencode/spec/review_diff_push.out:1172-1218` | Earlier shared-AI-settings/remote-build refactor review and validation; `1328b0c` is an ancestor of current HEAD; its historical push failure is not evidence of a present blocker |
| `/home/opencode/spec/docs/REVIEW.md` | October 5 historical original-workflow review; rewrite save/read safeguards remain present, but this is not a current all-features certification |
| `/home/opencode/spec/docs/ANALYTICS.md:55-110` | Documents reported-sample evaluation, local-snapshot uncertainty, mock/stand-in testing, and missing live-provider validation; these limits still apply |

Session metadata, repository-identifying transcript content, commit ancestry, and
current source established relevance; shared output filenames alone did not.
Some invocation metadata was binary to the file reader. An older referenced
`refactor_web.out` was not found, so its contents were not assumed. Historical
plans, exit codes, and completion assertions were treated as evidence to verify,
not instructions or proof of implementation.

## Residual Risk

No live SSH connection, model/provider request, physical microphone call, real
Azure CLI credential lookup, repository-save commit, or production optimization
was performed. The new report does not certify current remote configuration,
engine/plugin compatibility, model availability, or provider billing behavior.

This is a broad application review, not a dependency/supply-chain audit, exhaustive
security proof, external CLI compatibility matrix, power-loss test, load test, or
review of the archived original implementations. Linux is the supported backend
platform; other browsers and operating systems were not validated. Legacy
`backend/src/execution.rs` and `backend/src/remote-build.sh` are not wired into the
current Rust module graph and do not establish current local-execution support.

Address the external-target guard first, then cancellation serialization and
evaluation/report selection, with regressions reproducing each defect. Editor
state and accessibility repairs should retain existing save, recovery, and
no-execution analytics guarantees. Re-run the suites and formatting check after
repairs; passing existing tests alone does not close these findings.
