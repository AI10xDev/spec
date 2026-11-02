# Performance Runner

`backend/src/performance.py` runs the implemented dataset and model pipelines for
an explicit project directory. It does not discover a previous build or require
an `.opt`, `.optim`, or any other filename extension. This document describes the
runner contract used by the Performance button.

Click **Performance**, enter the remote **Project folder**, optionally select
**Use current editor as spec**, then click **Run pipelines** and confirm trusted
execution. Results appear in **Optimization** under **Output & logs**. This uses
the same authenticated SSH transport, recovery, and **Stop run** controls as the
existing optimizer, without requiring a previous build or an editor tab.

## Invocation And Request

```sh
python3 -B -u backend/src/performance.py RUN_DIRECTORY WORKSPACE REQUEST_CONFIG_PATH
```

The backend embeds this runner as `snapshot.md`, with `optimize` registered by
its bootstrap. Its CLI is unchanged. `--supervise ARGV...` delegates to
`optimize.supervise_command`, including when the optimizer module's `__file__`
points at the embedded snapshot. Python 3.11+ and Linux/procfs are required.

The authenticated `POST /api/optimize` UTF-8 request JSON has these fields
(`spec` can be omitted at the HTTP boundary and is normalized to null):

```json
{"project": "my-project", "spec": null}
```

`WORKSPACE` is the execution host's resolved `SPEC_SSH_WORKSPACE`, supplied by the
caller. Relative `project` paths resolve against it and must stay inside it;
`..` segments and symlink escapes are rejected. Explicit absolute projects may be
outside the workspace. Projects must exist. Spaces and shell punctuation are
literal path characters, never shell expressions; control characters are rejected.
No environment-variable, tilde, or shell expansion occurs.

With `spec: null`, the runner reads `PROJECT/performance.json`. Otherwise `spec`
must be exactly `{"name": "instructions.opt", "content": "JSON manifest text"}`.
The uploaded content replaces the entire local manifest, not individual fields.
The name is only a report label: it is not opened or written and has no extension
restriction. HTTP spec names follow the editor's existing safe-basename rules.
Prose specs are not interpreted. Requests/manifests/reports are bounded to 1 MiB;
the encoded request includes JSON escaping and metadata, so large editor buffers
may exceed that limit even if their raw text fits. Duplicate manifest/report JSON
keys and nonfinite JSON numbers are rejected.

## Manifest

Required top-level fields: `pipeline_root`, `dataset`, `model`. No unknown fields.
`pipeline_root` is the repository containing `spec-training/environment.py`,
absolute or relative to the selected project. It is not auto-discovered.

`dataset` requires `source_dir`, `editable_files`, `test_commands`, and `image`.
Optional fields are `replacements` (default `{}`) and `timeout_seconds` (default
10, positive and at most 300 seconds **per test command**). `source_dir` is an
existing curated project-relative directory, without traversal or symlink escape.
Editable files are distinct, nonempty relative POSIX paths. Replacements map
only those files to UTF-8 text. Test commands are 1..32 argv arrays. The actual
environment adapter additionally validates its source snapshot and runtime.

`model` requires `binary` and `args`. `binary` is an existing executable, absolute
or relative to the project, pointing to a prebuilt **gemma4-distill** example.
Optional `timeout_seconds` defaults to 3600, positive and at most 86400 seconds.
`args` is a trusted, nonempty argv array, beginning with a long option. Supply the
arguments **after** `train`; do not include the subcommand, `--` separator, or
`--output` (including `--output=...`). The runner executes:

```text
ABSOLUTE_BINARY train ARGS... --output ABSOLUTE_RUN_DIRECTORY/model
```

Arguments are not shell-split. Relative model input paths resolve from the
**project**, not `pipeline_root`. The actual CLI enforces required `--config`,
`--train-data`, `--validation-data`, teacher identity/revision/parameter count,
and exactly one of `--from-scratch` or `--checkpoint`. It also validates dataset
splits and training hyperparameters. Omitting `--gpt-sol-predictions` yields a
`benchmark.status` of `not_run`. A help-only invocation cannot pass artifact checks.

### Runnable Fixture Example

For this checkout, prebuild the CPU binary from `/home/opencode/project/candle`:

```sh
cargo build --locked --offline -p candle-examples --example gemma4-distill
```

Prepare a project with `curated/solution.py` and `curated/test_solution.py`, and
provision a digest-pinned local Docker image with Python, GNU `/usr/bin/timeout`,
and the test dependencies, without declared VOLUME mounts. Substitute its actual
digest below. This manifest uses the existing **synthetic** Candle fixtures only
as an explicit wiring example; they are not real teacher or GPT-sol measurements.

