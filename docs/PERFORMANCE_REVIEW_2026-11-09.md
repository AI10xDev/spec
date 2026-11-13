**Performance Review**
Date: November 9, 2026 (UTC).

Target: the button with `title="performance"` in `/home/opencode/spec`, not the Candle application in `/home/opencode/project`.

Scope: workflow, implementation, Playwright coverage, supporting local tests, and operational limitations. No application or repository test code was changed. Local build artifacts were regenerated and isolated diagnostic evidence was created. No live Performance job, SSH connection, model-provider request, or GPU training was initiated.

Source references below are relative to `/home/opencode/spec` unless absolute. The worktree contained concurrent edits; line numbers describe the source inspected during this review, not an immutable release.

**Findings**
1. **Medium: session completion does not establish successful RL execution.** `backend/src/performance-session.py:181-184` checks the OpenCode process exit, absence of agent error events, and a valid session ID. It does not require a training command to execute, validate `head.safetensors` or `validation.json`, or independently verify reported metrics. An agent can correctly report missing prerequisites and still finish with exit zero. Retained evidence demonstrates the distinction: `/home/opencode/project/.performance-runs/run-cce1875b-5314-434b-9ca2-03165e384b1f/performance.out:52` says "No training or validation was started," while its sibling `status:1` is `0`. This is historical evidence, not a fresh inventory of missing inputs. Impact: a user interpreting `completed` as "the RL experiment completed" can draw an unsupported conclusion. Recommendation: distinguish builder-session outcome from workload outcome; require explicit, validated workload evidence before presenting training success.

2. **Medium: accepted Unicode instructions can fail remote request-size validation.** The browser checks raw UTF-8 instruction bytes at `frontend/src/main.tsx:809`; Rust checks compact encoded request bytes at `backend/src/main.rs:449`; the remote launcher canonicalizes the project and reserializes with Python's default ASCII escaping at `backend/src/remote-build.bash:154-158`. Fresh arithmetic reproduction using 180,000 U+00E9 characters produced 360,000 instruction bytes, 360,076 compact request bytes, and 1,080,082 remote serialized bytes. The first two fit the 1,048,576-byte limit; the third does not. This reproduces serialization behavior, not a live SSH rejection. Impact: substantially sub-limit multilingual instructions fail later with the generic remote rejection at line 164. JSON overhead can also reject near-limit ASCII content. Recommendation: use a consistent encoding and clearly define whether the limit applies to instructions or the complete request; retain an authoritative backend check and add cross-layer boundary tests.

3. **Low: obsolete polling errors remain visible after successful recovery.** At `frontend/src/main.tsx:526-533`, successful polling updates the output but does not clear the error set at line 537. A fresh isolated Chromium probe reproduced this at 1440, 390, and 320 px: a 503 response was followed by successful running and completed responses; output and badges recovered, but "Performance polling failed: Temporary poll failure" remained. No clicks or dismissals were used. `frontend/e2e/optimize.spec.ts:372-389` checks recovered output but not disappearance of the obsolete alert. Explicit recovery clears the error at `frontend/src/main.tsx:481`; automatic polling does not. Recommendation: clear only the applicable polling error after successful polling, without erasing unrelated cancellation errors, and assert that behavior in Playwright.

4. **Low: a backend Performance conflict can direct users to the wrong inspector.** `backend/src/main.rs:746` tells users to open **Active runs** even when the blocker belongs to the separate Performance state. That inspector lists spec and legacy optimization runs, not Performance sessions. Impact: server-side races or direct requests can return recovery advice that cannot locate the reported blocker. The browser's own admission check usually gives correct Performance-specific guidance. Recommendation: make server conflict guidance namespace-aware and test the returned message.

These findings are documented, not fixed. The passing regression suite does not invalidate them.

