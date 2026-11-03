# Development Workflows

Use Spec as a short feedback loop: describe a bounded change, run it in a prepared
checkout, inspect evidence, and decide what happens next. It is not an autonomous
release gate. A green CLI exit, full progress bar, or confident agent summary
does not establish correctness.

## Write An Executable Spec

Use one file per coherent change. Include the target repository, current behavior,
desired behavior, constraints, acceptance criteria, and exact validation commands.
Give the agent observable outcomes rather than instructions such as "make it
production ready." Use `##` headings: a single leading `# ` has a special
completion meaning in this app.

For example, adapt this template to a real checkout and its actual test commands:

```text
## Target and problem
Work in /home/user/project/storefront on branch fix/cart-quantity.
Entering zero as a cart quantity currently removes the line without confirmation.

## Requirements
Reject quantities below one and show an inline error beside the quantity field.
Preserve the previous quantity and cart total after invalid input.
Cover keyboard submission and the narrow-screen layout.

## Constraints
Follow the existing form components and validation patterns.
Do not change pricing rules, dependencies, or unrelated files.
Do not commit, push, deploy, or call production services.

## Validation
Find the repository's documented test commands before editing.
Add a regression test that fails for the current bug, then make it pass.
Run the relevant suite and typecheck; report exact commands and results.
If a check cannot run, state the blocker rather than claiming it passed.

## Handoff
Summarize changed files, validation evidence, remaining risks, and next steps.
```

For an established repository, replace discovery with its exact commands, such as
`npm run test -- cart` only if that repository actually supports that invocation.
For a migration, specify compatibility and rollback requirements. For a refactor,
state which observable behavior must remain unchanged.

## Mark Only Verified Work Complete

Press `/` on a requirement line to add/remove its `# ` completion marker; Alt+/
inserts a literal slash. A completed line stays as context but is not a pending
implementation request. Removing the marker explicitly reopens it.

```text
## Cart validation
# Reject quantities below one and show an inline error.
Add a regression test for keyboard submission.
```

Only the first requirement above is complete. The heading does not complete the
section. Hashes in fenced/indented code and inline text remain code/text. Do not
mark a requirement complete just because the run exited successfully: check the
diff and tests first. Initial builds and follow-ups instruct the agent to review
relevant prior `.out` outputs and reconcile them against current source/tests;
logs are evidence, not authoritative implementation state.

## Choose The Right Action

| Goal | Action and effect |
| --- | --- |
| Preserve the current spec | **Save** or Ctrl/Cmd+S; active edited sheets also autosave. No build starts. |
| Run newly written requirements | **Save & run** or Ctrl/Cmd+Enter; confirms, saves, and uploads a new immutable snapshot. |
| Ask a read-only question | **Session chat**; separate AI conversation with spec/output context, no tools, not the build engine session. |
| Act on a completed build's recommendation | **Use recommended & continue**; immediately resumes that engine session with the fixed recommended-choice prompt. |
| Give that build a specific next action | **Send & continue** after confirmed success; uses your feedback, not editor changes. |
| Schedule one next action while a build runs | **Queue follow-up**; waits for confirmed success. Keep the browser page open for delivery. |
| Inspect a disconnected run | **Load nohup output** or **Active runs**; reads status/output, does not relaunch. |
| Create focused commits | **Save repo changes**, when available; explicitly confirms an agent-driven commit workflow, not a push or deployment. |

Feedback uses Enter to submit and Shift+Enter for a newline. One queued message
per run lives only in browser memory; it is not live stdin and cannot immediately
steer a running agent. Failure, cancellation, replacement, or ambiguous delivery
can pause it. Review the run before resubmitting to avoid duplicate work.

Continuation requires the latest confirmed successful build, captured engine
session metadata, and the same remote configuration. Editor edits are **never
included automatically** in continuation. Use a new Save & run after resolving
the previous run if the edited spec itself must become the new input.

## Daily Feature Or Bug-Fix Loop

1. Prepare a branch and dependencies in the **remote** project checkout. Confirm
   its starting `git status`; do not let an agent overwrite someone else's work.
