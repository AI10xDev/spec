# Deterministic Optimizer

`backend/src/optimize.py` uses Python 3.10+ on Linux and only the standard library.
Command supervision requires `prctl(PR_SET_CHILD_SUBREAPER)` and readable procfs
`/proc/self/task/<pid>/children`; unavailable supervision fails before command launch. It
optimizes a trusted project in either the shipped explicit-command JSON mode
(without an LLM) or free-form prose mode using `ResponsesOptimizer` with OpenCode
builder execution for each optimization iteration. Prose mode
calls the Responses API with model `gpt-6-sol` and the exact `instructions` value
`Optimize above till asymptotics`. Both modes use the same independently measured
scheduler to determine convergence, not model self-scores or declarations. The
script does not supply a project `.optim`: actual objectives must be chosen by
the project owner.

## Integration Contract

The top-right **Performance** button uploads the active, nonempty `.optim` editor
buffer through the existing authenticated SSH harness, including unsaved changes.
It does not save the file locally or change the editor's saved revision. Confirm
execution only for trusted commands. View live progress under **Optimization** in Output & logs; **Stop run**
cancels the run. Reloading restores its status, and selecting Optimization retries
a failed initial recovery. Remote execution must be configured as for Save & run.

The UI sends `POST /api/optimize` with `{"name":"task.optim","content":"..."}`.
The harness puts the unchanged bytes of `backend/src/optimize.py` in the run's
`snapshot.md`, then uploads the spec unchanged to a unique mode-0600
`~/projects/spec-optimization.XXXXXXXX.optim` on the remote host. It resolves that
directory there and passes the uploaded file's absolute path when launching:

```sh
python3 -u snapshot.md RUN_DIRECTORY WORKSPACE CONFIG_PATH
```

`WORKSPACE` is the directory containing the build harness's `.spec-runs` registry;
the discovered project may be elsewhere. `RUN_DIRECTORY` receives append-only
reports and is created if needed. Prefer absolute paths and a fresh run directory.
The script can also be executed directly under its `.py` name with these arguments.
Only standalone `.py` invocations may omit `CONFIG_PATH` to use project-root
lookup. Optimization has a separate persisted output pointer from file builds.
Uploads are byte-count framed separately from the script and cancellation control;
incomplete uploads fail before launch and remove the partial config. After launch,
the uploaded config is retained alongside the reports' reference to its path;
remove it manually when no longer needed.

Before loading config or measuring, the optimizer takes a nonblocking exclusive
`flock` on the actual target project's lock directory. It uses Git to resolve the
same worktree-specific `spec-harness` directory as the build harness, or the
project's `.spec-runs` directory outside Git. These directories must be owned by
the current user, nonsymlink directories with mode 0700. The lock is held through
all measurements and steps, including when another workspace discovered this
project; contention fails without running project commands. Git overrides
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and `GIT_COMMON_DIR` are ignored for
lock scope resolution, as in the build harness.

After acquiring an external target's lock, the optimizer also checks that
worktree's persistent `spec-harness/run-*` records and the target project's legacy
`.spec-runs/run-*` directories. A free lock alone is not completion evidence.
Each prior session must have an owned, private, regular, single-link `status`
file containing a terminal exit code in `0..255`; nonzero terminal exits are
resolved too. Malformed records, missing status, symlinks, unsafe permissions,
and oversized evidence refuse admission before config loading, model planning,
measurements, or commands. Registry records support current operation modes and
the older path-only format. Admission does not delete records or run evidence.
An unresolved-session error identifies the offending record or run directory;
inspect that session and establish that its work stopped before retrying. Do not
delete evidence or invent a successful status merely to bypass this guard.