**Additional Risks**
- Execution restrictions are agent instructions, not sandbox guarantees. `backend/src/performance-session.py:116-117` enables automatic tool approval and automatic recommended answers. The explicit confirmation is therefore a meaningful authorization boundary.
- The supervisor has no overall Performance execution timeout. It emits keep-alives while waiting (`backend/src/remote-supervisor.bash:69-80`). A long-running or stuck builder can keep consuming resources until stopped or otherwise terminated.
- Supervisor cleanup gives the logger approximately one second to drain, can forcibly terminate it, and ignores its final result before publishing the worker status (`backend/src/remote-supervisor.bash:25-39`). Incomplete logging is a source-level risk; this review did not reproduce lost output.
- Performance logs are not subject to the ordinary build's first-8-MiB capture limit (`backend/src/remote-supervisor.bash:46-50`). Long runs therefore warrant disk monitoring. The browser's 256-KiB recovered-output tail is a separate presentation limit.
- The current output pane includes concurrent detached-window work (`frontend/src/main.tsx:993-1007`). The selected Performance suite did not exercise Performance in a detached output window.

**Prior Evidence**
Previous outputs were discovered in hidden/ignored run storage before planning. There were no top-level `.out` files in the execution workspace. The current run directory was excluded from prior-output discovery; its saved `snapshot.md` was read unchanged. The snapshot requests this review, not implementation.

| Evidence | What was established | Limitation |
| --- | --- | --- |
| `/home/opencode/project/.spec-runs/run-34706a79-ac67-47c6-87e3-93b8437b44f7/report_performance.out:395-727` | Prior review of this exact button; project-based launch, independent lifecycle, fresh builder runner, and result/serialization concerns | November 4 evidence; its Playwright suite was inspected, not rerun |
| Same report, lines 705-720 | Historical 9 Rust and 9 Python Performance passes; 28 project-search passes and one optional skip; TypeScript pass | Not fresh validation for this sweep |
| `/home/opencode/project/.spec-runs/run-9d65cb1c-b766-447c-8610-50b8b0b2bf05/review.out:791-825` | Historical overview reports 260 Chromium and 174 frontend unit passes, plus additional stale-alert reproduction | Broader historical run; individual delegated browser results are not embedded in this transcript |
| `/home/opencode/project/.spec-runs/run-67b4ffd1-eedf-4455-aaab-f231797709d8/performance_out.out` | Earlier unresolved investigation of missing `ref_web` run storage | Ends without a final resolution; not proof of repair |

Current code corroborates the completed project-selection, optional-instruction, independent admission/recovery/cancellation, and fresh-session work. These features were not reimplemented. Earlier session-versus-workload and Unicode concerns remain supported by current source; the stale-alert defect was freshly reproduced. Some invocation/provenance files were binary and not readable through the file reader, so relevance was established using transcript content, timestamps, and session identifiers.

**Workflow**
The button is an entry point for a fresh agent session that attempts an already-built Gemma RL workflow. It is not a page-speed benchmark, a direct training executable, or the standalone distillation pipeline.

```text
Performance header button
  -> Open form; focus Project folder
  -> Enter path, optionally Search with Explore
  -> Optionally include current unsaved editor instructions
  -> Validate inputs and Performance-only availability
  -> Confirm trusted execution and possible costs
  -> Recheck active/unresolved Performance sessions
  -> POST /api/performance
  -> Rust admission, request capture, dedicated recovery state
  -> SSH launcher, canonical project validation, shared project lock
  -> Detached supervisor -> performance-session.py
  -> Fresh OpenCode build agent -> inspect and attempt configured RL
  -> Poll Performance output and status
  -> Session terminal state, or scoped Stop/recovery
```

1. **Open the form.** The header's visible name is **Performance**, its exact title is lowercase `performance`, and it exposes `aria-controls="performance-form"` and `aria-expanded` (`frontend/src/main.tsx:884`). Opening it does not submit work or invoke project search. The header is disabled in Settings; the run control has additional guards. The project input receives focus. Opening the form resets editor-instruction opt-in to unchecked. Cancel closes the form and returns focus to the header.

