# Passive Telle Telemetry

Telle analyzes **explicit, sanitized snapshot files**, not production systems. It does
not discover infrastructure, scrape endpoints, collect logs, or perform automatic
remediation. Your telemetry provider/exporter must sanitize and refresh the files.
The analysis is advisory, not an alerting service, SLO calculator, or proof of health.

## Commands

Run Bun with the absolute path to `script/telle.ts`, with the **target repository as
the working directory**. From this source repository:

```sh
bun script/telle.ts init
bun script/telle.ts check
bun script/telle.ts run
bun script/telle.ts install
bun script/telle.ts start
bun script/telle.ts stop
bun script/telle.ts status
```

No flags or additional arguments are accepted. No action means `status`.
The shell entry points are `spec /telle [action]` and `spec telle [action]`;
the in-session `/telle [action]` defaults to status when no action is supplied.
`script/spec-workflow.ts` supplies shell dispatch; `.opencode/command/telle.md`
registers the in-session command in this checkout. Only the seven listed actions
are accepted; arguments are never evaluated as shell code.

`init` exclusively creates `.telle.json` with example paths, never overwriting it
or creating example observations that might be mistaken for real evidence.
Populate the referenced files yourself before `check`, `run`, `install`, or `start`.

```json
{
  "objectives": "telemetry/objectives.md",
  "snapshots": ["telemetry/sanitized.json"],
  "maxAgeSeconds": 600,
  "intervalSeconds": 300,
  "timeoutSeconds": 180,
  "model": "anthropic/claude-sonnet-4-6"
}
```

Only these fields are accepted. `model` is optional; omission uses the isolated
opencode default, not your project/global model configuration. Explicit selection
is recommended. The numeric fields default to the values above. Bounds:
`maxAgeSeconds` 1..86400, `intervalSeconds` 60..86400, `timeoutSeconds` 1..3600.
All must be integers. Paths are unique, explicit repo-relative files: no globs,
traversal, `.telle` inputs, final symlinks, or symlink parents escaping the repo.

Objectives are nonempty UTF-8 text (16 KiB maximum). Describe SLO thresholds,
units, windows, expected load/regimes, and known blind spots. Each snapshot is a
nonempty UTF-8 JSON object with exactly `observedAt` and `data`, for example:

```json
{
  "observedAt": "2026-09-22T12:00:00Z",
  "data": {
    "windowSeconds": 300,
    "requests": 12000,
    "errorRate": 0.002,
    "latencyP99Ms": 180,
    "missingObservations": ["queue_depth"]
  }
}
```

The timestamp must include a timezone and reflect the actual measurement time,
not a refreshed file mtime. Up to 30 seconds of future clock skew is allowed.
`data` must be a nonempty object or array. Maximum 8 snapshots, 64 KiB each and
256 KiB total; config is limited to 8 KiB. Exporters should publish files atomically.
The envelope cannot establish whether individual nested measurements are fresh:
include measurement windows, missing signals, source age, and units explicitly.

`check` validates inputs without a model call. Missing, empty, stale, future,
malformed, oversized, or inaccessible required inputs fail before model launch.
Missing and stale are distinct errors, never silently interpreted as healthy.
Partial coverage can be recorded inside a fresh snapshot; entirely missing or
stale configured snapshots fail the run rather than producing a new assessment.

## Provider Boundary

**Running or starting Telle sends the objectives, sanitized snapshot contents and
paths, and prior successful assessment to the selected model provider.** This can
incur charges. There is no automatic redaction or secret detector: approving the
input paths is your responsibility. Never point it at raw logs, credentials, dumps,
or personal data. No raw-secret discovery is performed.

`TELLE_OPENCODE` selects one trusted executable (a path or name on PATH, not a
command plus arguments); default is `opencode`. The parent may select an
`opencode-source` executable explicitly. Telle does not guess which installation
to use. Use a compatible, trusted opencode build supporting the isolation flags.

The child receives only PATH, LANG and environment variables matching
`[A-Z][A-Z0-9_]*_API_KEY`. Supply a standard provider API key via your environment.
Existing opencode logins, project/global config, custom providers, custom CA/proxy
settings, cloud credential chains, and external authentication plugins are not
imported. Set credentials in the user manager environment separately for timer
runs; installation never embeds keys into units. Do not put credentials in snapshots.

