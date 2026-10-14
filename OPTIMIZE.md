# Deterministic Optimizer

`backend/src/optimize.py` uses Python 3.10+ on Linux and only the standard library. It
optimizes a trusted project using explicit argv commands, without an LLM or shell
dispatch. It does not supply a project `.optim`: actual objectives must be chosen
by the project owner.

## Integration Contract

The top-right **Optimize** button launches the optimizer through the existing
authenticated SSH harness, independently of the open editor file. It does not
save or upload unsaved editor changes. Confirm execution only for trusted project
commands. View live progress under **Optimization** in Output & logs; **Stop run**
cancels the run. Reloading restores its status, and selecting Optimization retries
a failed initial recovery. Remote execution must be configured as for Save & run.

The harness puts the unchanged bytes of `backend/src/optimize.py` in the run's
`snapshot.md` and launches:

```sh
python3 -u snapshot.md RUN_DIRECTORY WORKSPACE
```

`WORKSPACE` is the directory containing the build harness's `.spec-runs` registry;
the discovered project may be elsewhere. `RUN_DIRECTORY` receives append-only
reports and is created if needed. Prefer absolute paths and a fresh run directory.
The script can also be executed directly under its `.py` name with the same two
arguments. Optimization has a separate persisted output pointer from file builds.

Before loading config or measuring, the optimizer takes a nonblocking exclusive
`flock` on the actual target project's lock directory. It uses Git to resolve the
same worktree-specific `spec-harness` directory as the build harness, or the
project's `.spec-runs` directory outside Git. These directories must be owned by
the current user, nonsymlink directories with mode 0700. The lock is held through
all measurements and steps, including when another workspace discovered this
project; contention fails without running project commands. Git overrides
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and `GIT_COMMON_DIR` are ignored for
lock scope resolution, as in the build harness.

The harness sets the internal `SPEC_OPTIM_WORKSPACE_LOCK` environment variable to
the device/inode identity of the exclusive lock retained by its supervisor. A
matching target reuses that protection instead of conflicting with its own
supervisor; other targets acquire an additional lock. Do not set this variable
for standalone invocations. It is removed from objective subprocess environments,
and lock descriptors are not passed to those subprocesses.
Locks are advisory, not a sandbox. An external target's additional lock is owned
by the optimizer process; abrupt process death releases it before the supervisor
necessarily finishes cleaning up descendants. Confirm remote cleanup before
restarting work after a crash.

For each **initial build only**, the harness must write
`WORKSPACE/.spec-runs/run-*/invocation` as these four NUL-separated byte fields,
including a final NUL:

```text
ABSOLUTE_PROJECT\0build\0ORIGINAL_FILENAME\0ABSOLUTE_OUTPUT.out\0
```

Here `\0` denotes one actual zero byte, not two printable characters. Set the
record's mtime at invocation time; do not touch it as output grows. Do not record
optimization, repository save, or continuation as initial builds. The output must
exist and be a regular `.out` file. The original objective/snapshot need not still
exist: its original filename is identity, not an input to execute.

The caller must own cancellation and terminate the **whole process group**.
Commands inherit that group; the optimizer never creates subprocess sessions.
SIGTERM/SIGINT attempt an `interrupted` final report and exit 130. SIGKILL cannot
write a final report. Exit 0 means joint convergence; exit 1 means failure; exit 2
means incorrect CLI arguments. No optimizer iteration or wall-clock limit exists.
An integrating supervisor must not silently apply its ordinary build timeout if
unbounded optimization is desired. On errors/timeouts the direct child is killed
and reaped; the supervisor must also clean up remaining descendants. Commands
must not daemonize, escape the group, or mutate the project asynchronously after
returning. Use one optimizer at a time per project and keep measurements read-only.

## Discovery

1. Select the greatest invocation record mtime, not output mtime, and compare it
   with the latest timestamped nohup history entry. A newer history invocation
   wins; older timestamped history is ignored. Tied different identities,
   malformed newest metadata, missing selected outputs, and invalid selected
   projects fail closed, without falling back to an older build.
2. Without metadata, preexisting `run-*` directories may identify a build by one
   `*.out`, excluding `optimization.out`. Multiple eligible outputs in any legacy
   run are an error. The project is `WORKSPACE`, and the filename is the output
   basename with only the final `.out` removed. Legacy recency uses output mtime,
   which is necessarily less reliable than invocation metadata.