2. Write a small spec with the failing case, acceptance criteria, and tests. Save
   it, then use Save & run after reading the execution warning.
3. Watch output for decisions and evidence. The task bar counts agent-reported
   todos, not independently tested requirements; keep-alives mean process liveness.
4. Inspect the actual remote diff and run the project's tests. For UI changes,
   check both desktop and mobile layouts and key failure states.
5. Ask a focused follow-up for a missing test or repair. Once verified, mark only
   the satisfied requirements complete and retain unresolved work as pending.
6. Commit/review using your normal Git workflow. Save repo changes can make focused
   commits with the spec as context; it is not authorized to push, amend, reset,
   or bypass hooks. Review the resulting commit before opening a PR or deploying.

For unfamiliar code, start with a **read-only investigation spec**: explicitly
request no edits, the relevant source paths, a reproduction, and a proposed fix.
Review that result before authorizing implementation in a later run/follow-up.
This is a workflow convention, not a separate enforced plan-mode sandbox.

## Teams And Parallel Work

The server and saved AI profile are single-user resources, not a team permission
system. Collaborate through reviewed specs, branches, commits, and CI rather than
sharing the server token. Keep versioned spec text separate from private logs,
credentials, and `.spec-output/` records.

Up to 16 active/unresolved spec runs are admitted, with one per filename, but
different filenames do **not** isolate code changes. Use separate checkouts and
appropriately configured server instances when work must not share a worktree.
Coordinate expensive GPU jobs and shared databases explicitly. Repository saving,
legacy Optimization, and remote locks add further concurrency restrictions.
Performance has separate lifecycle controls, not permission to race another job
against the same project files.

Keep specs and logs concise enough to inspect. Builds accept up to 120 KiB of
input; the browser retains only a bounded output tail. A full specification of
your whole product is usually less useful than a narrow, verifiable increment.
Do not include credentials, customer data, or production access in task text.

## Recover Before Retrying

Closing the browser or stopping the local server normally leaves an uploaded
remote build running. Reconnect with the new token, open the saved spec, and load
its output. Use **Active runs** to inspect a blocking run even if its spec tab is
not open. **Stop run** requests cancellation; a broken connection may prevent
confirmation.

An SSH attachment exit 255, missing directory, or absent status is not a verified
failure or success. Restore access to the original host/workspace and inspect it.
**Browse retained runs** can show another historical log but does not relink the
active run, clear its guard, or enable continuation. Never fabricate a `status`
file or delete recovery records merely to bypass an unresolved-run guard.

## Measure Performance Honestly

The **Performance** button runs the already-built Gemma RL workflow in an
explicitly selected remote project through a fresh builder session. It is not a
generic benchmark button or the standalone distillation pipeline. Supply an
existing implementation and its real prerequisites; missing data/models/builds
must be reported rather than replaced with synthetic results. Project search is
explicit and model-assisted; it sends bounded directory names/paths, not contents.
See [Performance](../PERFORMANCE.md).

For general iterative optimization, use the separate
[Optimization CLI/API](../OPTIMIZE.md) with real objectives and fixed measurements.
For example, optimizing API latency should use the same representative workload,
hardware, warm-up policy, and a read-only measurement command on every iteration.
Include a correctness/regression gate so a faster wrong answer is not success.
Keep evaluator code and held-out data outside the agent's permitted edit scope;
instructions alone do not enforce isolation.

The optimizer stops on measured stability, not a model's assertion. A plateau is
not an upper bound, global optimum, or proof of positive improvement. Noisy or
continually improving objectives can run indefinitely: there is no overall runtime
or iteration cap. Monitor cost, storage, and real progress, and cancel explicitly
when appropriate. Provider/tool timeouts do not constitute a total job budget.

Use [Analytics](ANALYTICS.md) to inspect supported `.out` metrics and optional
validated `.eval` checks. Preserve the measurement command, environment, commit,
dataset identity, and raw evidence needed to reproduce a claim. A chart does not
verify run completion, correctness, generalization, or production readiness.