```json
{
  "pipeline_root": "/home/opencode/project",
  "dataset": {
    "source_dir": "curated",
    "editable_files": ["solution.py"],
    "test_commands": [["python3", "-B", "test_solution.py"]],
    "image": "your-local-image@sha256:REPLACE_WITH_ACTUAL_64_HEX_DIGEST",
    "timeout_seconds": 10
  },
  "model": {
    "binary": "/home/opencode/project/candle/target/debug/examples/gemma4-distill",
    "args": [
      "--config", "/home/opencode/project/candle/candle-examples/examples/gemma4-distill/fixtures/config.json",
      "--train-data", "/home/opencode/project/candle/candle-examples/examples/gemma4-distill/fixtures/train.json",
      "--validation-data", "/home/opencode/project/candle/candle-examples/examples/gemma4-distill/fixtures/validation.json",
      "--gpt-sol-predictions", "/home/opencode/project/candle/candle-examples/examples/gemma4-distill/fixtures/gpt-sol.json",
      "--teacher-model", "synthetic-teacher-not-a-trained-model",
      "--teacher-revision", "synthetic-fixture-v1",
      "--teacher-parameters", "1000000",
      "--from-scratch", "--epochs", "1"
    ],
    "timeout_seconds": 60
  }
}
```

For example, with that `performance.json` in `/data/my-project` and a request file
containing `{"project":"my-project","spec":null}`:

```sh
python3 -B -u backend/src/performance.py /tmp/opencode/performance-new-run /data /data/request.json
```

Use a new run directory on every attempt. Keep it outside the curated source.
Use your own precomputed real trajectory/teacher artifacts instead of the fixture
paths for substantive measurements. See the actual contracts:
[source-directory environment](../project/spec-training/ENVIRONMENT.md) and
[offline distillation](../project/candle/candle-examples/examples/gemma4-distill/README.md).
Those sibling paths assume the layout above; otherwise consult `pipeline_root`.

## Execution And Results

The explicit project is locked using `optimize.project_lock`, sharing its lock
scope with other harnesses. No prior-build discovery is used. The dataset stage
executes the configured repository's `environment.evaluate_directory` in an
isolated Python subprocess; project Python is never imported into the parent.
It writes `dataset-metrics.json` directly, so ordinary stdout cannot masquerade
as metrics. Only after that stage returns validated metrics does model training
start. Dataset test failures are valid measured zero rewards, not infrastructure
failures, and do not suppress model training.

Both children use `optimize.execute`: bounded command logs, deadlines, and Linux
descendant supervision. Dataset's outer deadline is
`60 + number_of_commands * (timeout_seconds + 35)` seconds, allowing preflight and
cleanup. SIGINT/SIGTERM cancel the run; descendants are reaped before release.
The underlying adapter's independent container deadlines still matter: forced
cancellation can leave Docker resources or staging directories needing operator
cleanup. A hung/unavailable daemon prevents proof of container cleanup.

`optimize.Reporter` streams JSON events to stdout and fsyncs identical events to
`progress.log` and `report.jsonl`. Child stdout/stderr go into bounded
`commands.log` (8 MiB), not the metrics protocol. Stage metrics are emitted when
each stage completes; this is not live per-epoch metric streaming. The actual
trainer also saves `model/learning-curve.json` during training.

Every event has `event` and numeric `timestamp`. Event-specific fields are:

| Event | Fields |
| --- | --- |
| `start` | `project`, `spec`, `pipeline_root` |
| `stage_start` | `stage`: `dataset_pipe` or `model_pipeline` |
| `stage_metrics` | `stage`, `metrics`, `artifact` (absolute JSON path) |
| `final` | `outcome`, `stage`, `project`, `spec`, `metrics`, `artifacts`; `error` only on failure |

Final outcomes are `completed` (exit 0), `failed` (exit 1), or `interrupted`
(exit 130). Usage errors exit 2. `stage` can additionally be `configuration`.
`project` and `spec` are null until configuration succeeds; thereafter they are
the resolved absolute project and manifest source path/upload label. `metrics`
contains **only completed stages**, keyed by `dataset_pipe` and `model_pipeline`.
If reporting itself cannot initialize, stderr and a nonzero exit are the only
available result.

`dataset_pipe` metrics have exactly:

```json
{"score": 1.0, "tests": ["pass"], "snapshot_sha256": "64 lowercase hex characters"}
```

`tests` is nonempty and matches the configured command count. Outcomes are `pass`,
`fail`, `timeout`, or `killed`; `score` equals the fraction of commands passing.

