# Deep research integration validation

Local integration sweep against Spec baseline `a964eef` in
`research-sources/spec-deep-research`. No deployment, commit, push, or live Exa
query was performed. The saved snapshot and Builder handoff were not rewritten.

## Results

- Frontend `bun run typecheck`: passed.
- Frontend `bun run test:unit`: 238 passed across 12 files, including 12 new
  research byte-boundary, safe-link, export, and initial-render tests.
- Frontend `bun run build`: passed.
- Backend `cargo build --locked`: passed.
- Backend `env -u SPEC_WORKFLOW_RUNNER cargo test --locked`: 318 unit tests and
  19 process/integration tests passed. Seven research unit tests exercise the
  real authenticated router, request contract, input/report/source limits,
  chunked response bounds, HTTPS restriction, redirects, sanitized provider
  errors, timeout, cancellation and concurrency. The new configuration test
  covers six file/export combinations without sending provider requests.
- Backend `cargo clippy --all-targets --locked -- -D warnings`: passed.
- Frontend `env -u EXA_API_KEY -u SPEC_WORKFLOW_RUNNER bun run test:e2e`:
  all 316 browser tests passed, including five new research scenarios.
  Tests verify no-tab setup, badge adjacency, explicit copy/submission, safe
  rendering/export, non-mutation, shortcuts, duplicate protection, local close,
  stale responses, mobile layout, independent autosave, and editor selection.
- Changed Rust files pass `rustfmt --check --edition 2024 --config
  skip_children=true src/main.rs src/tests.rs src/research.rs
  src/research_tests.rs tests/research_config.rs`.
- `git diff --check`: passed.

Local ignored logs: `backend/target/deep-research-tests.log` and
`backend/target/deep-research-e2e.log`. These are test results, not live provider
availability, research-quality, or billing evidence.

## Failures encountered and disposition

- Initial research test compilation used `unwrap()` with the existing non-Debug
  application Error type. Fixed the new test assertions; no unrelated Error
  refactor was made.
- Initial browser tests had overly restrictive file selectors, an ambiguous
  case-insensitive text selector, and host-time-sensitive clock setup. Corrected
  the new tests; targeted and full runs subsequently passed.
- The first full backend run passed 316 tests and failed one existing workflow
  capability test because this execution environment exported a real
  `SPEC_WORKFLOW_RUNNER`. An attempted minimal PATH removed Bun/Node and caused
  75 unrelated runtime-dependent test failures. Restored the normal executable
  PATH and removed only the inherited runner override for testing; the full
  suite then passed. No workflow code was changed.
- Repository-wide `cargo fmt --check` still fails on existing formatting in
  `backend/src/feature_review.rs` and `backend/src/memory_tests.rs`. Automatic
  formatting changes to those unrelated files were reviewed and reverted;
  changed research/integration files pass scoped formatting checks.

## Remaining external verification

Privately configure `EXA_API_KEY` and approve one public non-sensitive question
before a live smoke test. Mock tests do not prove current Exa payload acceptance,
account access, latency, charges, synthesis quality, or grounding completeness.
See [setup, API contract, privacy and limits](DEEP_RESEARCH.md). No persistent
history, spec insertion, or build approval is part of this feature.