2. **Select the remote project.** Enter a path relative to `SPEC_SSH_WORKSPACE`, or an explicit absolute remote path. Submission trims surrounding whitespace. Rust rejects empty paths, more than 4096 bytes, control characters, and relative parent traversal. The remote side resolves the path, verifies an existing directory, and rejects relative symlink escapes. Explicit absolute paths can select projects outside the workspace. Paths are data, not shell expressions; shell expansion is not implied.

3. **Optionally search.** **Search with Explore** posts a name query to `/api/projects/search`; typing alone makes no model request. `ProjectPicker` accepts 1-100 UTF-8 bytes of printable name text, not a path (`frontend/src/project-picker.tsx:30-57`). Selecting a result only fills the path. Duplicate names are distinguished by full paths. Loading, empty, error, retry, root, and truncation states are displayed. Editing or closing aborts the browser request and rejects stale results, but does not prove that an already submitted remote/model operation stopped.

4. **Understand search scope.** The documented search root is the parent of the resolved remote workspace, allowing sibling projects. Inventory is bounded to three levels and 3000 entries; excluded locations include hidden directories, symlinks, and common dependency/build trees. Up to 40 substring candidates are ranked to at most 20 results by an Explore agent with tools denied. Only the query and candidate paths, not project contents, are sent. Names and paths may still be sensitive, and model use can incur costs (`PERFORMANCE.md:54-99`). Fresh browser coverage mocks this service; remote ranking quality was not tested.

5. **Optionally include instructions.** No editor tab is required for project-only execution. If **Use current editor as instructions** is checked, a selected tab and nonblank, NUL-free content are required. Any filename extension and prose or JSON content are accepted. The request captures the current buffer, including unsaved edits; Performance itself does not save it locally. Independent autosave retains its own normal behavior. The displayed 1-MiB limit has the cross-layer inconsistency described above.

6. **Check availability.** The form blocks submission while recovery is unknown, the Performance list is unavailable, a Performance session is active/unresolved, a request is in flight, project search is active, or remote execution is disabled. `performanceBlocked` combines its own recovery, list, and session state (`frontend/src/main.tsx:139-140`). Ordinary spec failures, unresolved spec runs, spec saves, and spec continuation do not directly block this namespace. A conflicting harness in the same physical Git worktree or non-Git project can still prevent remote execution.

7. **Confirm and submit.** The synchronous submission reference is set before confirmation to prevent same-tick duplicates. The dialog identifies the project and optional editor instructions, warns about tool execution, artifact writes and compute/provider costs, forbids silent rebuild/download/fabrication, and identifies scoped Stop. Dismissal sends no request. Acceptance triggers a fresh `GET /api/performance/runs`; newly discovered blockers prevent the subsequent POST (`frontend/src/main.tsx:796-828`). Backend admission remains authoritative against races.

8. **Admit and launch.** Rust validates the request and captures the selected execution-provider profile, then uses the dedicated Performance state rather than spec state (`backend/src/main.rs:431-498,543-576`). The selected runner is embedded `performance-session.py` (`backend/src/main.rs:645-651`). The remote launcher transfers the request, validates and pins the canonical project, coordinates shared project locks/unresolved-run guards, and starts detached supervision. Missing or uncertain remote evidence is not automatically treated as completion.

9. **Run a fresh builder session.** The Python runner requires private request-file properties, a bounded request, and no existing session ID. It removes inherited spec invocation hooks while preserving ordinary user configuration. It chooses `opencode-source` or `opencode` and launches `run --dir PROJECT --agent build --format json` without `--session` or `--continue` (`backend/src/performance-session.py:78-146`). A configured provider is applied explicitly; invalid selected-provider setup fails rather than silently falling back.

10. **Inspect and attempt RL.** The prompt directs the agent to the existing `gemma4-policy` documentation and prebuilt CLI. It requires configured local model/tokenizer, training and independently held-out validation data, actual Sol evaluator, explicit CPU/CUDA prerequisites, and a new output directory. It prohibits implementation, rebuilding, unconfigured downloads, fabricated data/evaluators, and distillation substitution. Missing prerequisites should produce an honest report rather than invented measurements (`backend/src/performance-session.py:15-44`). These are prompt requirements, not independently enforced workload checks.