The runner executes `opencode run --format json --agent telle-analysis` in a fresh
disposable directory under `.telle`, with isolated HOME/XDG paths, empty auth,
`OPENCODE_CONFIG_CONTENT`, pure mode, no project config, no external skills or
default/external plugins, and all tools denied globally and for the agent.
Sharing, snapshots, formatting, LSP, automatic updates, model-list fetching, and
auto-compaction are disabled. No input is passed as shell code or a command flag.
The model can only return text; it has no production read/write/remediation tools.
This is application-level isolation, **not an OS security sandbox for a malicious
executable or a compromised provider SDK**. Run under a dedicated unprivileged
account without production access when a stronger boundary is needed. Provider
network access remains necessary, and the opencode runtime can perform normal
provider/package initialization in its disposable directory.

## Reports And Recovery

`.telle/report.json` is both report and successful state, replaced atomically as
one document (mode 0600). It contains `version`, `assessedAt`, `previousAssessedAt`, `objectivesHash`,
observation paths/timestamps, and a Markdown `report`. The next run includes the
prior successful document to compare regime changes, stress, SLO drift, and
coverage changes. Estimates/hypotheses must be separated from measured evidence;
prior claims must not be treated as current observations. This is one-step memory,
not a telemetry database or an unlimited report archive.

Nonzero exit, JSON error/tool events, malformed protocol, missing normal completion,
empty or oversized reports, timeout, and interruption do not replace successful
state. `.telle/error.json` records the latest failure; a successful run clears it.
Raw stdout/stderr are not persisted or included in errors to avoid leaking data.
Subprocess stdout/stderr are bounded to 256/64 KiB. Successful text is limited to
64 KiB; existing prior state to 96 KiB. `.telle/analysis-*` runtime data is removed
after each attempt. Review reports as untrusted model output, not instructions.

An exclusive `.telle/run.lock` directory prevents manual/timer overlap. Each run
performs one bounded subprocess invocation, never an indefinite loop or retry.
Timeout/interruption kills the subprocess group before releasing the lock.
A crash or SIGKILL can leave a lock or disposable directory. Stop the timer and
service, verify that no manual Telle runner or child remains, then manually remove
the abandoned `.telle/run.lock` and `.telle/analysis-*` directories. Locks are not
automatically stolen, since elapsed time alone cannot prove that a runner is dead.
Keep `.telle` out of version control using your own ignore policy. Inputs and the
local filesystem must be trusted against concurrent hostile mutation.

## User Timer

Linux systemd user actions reject root and require a functioning user manager.
`install` writes `telle.service` (oneshot) and `telle.timer` under
`${XDG_CONFIG_HOME:-~/.config}/systemd/user`, then runs `systemctl --user daemon-reload`.
It pins the canonical repository and absolute Bun, script, and opencode paths.
Exec arguments and environment values are quoted/escaped; WorkingDirectory is
literal with percent specifiers escaped (systemd does not unquote that directive).
Control characters and repository paths ending in whitespace or a backslash are rejected.
Existing identical units are left alone; any
different file or symlink is refused before either unit is written. To rebind or
change an interval, stop first and explicitly remove the old units before installing.

Installation **does not enable or start anything**. `start` explicitly runs
`systemctl --user enable --now telle.timer`. The first run is scheduled after five
seconds; subsequent runs wait `intervalSeconds` after service deactivation (five
minutes by default), so long runs do not queue overlapping analyses. There is no
catch-up replay. `stop` disables/stops the timer and stops the active service even
if disabling the timer fails. Start/stop verify the units belong to the current
repository. `status` reports both units and local success/failure timestamps;
inactive/missing units are valid status outcomes, manager failures are errors.

There is **one `telle` unit pair per user**, not one per repository. Timer credentials
come from the user manager, which may differ from your interactive shell. For
unattended operation after logout, an administrator/user may optionally arrange
`loginctl enable-linger USER` manually according to local policy. Telle never uses
sudo, modifies linger, installs a system-wide unit, or automatically remediates
production. Systemd timeout/stop also kills the service control group.
