# Staged Supervised Builds

This describes the current staged implementation, not proof that an execution
host or an older tagged Spec release has been upgraded. Repository-save, Optimize
and Performance retain their separate behavior.

## Builder, Approval, Integrator

1. **Save & run** uploads an immutable saved spec and starts a **Builder** sweep.
   It explores and plans, may edit preliminary unit/smoke tests and run
   experiments, and produces a concrete handoff. It is **not read-only**, but
   must not implement the feature end-to-end.
2. Review the **Builder report**, actual edits, checks, plan and blockers. Use
   **Send & revise builder** or **Use recommended & revise builder** for another
   sweep in the same Builder session. Neither is approval to implement.
3. **Approve & implement** explicitly submits authenticated
   `POST /api/runs/{id}/approve` with `{}`. Only the latest successful Builder
   with a durable validated report and matching remote configuration is eligible.
   The server also requires saved spec content to match the original snapshot
   and no pending saved-build queue entry for that Builder.
   The backend starts a **fresh Integrator session** with the original saved
   snapshot and that approved Builder handoff, not current editor text or drafts.
4. The Integrator further explores and implements the approved work end-to-end,
   including integration and verification. **Send & continue** resumes that same
   Integrator session; every follow-up retains the original approved handoff as
   context, not new permissions or approval for unrelated scope.

Saving, editing, feedback, recommended-choice continuations and queues **never
autoapprove integration**. Browser-memory queued feedback resumes the same stage
after confirmed success and needs the page open. Persisted queued editor snapshots
start fresh Builders after confirmed success and survive browser/server restarts.
The backend rejects changed/missing saved specs and pending (waiting) saved-build
queue entries at approval admission. The UI additionally requires resolving editor
changes, feedback drafts and queued revisions before approval; edited requirements
need a new Builder report. Approval never includes unsaved drafts.

## Durable Reports

Private local `.spec-output/` run records persist the stage, original snapshot,
validated result and, for Integrators, the approved Builder handoff. Each successful
stage writes a separate private remote `result.json` with this envelope:

```json
{"version":1,"stage":"builder","report":"Concrete handoff or stage report"}
```

Results use `builder` or `integrator`; handoffs must use `builder`. The report
comes from the executing actor's final settled step, never Sol's advice. The
nonempty report is limited to 120 KiB UTF-8. The backend checks the envelope, stage,
provenance, private storage and successful remote status before exposing it.
The UI displays the report separately from the capped/truncated runtime log, so
approval does not depend on finding a report in the visible log tail. Validation
checks the report's structure and origin, **not implementation correctness**.
Missing/invalid results cannot authorize approval or continuation; result transport
failures remain unresolved for recovery. Legacy runs without staged metadata need
a new Builder, not an inferred approval from old logs.

## Models, Tools And Questions

**GPT-Astra (`azure/gpt-6-astra`) is the required executing model in both stages**;
there is no execution-model fallback. Clear the selected execution profile in
Settings and configure Astra on the execution host. Selected single-model profiles
are rejected for staged builds, not substituted for Astra.

GPT-Sol (`azure/gpt-6-sol`) is optional, read-only, nonblocking advisory. Missing
Sol, setup/provider errors, timeouts, malformed advice and block/fix verdicts do
not gate execution startup, tools or successful completion. Sol has only `read`
and its own session's `todowrite`; its interactive requests are rejected. It
maintains a separate advisory checklist, excluded from execution progress. There
is no model-mediated approval gate or forced review/fix loop. The detached Bash
supervisor still owns process lifecycle and logs; it is not the advisory model.

The executing actor may read and edit workspace files. Other permitted tool
requests are automatically approved **once per request by the runner**, after
correlation with the owned session and active tool invocation. There are no global
`always` grants. The runner explicitly denies `task`, `external_directory`,
`glob` and `grep`; current V2 glob/grep lack canonical workspace confinement.
Use `read` for directory listings or scoped commands for search. These tool rules
do not confine the effects of an approved shell command.

Permission `resources` are action-specific match subjects; `save` patterns only
apply to an `always` reply and are not persisted by `once`. A `todowrite` request
updates bookkeeping, not authorization for actions in its text. Saved project
grants block runner startup. Global permission/question auto flags remain off.