11. **Display and poll output.** Once POST returns an ID, the UI selects **Performance output**, enables Follow, closes the form, and displays a starting/running state. Active-list polling is scheduled after about 2500 ms; recoverable running output after about 650 ms; other recoverable/error states after about 2500 ms. These are delays after request processing, not guaranteed refresh deadlines. Unavailable output preserves previous text. A terminal response stops that output poll and refreshes admission state. The output can be switched independently from file logs; Performance does not expose ordinary spec continuation.

12. **Recover or stop.** Reload recovers the latest session and resumes polling when recoverable. **Refresh Performance runs** refreshes admission information; **Load Performance output** inspects a blocker; **Recover latest Performance** reloads the latest session. **Stop run** sends a cancellation request for the displayed Performance ID, then relies on subsequent status evidence. It does not cancel a spec run or its queued feedback. Merely closing the form or switching output does not cancel the job. Local recovery uses `.performance-output`; remote files use `.performance-runs` (`PERFORMANCE.md:26-50`).

**API Contract**
All paths below require the application's authentication. The browser suite verifies the outgoing bearer header, but mocked requests do not prove server-side authentication enforcement.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/performance` | Start a fresh Performance builder session; returns a run ID |
| GET | `/api/performance` | Recover latest Performance output, or null |
| GET | `/api/performance/runs` | List active/unresolved Performance sessions |
| GET | `/api/performance/runs/{id}` | Read that session's output and status |
| POST | `/api/performance/runs/{id}/cancel` | Request scoped cancellation |
| POST | `/api/projects/search` | Explicit Explore project-name search |

Project-only request:

```json
{"project":"team/my-project","spec":null}
```

Optional unsaved-instruction request:

```json
{"project":"/remote/team/my-project","spec":{"name":"instructions.md","content":"Run the configured existing RL workflow; report missing prerequisites."}}
```

The legacy `/api/optimize` routes and `backend/src/performance.py` retain separate behavior. The standalone runner's dataset/distillation manifest, metrics, and artifact checks must not be attributed to this button (`PERFORMANCE.md:44-47,101-105`).

**Playwright Review**
Primary suite: `frontend/e2e/optimize.spec.ts`. Its legacy filename contains the current Performance tests.

The suite starts a real local Rust debug server with a temporary workspace and serves `frontend/dist` (`optimize.spec.ts:14-45`). It disables SSH configuration and AI environment-file loading. The browser helper intercepts `/api/**` and supplies fixture responses (`optimize.spec.ts:52-89`). Therefore it tests the rendered UI, browser events, outgoing requests, and client-side state transitions, not real Performance API execution.

The fixture text "Gemma RL completed: measured reward 0.92" at line 48 is invented test data. It is not a measured reward from this validation.

| Coverage | Source lines | Assertions and value |
| --- | --- | --- |
| Project-only desktop/mobile | 98-150 | Six combinations of 1440/390/320 px and selected/no editor; exact title, keyboard Enter, focus, ARIA, no automatic writes, trimmed path, layout bounds |
| Cancel/reopen | 152-164 | No confirmation or writes; focus restoration; editor opt-in resets |
| Submission lifecycle | 166-216 | Optional prose, risks confirmation, same-tick duplicate prevention, independent Save controls, polling, Follow, authorization header |
| Validation and uploads | 218-264 | Missing project/tab, blank/NUL/oversized content; unsaved instructions with four filenames; no implicit file creation |
| Dismissal and editor isolation | 266-336 | Confirmation cancellation, drafts preserved, file/Performance logs independent, edits during submission |
| Stop and submit errors | 337-370 | Correct cancel endpoint, terminal status, old logs retained on failure, retry clears submission error |
| Polling and recovery errors | 372-428 | Poll output recovery, cancel failure, reload, initial 404/503, explicit recovery; missing obsolete-alert assertion |
| Availability and spec independence | 430-532 | Disabled execution cannot be bypassed via form submission; unrelated spec states/list failures and held autosave do not block Performance; Settings behavior |
| Responsive output controls | 534-548 | Header, output selector and Stop fit 390/320 px widths |
| Lifecycle isolation and races | 550-758 | Bidirectional scoped cancellation, queued-feedback preservation, held submissions, own blockers, unresolved ref_web, save-error preservation, admission recheck, list retry, late recovery responses |
| Explore success and layout | 767-841 | Explicit calls only, duplicate-name selection, keyboard access, three widths, pending-search guard, editing/local save remain available |
| Explore validation and errors | 843-898 | UTF-8 query limit, manual-path independence, no matches, retry, root/truncation states, long mobile results |
| Explore stale responses | 906-949 | Request abortion plus identity guard after editing and closing through Cancel/Performance/Settings |