The harness sets the internal `SPEC_OPTIM_WORKSPACE_LOCK` environment variable to
the device/inode identity of the exclusive lock retained by its supervisor. A
matching target reuses that protection instead of conflicting with its own
supervisor; other targets acquire an additional lock. Do not set this variable
for standalone invocations. It is removed from objective subprocess environments,
and lock descriptors are not passed to those subprocesses.
For a matching supervisor lock, the launcher has already checked admission, so
the optimizer skips the prior-run scan rather than rejecting its own active run.
Locks are advisory, not a sandbox. Normal completion, command failure, timeout,
and handled cancellation finish command-descendant cleanup before releasing the
target lock. An external target's additional lock is owned by the optimizer
process; abrupt process death can release it before cleanup finishes. Confirm
remote cleanup before restarting work after a crash or forced termination.

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

The caller must own cancellation and signal the optimizer's **whole process group**.
Direct commands inherit that group; OpenCode may create detached tool sessions.
SIGTERM/SIGINT attempt an `interrupted` final report and exit 130. SIGKILL cannot
write a final report. Exit 0 means joint convergence; exit 1 means failure; exit 2
means incorrect CLI arguments. No optimizer iteration or wall-clock limit exists.
An integrating supervisor must not silently apply its ordinary build timeout if
unbounded optimization is desired.

Every command (builder, model tool, process, or measurement) runs under its own
Python subreaper process. Detached and double-forked descendants are adopted there,
not by the optimizer's caller. On completion, failure, timeout, or handled
cancellation, that subreaper kills remaining live children with SIGKILL and reaps
them, repeating as further descendants are adopted. Only its own unreaped direct
children are signaled, avoiding PID-reuse races and unrelated caller processes.
The optimizer waits for this cleanup before continuing, measuring, or releasing
the project lock. Repeated SIGINT/SIGTERM are blocked during cleanup. A successful
command that leaves live descendants behind is cleaned up and reported as a failure;
commands must finish all project work before returning. Detached sessions used
synchronously by OpenCode are supported.

Cleanup can exceed a command's timeout: unkillable processes or cleanup errors
retain supervision rather than voluntarily releasing the lock. This is not a
sandbox or a SIGKILL/crash guarantee. Killing the optimizer or its subreaper,
including the SSH supervisor's five-second forced-kill escalation, can defeat
cleanup. Work delegated to an already-running external service is not a descendant
and cannot be tracked this way. Privileged or hostile commands are outside this
guarantee. Use external containment such as a cgroup if cleanup must survive forced
process death, and verify cleanup before restarting after such an event. Use one
optimizer at a time per project and keep measurements read-only.

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
3. Read `~/.bash_history` (never evaluate it). Filename references such as
   `cat nohup.out`, shell comments, and simple literal-only `echo` or
   `printf '%s'`/`printf '%s\n'` descriptions are not invocations.
   An embedded hash in a shell word is not a
   comment. Other quoted `nohup` command text remains a candidate, including
   wrappers such as `bash -c`, `eval`, and `ssh`; these fail closed rather than
   falling back to an older build. This is a conservative lexical filter, not a
   general shell parser: ambiguous descriptions may also fail closed.
   Unless superseded by an invocation record, the last candidate must match one of the
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
history timestamp, durable invocation metadata takes precedence, even if the
history entry is unsupported: undated global shell history cannot establish a
newer launch. Without invocation metadata, an undated history entry must agree
with any legacy output identity, otherwise ordering is ambiguous and fails.
History alone uses its last entry's position.
History may be stale until Bash flushes it; new harness builds record launch
metadata directly. An ambiguous external shell invocation requires a timestamped,
supported history entry before optimization can safely choose the latest target.

## Configuration

UI runs always load the explicitly uploaded absolute `CONFIG_PATH`; they never
search the discovered project root or fall back to a different config. The report's
`config` field identifies this input. Missing or invalid explicit configs fail
instead of executing another file. No default process or measurements are invented.