3. Read `~/.bash_history` (never evaluate it). Unless known to predate the latest
   invocation record, the last entry mentioning `nohup` must match one of the
   following complete single-line forms. Unsupported latest entries cause an error rather than selecting an
   earlier convenient match. No guessing from shell aliases, current directory
   changes on other lines, or shell expansions is performed.

```sh
cd '/absolute/project' && nohup spec build 'file name.md' > 'file name.md.out' &
cd '/absolute/project' && nohup run_goal 'file name.md' > 'file name.md.out' 2>&1 &
nohup /absolute/path/to/runner run --dir '/absolute/project' --agent build 'file name.md' > '/absolute/project/file name.md.out' &
nohup opencode-source run --thinking --dir '/absolute/project' --agent build 'file name.md' > '/absolute/project/file name.md.out' 2>&1 &
nohup /absolute/path/to/spec build 'file name.md' > 'file name.md.out' &
```

The last form defaults to `WORKSPACE`; a `cd /absolute/project &&` prefix also
works with the runner form, provided directories do not conflict. Runner flags
`--dir` and `--agent build` may appear in either order; `--thinking` is optional.
The installed `run_goal` and `run-spec.sh` wrappers accept a single filename.
Output paths may be absolute or relative to the
same-line `cd` directory, defaulting to `WORKSPACE` without `cd`. The runner's
`--dir` selects the project but does not change the shell's redirection directory.
Single/double quotes and spaces are supported. Expansions, backslashes, glob
characters, braces, `!`, `#`, tilde paths, extra redirections other than a trailing
`2>&1`, shell `bash -c` wrappers, pipelines, multiple commands, and multiline
entries are intentionally unsupported rather than evaluated or guessed.
History executables are **never run**. Only project, filename, and output identity
are extracted. History is an untrusted hint, not permission to run config commands.

Bash `#EPOCH_SECONDS` timestamps immediately before entries allow comparison to
recorded invocation or legacy output mtimes; the newer source wins. Without a
history timestamp and with another recorded build present, only identical
identities can be accepted, otherwise the
ordering is ambiguous and fails. History alone uses its last entry's position.
History may be stale until Bash flushes it; new harness builds record launch
metadata directly. An ambiguous external shell invocation requires a timestamped,
supported history entry before optimization can safely choose the latest target.

## Configuration

In the discovered project root, prefer `<filename>.optim`, then `<stem>.optim`
(for `task.md`: `task.md.optim`, then `task.optim`). Use the original filename's
basename for this lookup, even if the recorded name includes directories. If
neither exists, require exactly one root-level `*.optim`. Ambiguity is an error.

The file is strict JSON v1, for example:

```json
{
  "version": 1,
  "objectives": [
    {
      "name": "throughput",
      "command": ["python3", "tools/tune.py", "--one-step"],
      "measure": ["python3", "tools/measure.py", "--scalar"],
      "direction": "maximize",
      "absolute_tolerance": 0.000001,
      "relative_tolerance": 0.0001,
      "patience": 3,
      "timeout_seconds": 300
    },
    {
      "name": "latency",
      "command": ["python3", "tools/reduce_latency.py"],
      "measure": ["python3", "tools/latency.py"],
      "direction": "minimize"
    }
  ]
}
```

These tool paths are illustrative, not shipped commands or a runnable config.
`name`, `command`, `measure`, and `direction` are required for every objective.
Names must be unique, printable, nonblank strings of at most 200 characters.
Argv arrays must have 1..256 string elements, a nonempty executable, no NULs, and
at most 65,536 total characters. Commands run with the discovered project as cwd,
inherited environment, and stdin closed. No `shell=True` is used. Arguments remain
literal, including shell-looking strings. Inherited `PATH` resolves executables.

Each subprocess additionally receives:

| Variable | Value |
| --- | --- |
| `SPEC_OPTIM_PROJECT` | Absolute project directory |
| `SPEC_OPTIM_FILENAME` | Original build filename, unchanged |
| `SPEC_OPTIM_OUTPUT` | Absolute original build output path |
| `SPEC_OPTIM_OBJECTIVE` | Current objective name |
| `SPEC_OPTIM_ITERATION` | Round number, starting at 1; baseline is 0 |