**Questions are not autoanswered, including recommended options.** The runner
rejects them with guidance to report the question, options and blocker for user
feedback. Rejection is not user approval and need not fail the entire sweep.
There is no live browser runtime-answer channel; supply answers through a later
same-stage feedback sweep. A user-clicked recommended-choice follow-up is distinct
from automatically answering a tool's runtime question.

## Execution-Host Setup

The host owner must explicitly install OpenCode from
[`AI10x/opencode-fork`](https://github.com/AI10x/opencode-fork), `main` commit
`e60a017d878486eb6b143e55cb9b9f320091d46d`, or an equivalent staged implementation.
Install the checkout's runner and dependencies and rebuild its V2-capable engine;
copying only `run-spec.sh` is insufficient. Bun is required by the runner. The
engine is selected by `SPEC_OPENCODE`, otherwise the checkout's host-specific
compiled binary if present, then an executable `opencode-source` on PATH.
The [installation walkthrough](INSTALLATION.md#install-the-external-runner) covers
cloning that external checkout, building the engine, configuring models/policy,
exporting trusted paths and checking the contract without provider work.

In the **trusted remote `~/.bash_aliases`**, outside any interactive-shell guard,
configure the absolute executable runner path, for example:

```sh
export SPEC_WORKFLOW_RUNNER=/absolute/path/to/script/run-spec.sh
```

On that host, verify the installation without starting provider work:

```sh
test -x "$SPEC_WORKFLOW_RUNNER"
"$SPEC_WORKFLOW_RUNNER" --workflow-version
```

The probe must exit 0 and print **exactly `spec-workflow-v1` plus a newline**.
The adapter sources `~/.bash_aliases`, probes that executable, then invokes the
same path directly with the snapshot. Builds, approval and continuation have
**no fallback to `spec build` or another legacy wrapper**. Interactive `.bashrc`
and login profiles are not loaded. Export custom engine PATH settings in the same
trusted alias file if needed. The adapter sets `SPEC_BUILD_SUPERVISED=1`, keeps
`SPEC_BUILD_FOREGROUND=1 SPEC_BUILD_AUTO=1`, and overrides
`OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS=0 OPENCODE_QUESTION_AUTO_RECOMMEND=0`.

Rebuild/restart the Spec backend that launches SSH runs to embed its current
adapter; already-running supervisors are not upgraded. **Spec does not deploy the
host engine, runner, provider configuration or policy. No live host deployment or
live-provider validation was performed for this documentation update.**

## Runtime Policy

The runner loads the execution user's trusted `~/projects/Agent.md` (for the
`opencode` user, `/home/opencode/projects/Agent.md`), or an absolute
`SPEC_AGENT_POLICY` override. Missing/invalid policy blocks startup. The file must
be owned, regular, nonsymlink and not writable by group/others, with one validated
`spec-build-policy` JSON block. Each new invocation, including continuation,
reloads it; an active runner keeps its loaded policy.

[`../Agent.md`](../Agent.md) is a **versioned repository snapshot**, not that runtime
policy. Its existing external targets and task-specific constraints are unchanged.
Its older descriptions of Sol permission review and allowlists do not describe
the current runner: `rules`, `cli`, `githubAccounts`, `regions` and `infrastructure`
are advisory prompt constraints, not enforced shell allowlists, IAM or a sandbox.
Editing or reloading the repository/editor copy does not deploy a host policy.
Host-policy changes are a separate, explicit host-owner action.

`reviewTimeoutMs` bounds optional advisory work, not an execution approval gate.
`maxFixes` remains parsed for existing host policies but does not trigger a forced
repair loop. `runTimeoutMs` limits execution even though the outer Bash supervisor
has no overall runtime limit. Numeric `maxTokens` is the **executing actor's
per-sweep reported-token budget**, excluding Sol; `null` disables that cap. Both
actors' usage is reported, and continuation gets a fresh budget. In-flight work,
hidden retries and unreported usage can exceed reported thresholds; enforce hard
billing caps at the provider.

Use restricted OS identities, containers and IAM for hard boundaries. Tools and
trusted plugins retain the execution user's authority and can access credentials,
the network and paid services. Failed runs can leave edits and retained session
claims requiring manual recovery. A report, model verdict or successful process
exit is not proof of correctness; inspect the actual diff and validation evidence.
The installed OpenCode checkout's `script/spec-supervisor.md` documents its full
runner contract and recovery rules.