Strengths: semantic role/label selectors, exact-title coverage, actual keyboard interaction, explicit request-body assertions, held responses for races, and narrow-screen geometry checks. Controlled fixture responses make the suite fast and repeatable. Some tests use deterministic browser clocks instead of wall-clock waiting.

Limits: Chromium only; viewport emulation is not physical mobile-device testing. Keyboard/ARIA assertions are useful but are not a screen-reader or full accessibility audit. There are no benchmark thresholds for click latency, page performance, training speed, reward quality, or GPU memory. The suite expects already-built frontend/backend artifacts; `playwright.config.ts` has no build orchestration or persistent reporter configuration. `bun test` is not the Playwright command; `test:e2e` is the relevant package script.

**Fresh Validation**
Evidence root: `/tmp/opencode/performance-validation-Dun94YlM/`.

| Check | Result | Process elapsed |
| --- | --- | --- |
| Frontend `bun run build`, including TypeScript | Passed | 14.97 s |
| Backend `cargo build --locked --offline` | Passed, incremental/current | 0.46 s |
| Chromium `e2e/optimize.spec.ts`, one worker | 51 passed; zero failed, skipped, or flaky | 58.00 s |
| Python `performance_session_test.py` | 9 passed | 2.54 s |
| Rust `performance_tests` filter | 9 passed; 326 other tests filtered out | 10.37 s |
| Independent stale-alert probe | Defect reproduced at all 3 widths | 19.85 s |
| Unicode serialization arithmetic | Cross-layer mismatch reproduced | Not timed |

Total selected regression tests: **69 passed**. The additional diagnostic completed successfully while demonstrating a UI defect; it is not counted as three product passes. Playwright's internal duration was 56.801 s, with no retries. Some commands ran concurrently, so the process times should not be summed as sweep wall-clock duration.

Python coverage includes project/request validation, large prompts and bounded event lines, fresh builder/environment cleanup, session identity and agent errors, CLI fallback, selected-provider handling, and local transport detach/cancellation. Rust coverage includes dedicated validation and persistence, independent admission/recovery gates, unresolved-spec isolation, reverse isolation across shutdown/restart, scoped cancellation including stalled attachment delivery, remote identity mismatches, terminal evidence validation, and provider cleanup.

These supporting tests use local transport fixtures and mock OpenCode executables. They exercise more backend behavior than the browser mocks, but still do not establish production SSH, provider, or training correctness. The historically intermittent stalled-attachment cancellation test passed once in this sweep; one pass is not a flake-rate measurement.

Key retained evidence:

- `validation.md`: exact commands, environment isolation, tool versions, timings, and build/worktree notes.
- `playwright.json:1811-1819`: no global errors; 51 expected, zero unexpected/skipped/flaky.
- `playwright-list.log`: all 51 named browser cases.
- `frontend-build.log`, `backend-build.log`, `python.log`, `rust.log`: actual build/test output.
- `stale-poll.mjs`: standalone temporary diagnostic, not a repository test modification.
- `stale-poll-x38TAF/results.json`: clean diagnostic with 3/3 reproductions, zero page errors, writes, external requests, or unexpected API calls.
- `stale-poll-x38TAF/*-recovered-completed.png`: screenshots of recovered output with the obsolete alert at each width.