Streamed `model_pipeline` metrics include before/after scalar accuracy, NLL and
trajectory exact match, improvement/plateau flags, and optional baseline scalar
metrics, paired difference and bootstrap interval. Per-step and per-trajectory
maps stay on disk. Textual scope/provenance fields in the summary are capped at
1024 characters. The final event repeats compact metrics and the `artifacts`
paths for all completed stages so the browser's 256 KiB recovery tail retains the
results even for large evaluations.

The full, unmodified `model/report.json` object remains on disk:

```text
{
  before: Evaluation,
  after: Evaluation,
  benchmark: Benchmark | {status: "not_run", reason: string},
  validation_nll_improved: boolean,
  validation_nll_plateau: boolean,
  convergence_scope: string,
  policy_value_scope: string
}
Evaluation = {
  accuracy: number, mean_nll: number, trajectory_exact_match: number,
  per_trajectory_accuracy: {trajectory_id: number, ...},
  predictions: {step_id: nonnegative_integer, ...}
}
Benchmark = {
  baseline: {
    model: "GPT-sol", revision: string, accuracy: number,
    trajectory_exact_match: number,
    per_trajectory_accuracy: {trajectory_id: number, ...},
    predictions: {step_id: nonnegative_integer, ...}
  },
  student: Evaluation,
  paired_accuracy_difference: number,
  bootstrap: {
    ci_lower: number, ci_upper: number, confidence_level: number,
    groups: positive_integer, method: string, resamples: positive_integer,
    seed: nonnegative_integer, unit: string, warning: string | null
  },
  scope: string
}
```

All numbers must be finite. Accuracies are in `[0,1]`, NLL is nonnegative, and
prediction/trajectory maps must be nonempty with consistent IDs. The runner checks
the improvement flag, benchmark student/difference consistency, and a nonempty F32
safetensors checkpoint's header, offsets, and complete payload length, without
loading weights. It does not independently recompute model accuracy or certify
teacher provenance or checkpoint numerical quality.

An exclusive `performance-state/` marker prevents run-directory reuse. Existing
`model/`, `dataset-metrics.json`, or `dataset-request.json` are rejected. Reports
from earlier runs are never searched or accepted as completion. Partial artifacts
are retained for diagnosis; success requires both children to exit zero, valid
metrics, and the newly written `model/report.json` and `model/student.safetensors`.

## Trust And Limits

- Manifests, pipeline code, binaries, model arguments, image, tests, and upload
  contents are **trusted execution configuration**, not a sandbox policy. Only
  authorized users should supply them; binaries run with execution-host privileges.
- No automatic provision, package installation, Docker pull, GPU selection,
  teacher/API calls, downloads, or synthetic fallback is performed. The default
  trainer uses CPU. `--cuda` is an explicit user choice requiring a prebuilt CUDA
  binary and authorized idle hardware; this runner has no GPU occupancy lock.
- Dataset evaluation measures unit-test **command exit status** on a curated
  snapshot. It does not create trajectories, tokenize repositories, generate
  teacher logits, or feed rewards into the offline trainer. Empty replacements
  evaluate the existing source. Keep credentials, `.git`, dependencies, and build
  outputs out of the source; the adapter limits it to 64 MiB and 4096 entries.
- Offline training consumes existing, disjoint tokenized trajectories and teacher
  action logits. Reported label agreement/NLL is not repository performance,
  on-policy RL, environment success, real GPT-sol superiority, or convergence.
  `completed` means valid execution/artifacts, even if every dataset test fails,
  model quality declines, the plateau is false, or no baseline was supplied.
- Project locking is cooperative. Inputs must stay unchanged during execution.
  Containers share the host kernel; use disposable secret-free workers for
  untrusted candidates. Consult the environment contract for cleanup limitations.

## Tests

From the Spec repository:

```sh
python3 -B -m unittest discover -s backend/src -p performance_test.py -v
```

Unit tests use explicitly labeled process/model fixtures. The tiny integration
test uses the real `environment.py` and prebuilt `gemma4-distill` binary, with an
**explicit Docker protocol stub only** and the existing synthetic training data.
It checks passing/failing test rewards, infrastructure failure, actual training,
checkpoint/report validation, and persisted metrics. It does not demonstrate
container execution or isolation. It skips if the real pipeline or binary is
absent; set `PERFORMANCE_TEST_PIPELINE_ROOT` to another checkout if needed.
Other process tests cover deadlines, bounded logs, nonzero exits, SIGTERM cleanup,
and rejection of incomplete/stale/invalid results.
