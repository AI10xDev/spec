# Analytics

**Analytics**, immediately left of **Performance**, opens a saved-spec picker and
a read-only dashboard for that spec's `.out` report. It never saves the editor,
reruns a build, calls a model, or executes report or `.eval` content. Unsaved
editor changes are not included. Close with **Close** or Escape.

## Report Selection

Choose a saved spec, optionally choose a `.eval`, then click **Open analytics**.
The companion name defaults to the full filename plus `.eval`: `foo.md.eval`
for `foo.md`, not `foo.eval`. Other saved `.eval` files can be selected explicitly.
The spec picker excludes `.out`, `.eval`, and `.optim` files.

Analytics prefers the latest associated remote run. Without an association, it
lists retained, exact-spec-named remote logs for explicit selection when remote
execution is configured. If no remote candidates exist, it can use the local
workspace's `<spec filename>.out`. It does not combine sessions, scan arbitrary
directories, substitute legacy `output.log`, or change the latest-run association.
A retained lookup can be incomplete; errors are not silently treated as no history.

Missing output displays a warning, not an automatic build. Absence of a report
does not prove the spec has never run. If it has never run, run it first; otherwise
check output locations, retention, and remote access. File/transport read failures
remain errors that can be retried. Invalid `.eval` content instead falls back to
report charts and diagnostics with a warning, just like **Dashboard only**.

## Evaluation Format

Save plain JSON, without Markdown fences, in `foo.md.eval`:

```json
{
  "version": 1,
  "kind": "eval",
  "spec": "foo.md",
  "checks": [
    {
      "name": "Mean quality",
      "metric": "quality",
      "aggregate": "mean",
      "operator": ">=",
      "threshold": 0.9
    }
  ]
}
```

- Only these top-level and check fields are accepted; all are required.
- `version` must be the number `1`, `kind` the string `eval`, and `spec` must match the selected filename exactly, including case and extension.
- The file is limited to 64 KiB of UTF-8 and 1 to 64 checks.
- Check names must be unique and nonblank, at most 120 JavaScript string units. Metric names must be nonblank and at most 160 units. Names are matched literally, not trimmed or case-normalized.
- `aggregate` is a string: `last`, `mean`, `min`, `max`, `sum`, or `count`.
- `operator` is a string: `>=`, `<=`, `>`, `<`, or `==`. `threshold` must be a finite JSON number.
- No commands, expressions, scripts, prose evaluation, model grading, or original terminal `/eval` integration are supported.

Checks use every extracted sample of the named metric in report order, not just
the points shown in the chart. `last` means last observed sample; `count` counts
samples. Comparisons use JavaScript numbers without display rounding or tolerance;
`==` is exact numeric equality. Missing metrics, including `count` with no samples,
are **inconclusive**, not zero. A nonfinite aggregate is also inconclusive.

## Measurements

The report must contain one complete JSON object per line to supply measurements:

```jsonl
{"event":"eval","metrics":{"quality":0.8,"latency_ms":20}}
{"event":"eval","metrics":{"quality":1,"latency_ms":10}}
```

This produces mean quality `0.9` and two charts. Values must be finite numbers,
not numeric strings. Additional event fields are ignored. Optimizer-shaped
`baseline`, `iteration`, and `final` events with a string `objective` also expose
numeric `score`, `gain`, `cumulative_gain`, and `marginal_difference` fields as
`<objective>.<field>` metrics. This does not automatically load Performance's
separate reports.

Extraction removes ANSI CSI styling and trims lines. Only lines beginning with
`{` are parsed; timestamp prefixes, JSON wrapped inside another event, multi-line
JSON, and ordinary prose are not interpreted as measurements. Chart positions
count nonempty report lines, not elapsed time. Diagnostic error/warning counts
are word matches, not test outcomes. Exit status and prose claims never become
quality scores.

## Evidence Limits

- Reports retain at most the first 8 MiB, not the output pane's 256 KiB tail. Reaching exactly 8 MiB, detected changes during reading, or invalid UTF-8 marks the report incomplete. Retained reads that shrink during reading can fail instead.
- Extraction is bounded to 32 metric names, 100,000 total samples, and 65,536 JavaScript string units per JSON record (the UI labels this last limit "64 KiB"). Exceeding a limit preserves available charts but makes all checks inconclusive.
- Malformed JSON on a line beginning with `{`, invalid numeric measurements, or an `eval` event without an object `metrics` field likewise makes all checks inconclusive. Unrecognized events are ignored; an empty metrics object supplies no data.
- Truncated reports and remote statuses other than `completed` make every check inconclusive, even if measurements meet their thresholds. A completed process is not independent proof of implementation or quality.
- **Local snapshots have no verified terminal status.** An otherwise complete local snapshot can show pass/fail for its extracted samples, with an explicit warning. This is sample-only evaluation, not confirmation that a run finished or that its claims are true.
- Long series are sampled for chart display; checks still use every extracted sample. Checks do not rerun benchmarks, verify measurement claims, compare sessions, or prove that the current saved spec matches an older run's input.

**Evidence and evaluator** records the SHA-256 of the decoded report text and,
when a `.eval` was read, its saved revision. These identify the inputs used, not
their authenticity. Results remain in the current dialog; there is no persisted
evaluation history or export. Reports stay within the browser/backend and the
configured SSH read path; this feature sends no data to a model provider.

## Validation

From `backend/`, run `cargo test --locked` and `cargo build --locked`. From
`frontend/`, run `bun run test:unit`, `bun run build`, then
`bun run test:e2e analytics.spec.ts`. Install Chromium with
`bunx playwright install chromium` if needed. Browser tests require the built
debug backend and `frontend/dist`; run without production provider/SSH exports.
They use isolated workspaces and real local API reads, with remote UI responses
mocked. Backend analytics tests exercise the real retained-report script through
a local SSH stand-in; no live SSH host or provider is required.