For standalone `.py` invocations without `CONFIG_PATH` only, in the discovered
project root prefer `<filename>.optim`, then `<stem>.optim`
(for `task.md`: `task.md.optim`, then `task.optim`). Use the original filename's
basename for this lookup, even if the recorded name includes directories. If
neither exists, require exactly one root-level `*.optim`. Ambiguity is an error.

If selection fails, the final failure report includes the discovered `project`,
`filename`, build `output`, and invocation `source`. A missing-config error lists
the expected paths; an ambiguity error also lists the competing candidates.
For standalone lookup, create the intended config in that project on the
**execution host**, or supply an absolute `CONFIG_PATH`. In the UI, select the
`.optim` tab and click Performance to upload its current contents instead.
No older build is selected to work around missing config.

The discovered project is the execution directory recorded in the selected build
invocation, not a repository name mentioned in the build prompt. For example,
mentioning `ai10xdev/spec` does not redirect a build recorded under
`/home/opencode/project` to `/home/opencode/spec`. When the report identifies the
project and filename but says no `.optim` file exists, discovery succeeded;
the missing process and measurable objectives must be supplied by the owner.
Do not work around this by selecting an unrelated config or inventing objectives.

The `.optim` file must be nonempty UTF-8 and at most 1 MiB. An optional leading
UTF-8 BOM is ignored for mode detection. If its first
non-whitespace character is `{`, it is parsed as strict JSON v1 using the shipped
explicit-command mode; malformed JSON does not fall back to prose. Other nonempty
content selects free-form Responses mode.

### Free-Form Responses Mode

For example, a project owner could write `task.md.optim` as:

```text
Optimize the pending objectives in task.md while preserving completed requirements.
Improve request throughput without changing externally visible behavior.
Inspect the existing benchmark and tests, establish a repeatable read-only
throughput measurement in requests per second, and keep that measurement fixed.
Profile the hot path, implement one improvement at a time, and run correctness
tests before accepting a change. Maximize throughput with absolute tolerance
0.000001, relative tolerance 0.0001, and patience 3. Set timeout_seconds to 300
for each command and measurement.
```

This is illustrative prose, not a shipped objective or a guarantee that a suitable
benchmark exists. The model first plans, using `run_command` to inspect the
project as needed. It is instructed not to optimize during planning, to respect
completed spec lines and unrelated user changes, and to return a JSON v1 plan
covering every pending objective and its corresponding `.optim` process. The plan
defines objective names, one-step command argv, fixed read-only scalar measurement
argv, directions, tolerances, patience, and optional command timeouts. It is
validated with the same schema as explicit JSON below. If no real measurement can
be established, the model is instructed to explain why rather than invent scores;
a non-plan response fails validation.

After planning, the scheduler measures all baselines. For each active objective
in each round, it first invokes the OpenCode **build** agent for one focused
refactor, asking it to delegate inspection to the **explore** subagent when useful.
The builder receives the original objectives, unchanged `.optim` text, bounded
build output, the objective's process and fixed measurements, measured states,
and prior summaries. Completed requirements and unrelated changes must be preserved.
The Responses model then receives that builder result, the plan for that objective,
measured states, and previous step summaries. It reviews and validates the builder's
changes rather than repeating the refactor, and is instructed to inspect and apply
improvements through `run_command`, including executing the planned command when
appropriate, then return a factual summary. Tool calls execute real argv commands
on the execution host and return output to the model; this is not a plan-only
workflow. The scheduler executes the planned optimization command after the model
summary unless its last tool in this step ran that exact argv successfully.
Every subsequent tool invalidates prior validation, even an apparent inspection,
because tool mutability is unknown; a failed rerun also invalidates success.
Inspection-only calls or unsupported claims of convergence cannot replace the
planned process. Nonzero model tool exits return their exit status and output to
the model for diagnosis and repair; a failed scheduler-run process still fails the
run. The scheduler independently executes the fixed measurement commands after the round and alone
owns convergence. Instructions prohibit changing measurement definitions,
fabricating scores, reading credentials, or declaring convergence; these are
model instructions, not a sandbox or an enforced guarantee of model behavior.

