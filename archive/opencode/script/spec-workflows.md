# Spec Agent Workflows

This checkout registers `/eval` and `/telle` as OpenCode slash commands. Quit and
restart OpenCode to load them. They do not require changes to the server or SDK.

The installed `spec` executable and Bash `spec()` function on this machine dispatch
the following commands from the caller's working directory:

```sh
spec --help
spec --manual
spec /eval "Investigate p99 latency against the documented SLO"
spec /telle init
spec /telle check
spec /telle run
spec /telle install
spec /telle start
spec /telle status
spec /telle stop
```

`spec --manual` prints the [step-by-step guide](spec-manual.md) without opening
the editor or calling a model. `spec --help` (or `spec -h`) prints a short command
summary. Pipe the manual to `less` to page it, or redirect it to save a copy.

Reload `~/.bash_aliases` in existing shells, or open a new shell, to update the
function. `spec telle` is equivalent to `spec /telle`. Existing `spec eval`,
`spec --eval`, editor and `spec build` behavior is unchanged. The slash is intentional:
the older evaluation tool already owns `spec eval`.

## Hypothesis

`/eval` selects the restricted `hypothesis` agent. It discovers repository objectives,
implementation evidence and sanitized telemetry, then writes a literal `.hyp` file
in the working directory. It proposes a falsifiable experiment and a bounded
convergence/marginal-gain analysis, explicitly separating measurements from scenarios.
Missing evidence produces a provisional/blocked assessment, not invented performance
results. It cannot execute benchmarks or modify production/source code.

`spec /eval` loads these same agent/command definitions explicitly so it also works
from other repositories. `SPEC_OPENCODE` can select a trusted OpenCode executable;
the default is `opencode`. Model/provider configuration is inherited normally.
Read access is needed for discovery; do not point it at unredacted telemetry or
secret directories. Permission rules are not a substitute for sanitizing inputs.

## Telemetry

See [telle.md](telle.md) for the snapshot format, provider authentication, systemd
setup, bounds, failure handling and crash recovery. No telemetry source is configured
and no service is started by adding these workflows. `init` writes only a template;
an exporter must supply fresh, sanitized observations. `install` writes the user
units; `start` explicitly enables recurring model calls and costs.

Control units directly with `systemctl --user status telle.timer telle.service` and
view execution failures with `journalctl --user -u telle.service`. The `telle` name
is a systemd unit pair, not a Linux namespace. There is one pair per user.

Adaptation means updated assessments and recommended responses to stress, not
automatic scaling, deployment or remediation. Production connectors and remediation
require an explicit target, access policy, SLOs and approval boundaries.

## Other Installations

The shell integration installed on this machine references this checkout. Elsewhere,
add this dispatch before existing cases in your `spec` shell function or launcher,
using the actual absolute Bun and checkout paths:

```sh
if [[ "${1:-}" == --manual || "${1:-}" == --help || "${1:-}" == -h || "${1:-}" == /eval || "${1:-}" == /telle || "${1:-}" == telle ]]; then
  /absolute/path/to/bun /absolute/path/to/checkout/script/spec-workflow.ts "$@"
  return
fi
```

Use `exec` instead of the invocation plus `return` in an executable launcher.
In-session slash commands are project-scoped here; on another project, install the
command/agent Markdown definitions under its `.opencode/` directory or your global
`~/.config/opencode/` directory. Shell `spec /eval` and `spec /telle` do not require
copying those definitions. Ignore `.hyp`, `.telle.json`, and `.telle/` in target repos
when their local operational data should not be committed.
