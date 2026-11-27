# Exa Settings integration validation

## Scope and baseline evidence

This integration extends only the pending Settings requirement. The original
Deep research button/report workflow remains intact. Work is local to the
`research-sources/spec-deep-research` checkout; no commit, push, deployment,
credential access or live paid Exa request was performed.

The prior-output review used workspace `.spec-runs` storage (excluding the
current invocation), the target checkout's historical outputs, and current code:

- `.spec-runs/run-52760ff2-3c02-45ff-ac8b-a76d4af0507a/extensive_exploration.out`
  is the Settings Builder sweep, not implementation evidence.
- `.spec-runs/run-5f830a0e-41b6-4014-982a-ff996db47ff9/extensive_exploration.out`
  records the original research integration; current `research.rs`, research
  dialog and tests independently confirm it exists.
- `.spec-runs/run-789319e8-6f0f-41ad-862c-5e0512bd173f/extensive_exploration.out`
  records publication of that feature. Local baseline is `ea9d7ee`, on
  `feat/exa-deep-research`, with origin `https://github.com/AI10xDev/spec.git` and
  an initially clean target worktree. Remote publication was not repeated.
- Target `ghost_chat.out` concerns older shared environment configuration, not
  Exa Settings. Current `settings.rs` / `storage.rs` establish reusable private
  persistence conventions, not a need for a general settings refactor.
- Workspace and target-root `AGENTS.md`, target hidden run storage, and the
  historical snapshot path were unavailable. The supplied snapshot and approved
  handoff were used; no snapshot or completion marker was edited. Some historical
  output lines are truncated. Historical test claims were not counted as fresh
  checks below.

## Changes reviewed

- `backend/src/research_settings.rs`: strict preferences/key input, redacted
  views, private sibling persistence, environment fallback, fail-closed corrupt
  storage and persist-before-publication semantics.
- `backend/src/main.rs`, `settings.rs`, `research.rs`: authenticated 16 KiB Exa
  settings routes; private-file sibling helper; immutable request snapshots,
  one shared semaphore across generations, dynamic payload and availability.
  Original fixed HTTPS endpoint, time/size limits and no-retry policy retained.
- `frontend/src/exa-settings.tsx`, `settings.tsx`, `deep-research.tsx`: independent
  form/description, password retention/removal/reset, preferences, static errors,
  duplicate/stale guards, Back disabled during saves, unload warning and honest
  server-settings/privacy disclosure. Model profiles and build approvals remain
  separate; the original button was not relocated or reimplemented.
- Tests: `backend/src/research_settings_tests.rs`, `research_tests.rs`, fixture
  updates in `tests.rs`, `backend/tests/research_config.rs`,
  `frontend/src/exa-settings.test.tsx`, and the existing Settings/research browser
  suites. No dependencies added.
- Documentation: `README.md`, `.env.example`, `docs/DEEP_RESEARCH.md` and this report.

## Fresh checks in this integration sweep

Rust tools were available under `/home/opencode/.cargo/bin`; adding that path to
individual validation commands resolved the Builder sweep's PATH limitation.

| Check | Actual result |
| --- | --- |
| `bun run typecheck` | Passed |
| `bun run test:unit` | 256 tests passed in 13 files |
| `bun run build` | Passed; fresh production assets |
| `cargo build --locked` | Passed; fresh backend binary |
| `cargo test --locked research` | Final targeted run: 13 unit tests and one matching process test passed |
| `cargo test --locked --test research_config` | Both process tests passed, including restart persistence and corrupt-storage isolation |
| `env -u SPEC_WORKFLOW_RUNNER cargo test --locked` | 344 total passed: 324 unit + 20 process/integration tests |
| `cargo clippy --all-targets --locked -- -D warnings` | Passed, including after final domain-count validation adjustment |
| Scoped Rust formatting | Passed for every changed Rust file, using edition 2024 and `skip_children=true` |
| `cargo fmt --check` | Fails only on pre-existing untouched `src/feature_review.rs:205` and `src/memory_tests.rs:879`; no broad formatting repair made |
| Targeted Settings/research Playwright | 39 passed using fresh backend/assets (Settings mocks use current Vite source) |
| Full `env -u EXA_API_KEY -u SPEC_WORKFLOW_RUNNER bun run test:e2e` | 322 passed |
| `git diff --check` | Passed |

The full suites passed before a final narrow adjustment that counts **distinct**
normalized backend domains (rather than input entries), matching the form and
specified limit. A 21-duplicate regression assertion, all targeted Rust research
checks, backend rebuild, strict Clippy and scoped formatting passed afterwards.
No frontend behavior changed after the full browser pass.

The first targeted browser run had eight failures: seven ambiguous pre-existing
`API key` selectors now also matched `Exa API key`, and one keyboard fixture
assumed storage immediately followed the model form. Explicit label matching and
the correct new focus order fixed those tests; targeted and full reruns passed.
Two early edit/test commands used an incorrect working-directory prefix; they
failed before the intended edit/test operation and were rerun in the correct
checkout. They are not validation successes.

## Coverage and boundaries

- Authentication, no-store, key omission/replacement/explicit removal, null and
  non-string rejection, unknown fields, malformed JSON and 16 KiB limits.
- Startup environment precedence, no copying environment keys into preference-only
  saves, restart roundtrip, 0700/0600 modes, symlink/hardlink/insecure file rejection,
  corrupt JSON, failed persistence and previous-state preservation. The existing
  shared `PrivateFile` served-root/directory/owner checks also pass in the full suite.
- Integer boundaries, normalization/deduplication, 20 distinct domains, label/name
  lengths, empty/mutually exclusive filter semantics and static validation errors.
- Literal provider payload/schema assertions; saved settings applied without
  restart; held in-flight request retains its original key/preferences; rotations,
  reset and disable/re-enable share one slot; disabled submissions make no call.
- Browser key clearing/omission, unexpected response fields ignored, no keys in
  browser storage or console, independent model/Exa/storage forms, fallback/reset
  confirmations, retry/sanitized failure states, duplicate/stale protection,
  keyboard navigation, focus return and 320px layout.
- A real isolated backend + production frontend browser test saves a fake key and
  filters, reopens research to see them, disables it and resets it. It never
  submits a research question. Other provider tests use loopback mocks only.
- Existing dirty-editor/selection/autosave, citations/export, model settings,
  storage and staged approval regression suites remain passing.

Official public Deep Search and Search documentation and the OpenAPI URL were
refreshed. The Search guide confirms `includeDomains` / `excludeDomains` and
that `numResults` controls returned pages, not internal searches. The large
OpenAPI tool output was truncated, so it is not evidence of a complete schema
review. Mocks are not proof of live provider compatibility, accuracy, account
credits or billing. A live smoke test remains unperformed; it would require a
privately configured key and an explicitly approved public, non-sensitive query.

## Publication sweep follow-up

The requested commit/push sweep reran TypeScript and all 256 frontend unit tests,
which passed. Its first focused Rust run exposed an intermittent connection reset
in the restart process test: `start_fixture` dropped the stdout reader after the
first readiness line, so remaining startup prints could hit a closed pipe. The
helper now drains stdout until EOF without logging the token. No application
behavior changed in this follow-up.

After that test-only repair, all 13 focused research unit tests and both
`research_config` process tests passed. The restart/persistence test additionally
passed 20 consecutive repetitions. Full backend/browser suites and live Exa
requests were not rerun in this publication sweep; the full-suite results above
remain evidence from the preceding integration sweep.