Install and authenticate OpenCode on the execution host. The default executable
is `opencode` on `PATH`; set `SPEC_OPTIM_OPENCODE=/absolute/path/to/opencode-source`
(or another compatible executable) to override it. This is one executable path,
not a shell command or alias. It must support:

```sh
opencode run --dir PROJECT --agent build --auto --format json -- 'Follow the optimization iteration instructions supplied on stdin.' < CONTEXT.md
```

`--auto` requests unattended permission approval, as in the build harness; only
use this flow for trusted projects. The build agent delegates to explore because
OpenCode's explore agent is normally subagent-only, not directly runnable.
Provider/model selection and agent permissions use the execution host's existing
OpenCode configuration; the optimizer does not replace that configuration.
Responses credentials below are also required for planning and validation.
Shell aliases are not loaded. The remote launcher includes `~/.local/bin` and
`~/.bun/bin` on `PATH`; other installations need a configured executable path.

Context is supplied on stdin through an unnamed temporary mode-0600 file, avoiding
both command-line size limits and OpenCode's truncating attachment reader. The
descriptor is closed on completion, failure, or cancellation. Builder output retains
the last 64 KiB so verbose tool output does not displace the final summary, and is
included in progress reports. Each builder runs under the per-command subreaper
and the objective's command timeout, including cleanup of detached OpenCode tools
as described above.
A missing executable, nonzero builder exit, timeout, or OpenCode stderr warning about
falling back to the default agent fails the run, not convergence. JSON mode keeps
tool/model events on stdout separate from these diagnostics, so quoted warning
text in tool results does not trigger fallback detection. Compatible executables
must preserve this stdout/stderr contract. Keep the `build`
agent enabled and runnable as a primary agent in the host's configuration.
No nested `spec build` is launched: it would contend with the optimizer's project
lock. Planned commands should perform project process work and correctness
validation rather than launch another locking harness.

