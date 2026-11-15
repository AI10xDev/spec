# SWE-bench-derived Playwright stress results

## Scope and result

On **2026-11-14**, the final run passed **90/90 UI/local-fixture checks** in
**123.916 seconds**, with three concurrent Chromium worker slots, two repetitions,
and no retries. **SWE-bench resolved-rate was not measured.** These are not 90
solved software-engineering issues.

The test uses the real Spec frontend, Rust backend, saved-snapshot transport,
local replacement for SSH, and a fixed fake runner. Each worker has its own
server, workspace, and temporary home. This tests concurrent independent harness
instances on one host, **not three simultaneous builds sharing one project**.
No model, cloud infrastructure, real SSH connection, benchmark repository checkout,
benchmark test script, or gold patch was executed. No production application code
was changed. Existing unrelated working-tree changes were left in place; results
therefore describe that working tree, not pristine commit `d191370`.

## Measurements

| Check / outcome | Passed | Failed |
| --- | ---: | ---: |
| Successful fixture exit and reload recovery | 30 | 0 |
| Intentional exit 7 correctly shown as failed, including after reload | 30 | 0 |
| Cancellation correctly shown and recovered after reload | 30 | 0 |
| Total browser checks | **90** | **0** |

All 90 checks verified editor content, exact saved and runner-received input,
SHA-256 output marker, stdout/stderr visibility, expected terminal state, and
reload recovery. All reported zero page errors and zero attempted external browser
requests. Success/failure cases streamed eight 8,192-character payload chunks at
100 ms intervals plus the JSON-escaped challenge; rendered outputs ranged from
67,750 to 91,112 characters. Cancellation occurs after the first output marker;
it does not claim to consume all eight chunks. Two repetitions are a small
repeatability check, not a statistical reliability guarantee or saturation test.

| Timing (milliseconds) | Samples | P50 | P95 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Whole test | 90 | 3,944 | 4,918 | 5,410 |
| Save & run click through successful admission response | 90 | 214 | 379 | 1,108 |
| Save & run click through visible input-hash output | 90 | 1,144 | 2,172 | 2,202 |
| Save & run click through verified terminal outcome | 90 | 2,653 | 3,515 | 3,716 |
| Stop click through visible cancelled state | 30 | 1,026 | 1,620 | 1,695 |

Percentiles use nearest rank on passing attempts only. Durations include browser
polling, local scheduling and fixture delays; they are **not agent/model latency**.
The Chromium version was `153.0.8010.12`, Playwright `1.63.0`, Node `24.22.3`,
Bun `1.3.14`, and the backend was a local debug build on Linux.

## Dataset and selection

Official references:
- <https://www.swebench.com/lite.html>
- <https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite>

Downloaded the complete **300-instance Lite test split**, not full SWE-bench,
from the public dataset pinned to revision
`6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2`:

<https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite/resolve/6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2/data/test-00000-of-00001.parquet>

- Download: **1,119,540 bytes**.
- Parquet SHA-256: `7a21f37b8bc179c7db5beeb14e88ac538ba283455c776e6b2535bbfb6e3551b4`.
- Selection: longest UTF-8 problem statement from each repository, then longest
  remaining statements until 15; ties broken by instance ID; final order by ID.
- Coverage: **15/300 instances (5%), 12 repository names in this pinned data**.
  The public Lite description says 11 repositories; the count here is computed
  from the actual downloaded rows rather than copied from that description.
- Selected descriptions total **123,167 UTF-8 bytes**, ranging from 1,868 to 24,770.
- Inputs include code fences, HTML, Unicode, stack traces and CRLF newlines.
  Text is untrusted data and is never evaluated. HTML textarea newline normalization
  (CRLF or CR to LF) is explicit; metrics retain both original and input hashes.
- Only `instance_id`, `repo`, `base_commit`, and `problem_statement` are exported
  from Parquet. Gold patches, test patches and hints are not sent to the fixture.

| Instance ID | Original UTF-8 bytes |
| --- | ---: |
| astropy__astropy-14995 | 2,455 |
| django__django-14672 | 6,768 |
| django__django-14997 | 6,011 |
| matplotlib__matplotlib-26020 | 19,270 |
| mwaskom__seaborn-3010 | 3,951 |
| pallets__flask-5063 | 2,039 |
| psf__requests-2148 | 2,311 |
| pydata__xarray-4493 | 2,375 |
| pylint-dev__pylint-7080 | 24,770 |
| pytest-dev__pytest-7168 | 8,443 |
| pytest-dev__pytest-7490 | 22,778 |
| scikit-learn__scikit-learn-25570 | 5,590 |
| scikit-learn__scikit-learn-25747 | 6,147 |
| sphinx-doc__sphinx-8713 | 1,868 |
| sympy__sympy-21171 | 8,391 |