`measure` must exit successfully and print exactly one finite ASCII decimal
numeric scalar to stdout (surrounding whitespace and exponent notation allowed).
Diagnostics belong on stderr. Empty/multiple metrics, NaN, infinity, nonzero exits,
arithmetic overflow, or stdout exceeding 4 KiB fail the run, never converge it.

Defaults are absolute tolerance `1e-6`, relative tolerance `1e-4`, and patience `3`.
Patience must be an integer in 2..10,000. Absolute tolerance must be in 0..1e100;
relative tolerance in 0..1. Optional `timeout_seconds` applies separately to each
step and measurement, including baseline: positive and at most 86,400 seconds;
omitted or null means no timeout. Timeout is an explicit failure, not convergence.
Config is limited to 1 MiB and 1..128 objectives. Unknown/duplicate keys, wrong
types (including booleans as numbers), nonfinite and excessive values are rejected.

## Convergence And Reports

Measure all baselines before taking any steps. In each round, run one step for
every unconverged objective in config order, then remeasure **all** objectives in
that order. Metrics thus describe the project after the complete round, not
attributable effects of individual steps. Plateaued objectives skip steps but are
still remeasured; a later change resets their streak and reactivates them next
round. Measurements must not modify the project.

For direction sign `s = +1` (maximize) or `-1` (minimize):

```text
gain = s * (score - previous_score)
cumulative_gain = s * (score - baseline)
marginal_difference = gain - previous_gain
tolerance = absolute_tolerance + relative_tolerance * abs(previous_score)
stable = abs(gain) <= tolerance
```

The first marginal difference is null. Only near-zero **gain**, not merely a
near-zero difference between gains, counts as stability. Any larger change,
including regression, resets the streak. All objectives must have their required
successive stable rounds in the same final remeasurement sweep. There is **no
hard iteration cap**, and steadily improving, oscillating, or noisy objectives may
run indefinitely. This is a plateau criterion, not a guarantee of optimality or
positive cumulative gain. Tiny regressions within tolerance can also plateau.

Progress is streamed to stdout and appended as readable JSON lines to
`progress.log`. `report.jsonl` contains the same structured records: `start`,
`baseline`, `step`, per-objective `iteration`, and `final`. Iteration records include
scores, signed/cumulative gains, marginal differences, tolerance, streak, patience,
and whether a step ran. Final records report convergence with scores, failure with
an error, or interruption. Completed records are flushed and fsynced, including
after every iteration; an abrupt kill can still interrupt the current record or
leave a partial round. Existing reports append rather than resume optimizer state.

`commands.log` records labeled stdout/stderr chunks, retaining at most the first
8 MiB across the run directory. Subsequent output is drained and discarded, not
accumulated in memory or used to block children. Metric stdout has its independent
4 KiB validation cap even after log truncation. Logs flush as chunks arrive and
are fsynced with progress records. Progress/report files grow with the number of
iterations; budget storage accordingly.

The SSH harness likewise keeps streaming optimizer progress beyond its ordinary
8 MiB build-log cap. The UI retains the latest 256 KiB; full reports stay in the
remote `.spec-runs/run-<id>/` directory. Completed directories containing
`report.jsonl` are excluded from ordinary seven-day cleanup. Remove them manually
when no longer needed. Cancellation allows five seconds for an interrupted
report before forcibly terminating remaining processes; forced termination cannot
guarantee a final record.

Only run trusted configs: argv commands can modify files, use credentials, access
the network, spend money, or explicitly invoke their own shell. Discovery does not
sandbox a project or authorize its config. Review discovered identities/configs,
use trusted workspace/history ownership and permissions, budget unbounded costs,
and retain external cancellation. Use deterministic step/measurement programs for
reproducible results; this scheduler cannot remove measurement noise or external
concurrent mutations. Logs may contain secrets printed by commands.

## Tests

From the repository root:

```sh
python3 -B -m unittest discover -s backend/src -p optimize_test.py -v
```

Tests use temporary directories, Python subprocess fixtures, and the real Linux
shell harness with Git/flock to cover external-target contention and same-scope
supervisor locking. No project config, network, or history execution is required.