By default, Performance reuses the connected Azure API provider on the **remote
execution host** (or the local execution host for direct runs), as used by the
installed `spec build` launcher. It reads `azure` in
`${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json` and asks OpenCode for its
merged `debug config` in the discovered build project. This avoids using an old
editor dotenv endpoint/key when Build already has a working Azure connection.
The configuration command uses `SPEC_OPTIM_OPENCODE` if set, otherwise
`opencode-source` when available (the installed build launcher's engine), then
`opencode`. The same executable is used for subsequent optimization builder steps.

OpenCode's `provider.azure.options.baseURL` takes precedence over the resource URL.
Resource-name precedence is `options.resourceName`, connected auth
`metadata.resourceName`, then `AZURE_RESOURCE_NAME`. The API key comes from
`options.apiKey` or the connected Azure auth entry; endpoint and key are selected
together, not mixed with an automatically discovered dotenv. Requests preserve
`options.apiVersion` (default `v1`) as the Azure SDK's `api-version` query parameter.
The optimizer still uses `gpt-6-sol`, not Build's selected model; that deployment
must be available on the shared resource.

Config resolution is bounded to 30 seconds and 1 MiB of stdout. Its stdout and
stderr are private, including on failure; only a credential-free `model_config`
source event is reported. An invalid connected configuration fails rather than
silently switching resources. Deployment/chat routing and custom provider headers
are not supported by this direct Responses client; select explicit Responses
settings for those installations. OAuth and non-Azure auth entries are not reused.

For an explicit override, configure credentials in the environment or select a
private dotenv file on the execution host:

| Provider | Execution-host environment |
| --- | --- |
| Azure | `AZURE_OPENAI_ENDPOINT=https://RESOURCE.openai.azure.com` and `AZURE_OPENAI_API_KEY` |
| OpenAI | `OPENAI_API_KEY`, with `AZURE_OPENAI_ENDPOINT` unset |

Setting any of the three credential variables above, `SPEC_AI_ENV_FILE`, or
`KIBI_ENV_FILE` bypasses connected OpenCode lookup. Direct environment credentials
must form a complete provider configuration; they do not borrow missing values
from an automatically discovered dotenv. To combine exported overrides with a
dotenv, select that file explicitly. With an explicit dotenv, or when neither
environment credentials nor a connected Azure API entry exists, the optimizer reads `SPEC_AI_ENV_FILE`
when set, otherwise `KIBI_ENV_FILE` (the
installed Spec editor's existing setting). Without either override, it reads the
nearest `.env` in the discovered build project or its ancestors, falling back to
`~/code.dev/.env`, the installed Spec editor launcher's shared default. It reads
only one file, not files relative to the uploaded `.optim` or Python snapshot.
Explicit paths may use `~`; relative paths are resolved against the build project.
Missing explicit files and invalid AI assignments fail with a sanitized error.
Exported variables override the corresponding file values, including empty values.
Only `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, and `OPENAI_API_KEY` are
consumed; they are not added to the process environment or model context. Supported
dotenv syntax is single-line `KEY=value`, optional `export`, single/double quotes,
and comments. Values are literal: shell commands, escapes, and variable expansion
are not evaluated. Keep credentials private and do not commit dotenv files.

Azure also accepts endpoint paths ending in `/openai/v1` and
`/openai/v1/responses`, including gateway routing prefixes. For example,
`https://gateway.example/team/azure/openai/v1` becomes
`https://gateway.example/team/azure/openai/v1/responses`; the prefix is preserved,
and a full Responses URL is used as-is (apart from trailing slashes). Resource-root
URLs use `/openai/v1/responses`. All Azure requests use the `api-key` header. Without
`AZURE_OPENAI_ENDPOINT`, requests use `https://api.openai.com/v1/responses` with
Bearer authentication. Presence of the Azure endpoint selects Azure, with no
fallback to the OpenAI key. Endpoints must be HTTPS without embedded credentials,
queries, fragments, or whitespace; the inherited SDK API version is added separately.
Redirects are not followed. The selected key
must be nonempty ASCII without whitespace, and the provider must support
`gpt-6-sol`. This is **not Rust/UI server configuration**: setting keys only on
that server does not configure the remote optimizer. Shell aliases are not
sourced or executed to obtain endpoint/key settings. JSON mode needs no model
credentials and makes no Responses requests.

There is no overall iteration, tool-call, model-turn, or run wall-clock cap.
Each Responses request uses a 300-second network timeout. Temporary DNS lookup
failures (`EAI_AGAIN`) before sending the request get two retries after 1 and 2
seconds, recorded as `model_retry` events. Permanent DNS errors and other request
failures are not retried; in particular, ambiguous failures after sending a POST
must not replay model work. Exhausted retries and all other request failures stop
the run, never count as convergence.
Request failures report HTTP status with troubleshooting guidance, or distinguish
DNS, TLS/certificate, timeout, connection, and invalid-JSON failures. Provider error
bodies, URLs, and headers are not logged because they may contain credentials.
An HTTP 404 can indicate either a wrong Responses route or an unavailable
`gpt-6-sol` deployment; HTTP 401/403 indicates authentication or access checks,
and HTTP 429 requires checking rate limits/quota. Build and Performance use separate
provider clients and may select different models, even when sharing the connected
Azure endpoint and API authentication. A working build therefore does not verify
that the optimizer's model is deployed or its Responses payload is supported.
This is not an overall optimization deadline. Each planning tool command has a
300-second timeout. Each optimization tool command uses its objective's
`timeout_seconds`, as do measurements; omitted or null means no command timeout.
That timeout applies per command, not to the entire model-guided step.

If a run logs `model_request` for `planning` at iteration 0, initial endpoint and
credential validation has already passed; that event does not mean the provider
accepted the request. Read the complete `final` record in that run's `report.jsonl`
for the failure reason. A trailing `/openai/v1/` is supported and is expanded to
`/openai/v1/responses`; do not change it solely because planning failed. If the
error still lacks the request diagnostics above, rebuild and restart the Spec
server (`./run.sh`), reload the browser, and start a new Performance run. The server
embeds `optimize.py` at compile time and uploads a snapshot for each run; updating
the source or retrying an old snapshot alone does not update that embedded code.
For DNS failures, verify the configured endpoint hostname using
`getent ahosts HOSTNAME` on the execution host. If it resolves but Performance still reports DNS
errors, check the execution process's proxy settings and proxy hostname as well.
Use the Azure resource's published endpoint; do not hard-code a resolved IP,
disable TLS verification, or switch providers to work around DNS failures.

### Explicit JSON Mode And Shared Schema

The shipped strict JSON v1 format is retained, for example:

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
In JSON mode, the scheduler directly executes each active objective's `command`
once per round, without model planning or model tool calls.
`name`, `command`, `measure`, and `direction` are required for every objective.
Names must be unique, printable, nonblank strings of at most 200 characters.
Argv arrays must have 1..256 string elements, a nonempty executable, no NULs, and
at most 65,536 total characters. Commands run with the discovered project as cwd,
inherited environment, and stdin closed (except builder context input above).
No `shell=True` is used. Arguments remain
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
JSON step command, model tool command, and measurement, including baseline:
positive and at most 86,400 seconds;
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
run indefinitely. This is a measured plateau criterion, not a guarantee of an
asymptotic optimum, global optimality, or positive cumulative gain, regardless of
the model's instructions. Tiny regressions within tolerance can also plateau.
Scores come from independently executed measurement commands, never model
self-scores; their usefulness still depends on the validity of those measurements.

Progress is streamed to stdout and appended as readable JSON lines to
`progress.log`. `report.jsonl` contains the same structured records: `start`,
`baseline`, `step`, per-objective `iteration`, and `final`. Responses mode also
records `model_request` (model, objective, iteration), `model_tool` (executed argv),
`process` (the planned command when dispatched by the scheduler),
`plan` (model and validated objectives), and `model_step` (factual step summary).
`builder_start` records each OpenCode invocation; `builder_result` records its
exit code, bounded output, and truncation flag before validation and measurement.
Every record includes a Unix-seconds `timestamp`, so model requests, plans, tool
dispatches, steps, and numeric results can be correlated. Iteration records include
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

### Model Privacy And Trust

Responses mode sends the provider the project path, original filename, original
objective file contents when available (up to 1 MiB), the complete `.optim` text,
and the last 64 KiB of original build output with a truncation flag. If the
original objective file is unavailable, the context says so; the run does not
require it to exist. It also sends measured states and step summaries, and up to
64 KiB of combined stdout/stderr per tool call, with an exit code and a truncation
flag when the buffer fills. Tool inspection can expose additional project contents. The
Responses payload sets `store: false`; this does not prevent transmission to the
provider or establish a broader provider retention guarantee.
The same objective/process context and measured states are supplied to OpenCode's
configured builder provider; builder output is also sent to the Responses model.

Model-directed code is unrestricted trusted code, **not sandboxed**. Tools have
the same project cwd and inherited environment as other commands, including
access to execution-host credentials. Bounded output, argv validation, locks, and
instructions not to read credentials are not security isolation. Review what the
objective, `.optim`, build logs, and tools may disclose before enabling prose
mode. Local reports include model plans, tool argv, summaries, and command output
and may also contain sensitive data.

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
supervisor locking. Detached-session and double-fork fixtures cover timeout,
cancellation, successful exits with leftover workers, and failed exits, verifying
cleanup before lock release and survival of unrelated caller children. Those
fixtures use Linux pidfds for safe test cleanup. Validation regressions cover
later edits, failed reruns, inspection, and successful final revalidation.
No project config, network, or history execution is required.