## Evidence and implementation

- [Portable per-attempt metrics](swe-bench-results.json): all 90 rows, hashes,
  status, phase reached, browser version, errors and timing summaries.
- `frontend/test-results/swe-bench/metrics.json`: original generated metric output.
- `workspace/swe-bench/playwright-results.json`: raw Playwright JSON, including
  assertions and metric attachments. Independent validation matched its 90 passed,
  zero failed/skipped results to 90 unique instance/scenario/repetition tuples.
- `workspace/swe-bench/test.parquet`, `subset.json`, `download-provenance.json.log`:
  ignored download, selected text/base commits/hashes, and download provenance.
- `scripts/download_swe_bench.py`: bounded download, pinned checksum, deterministic selection.
- `scripts/test_download_swe_bench.py`: repository coverage, tie breaking, input
  order independence and insufficient-count rejection (2 passing tests).
- `frontend/e2e/swe-bench.spec.ts`: opt-in browser suite, fixed runner with 20-second
  safety deadline, credential-free allowlisted server environment, temporary fixture
  cleanup, external browser-request blocking and input/terminal/recovery assertions.
- `frontend/e2e/swe-bench-reporter.ts`: per-attempt JSON metrics and percentiles.

Ignored raw outputs are local artifacts and may be overwritten by later runs;
`docs/swe-bench-results.json` preserves this successful measurement without task
text or authentication tokens.

### Setup failures and validation

Two setup failures preceded the final run and are **not included** in its timing
percentiles or 90/90 result:

1. Backend private settings rejected the group-writable checkout ancestor (`775`):
   1 failed, 1 interrupted, 88 not run. Moved only disposable fixture storage to
   the normal temporary directory; did not change checkout permissions or weaken
   backend checks. `workspace/swe-bench/startup-failure-metrics.json` preserves the
   initial reporter output; its old `attempts` field counted unstarted/skipped rows
   too, so use these explicit counts, not that field.
2. The minimal fixture PATH omitted the host's nonstandard Node installation:
   1 failed, 2 interrupted, 87 not run. Added only the current Node executable's
   directory to the allowlisted PATH, not the whole inherited environment.
   Evidence: `workspace/swe-bench/path-failure-metrics.json` and
   `workspace/swe-bench/path-failure-playwright.json`.

Validation performed:
- Frontend production build/typecheck passed; final typecheck passed again.
- All **224 frontend unit tests** passed.
- Backend `cargo build --locked` passed after adding `$HOME/.cargo/bin` to PATH;
  the initial plain `cargo` command failed because Cargo was not on PATH.
- Downloader rerun with pinned checksum and both Python selection tests passed.
- Independent result checks passed: checksum, 90 unique case tuples, all phases
  verified, exact selected IDs, zero retries/errors/external requests, raw
  Playwright count agreement.
- Full backend tests and the unrelated full browser suite were not run.

## Reproduce

From the repository root (install existing frontend dependencies first if needed):

```sh
python3 -m venv workspace/swe-bench/venv
workspace/swe-bench/venv/bin/python -m pip install pyarrow==20.0.0
workspace/swe-bench/venv/bin/python scripts/download_swe_bench.py
python3 -m unittest discover -s scripts -p test_download_swe_bench.py
(cd backend && PATH="$HOME/.cargo/bin:$PATH" cargo build --locked)
(cd frontend && bun run build)
cd frontend
SPEC_SWE_BENCH=1 \
PLAYWRIGHT_JSON_OUTPUT_NAME=../workspace/swe-bench/playwright-results.json \
bunx playwright test e2e/swe-bench.spec.ts \
  --workers=3 --repeat-each=2 --retries=0 --max-failures=3 \
  --reporter=line,./e2e/swe-bench-reporter.ts,json
```

Chromium must be installed for the project's Playwright version. Ordinary browser
runs without `SPEC_SWE_BENCH=1` do not load the dataset or register these cases.
Temporary storage must have ancestors accepted by the backend's existing private
settings checks. No real SSH credentials or model configuration are needed.

## What remains unmeasured

No agent generated patches and no SWE-bench repository tests ran. Therefore issue
resolution, regression-test preservation, agent tool/supervisor behavior, model
cost/token use, and official SWE-bench resolved-rate are **not measured**, not zero.
A real benchmark evaluation needs separately authorized isolated task repositories,
an agent adapter, generated patches, and the official test-based grader. The
length-biased 15-instance UI subset is not an unbiased estimate of benchmark coding
capability. Shared-project contention, throughput saturation, output truncation,
long-running soak behavior, CPU/memory usage, and other browsers are also unmeasured.