An initial diagnostic also reproduced all three cases but omitted a queued-builds mock, causing an unrelated fixture banner. Its `stale-poll-sv7jqE/` evidence was preserved; conclusions above use the corrected clean run. Initial Cargo discovery required adding the installed Cargo directory to PATH; no build/test command failed.

Frontend assets were regenerated before Playwright. Cargo checked current incremental artifacts rather than doing a clean rebuild. Concurrent source/public edits observed by validation preceded the generated bundle; an unrelated continuation test changed during testing and was not selected. Diagnostic artifact hashes were recorded. Results apply to the actual tested builds, not subsequent worktree edits. Existing user changes and earlier reports were not reverted or overwritten.

**Reproduction Commands**
Exact executed commands, including environment and log-capture wrappers, are in the retained `validation.md`. The main isolated browser invocation was run from `/home/opencode/spec/frontend` after the builds:

```bash
env -i HOME=/tmp/opencode PATH="$PATH" TMPDIR=/tmp/opencode \
  PLAYWRIGHT_BROWSERS_PATH=/home/opencode/.cache/ms-playwright \
  PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/opencode/performance-validation-Dun94YlM/playwright.json \
  ./node_modules/.bin/playwright test e2e/optimize.spec.ts \
  --browser=chromium --workers=1 --reporter=list,json \
  --output=/tmp/opencode/performance-validation-Dun94YlM/test-results
```

Use a new artifact directory for future runs so retained evidence is not overwritten. Browser binaries and dependencies were already available; none were installed for this review.

Supporting commands, from the repository root and backend directory respectively:

```bash
python3 -I -B -m unittest discover -s backend/src -p performance_session_test.py -v
cargo test --locked --offline performance_tests -- --test-threads=1
```

The actual supporting invocations also used a cleared environment, temporary HOME, `/dev/null` AI environment configuration, and explicit existing Cargo/Rustup homes as recorded in `validation.md`.

**Recommended Follow-Up**
1. Define separate machine-readable session and workload outcomes. Test an agent that exits zero after reporting missing prerequisites; that must not be represented as verified RL success.
2. Align request-size encoding across browser, Rust, and remote Python. Test multilingual content, JSON escaping, metadata overhead, canonicalized paths, and exact boundary sizes through the real local transport fixture.
3. Add a Playwright regression for 503 -> running -> completed with no user action: recovered output and badges must coexist with no obsolete polling alert. Preserve unrelated cancellation errors.
4. Correct Performance-specific backend conflict guidance and exercise an admission race in which the server, not the browser precheck, discovers the blocker.
5. Add a thin browser-to-real-local-backend test using a fake builder, complementing rather than replacing the deterministic UI suite. Include authentication rejection and the full launch/recovery/cancel contract without external services.
6. Cover Performance in the new detached output pane; consider Firefox/WebKit and a focused accessibility audit if those environments are supported.
7. Only with explicit execution authorization and provisioned inputs, validate real SSH/provider behavior, actual RL command and exit status, held-out measurements, new artifacts, and resource cleanup after cancellation. Do not infer these from fixture rewards or session exit zero.

**Assessment**
The button has substantial coverage for safe initiation, confirmation, input handling, independent lifecycle state, scoped cancellation, recovery, and responsive UI behavior. The 51 current browser cases and 18 supporting local tests all passed.

The defensible conclusion is: **the tested UI and local orchestration contracts work across the covered scenarios, but automatic polling has a confirmed stale-alert defect, request sizing is inconsistent, and session completion is not proof of a successful performance experiment.**

No actual RL benchmark, live remote training, model improvement, convergence, or GPU performance was measured. The full frontend/backend suites, project-search backend suite, standalone distillation runner, non-Chromium browsers, and formal accessibility/security audits were not run in this sweep. Temporary raw evidence may not survive environment cleanup; this report preserves the factual summary and its source paths.
