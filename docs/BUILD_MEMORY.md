# Build Sweep Memory

Spec records structured memory for builds launched by this web backend. Each
initial build, queued build, and continuation is one **sweep**, identified by its
existing run UUID. A continuation gets a new sweep ID while retaining the engine
session ID and linking to its parent. Individual model turns inside a build are
not separate sweeps. Repository saves, optimizers, and Performance runs are excluded.

The agent is instructed to report four properties at the end of each sweep:

| Property | Meaning |
| --- | --- |
| `whatChanged` | Changes made, with file or artifact references |
| `why` | Reasons for those changes |
| `whatWasChecked` | Actual checks and results, including failures or checks not run |
| `unresolved` | Remaining work, blockers, and uncertainty |

These are **unverified agent claims**, not proof of completion or passed tests.
The operational `status` and `recover` fields come from existing run lifecycle
records, independently of the report. A successful exit without a report remains
`MISSING`; malformed and truncated reports remain explicit. A valid earlier
capture survives later log truncation, with warnings if the current log no longer
contains it. Empty arrays do not establish that all work is complete.

## GraphQL API

Send JSON GraphQL requests to `POST /api/memory/graphql` using the server's normal
`Authorization: Bearer ...` header. The endpoint is loopback-only, authenticated,
read-only, and sends `Cache-Control: no-store`. It provides standard GraphQL
variables, introspection, and validation. No database service, provider key, or
additional configuration is required; SQLite is bundled with the backend.

This example retrieves earlier sweeps for an exact spec and remote configuration:

```graphql
query PreviousSweeps($spec: String!, $remote: String!, $before: UnixMillis!) {
  sweeps(
    filter: { specName: $spec, remoteIdentity: $remote, startedBefore: $before }
    limit: 10
    offset: 0
  ) {
    total
    nodes {
      id
      parentId
      sessionId
      specRevision
      startedAt
      finishedAt
      status
      recover
      snapshotReportState
      report {
        state
        unverified
        claims { whatChanged why whatWasChecked unresolved }
        unresolved
        source { runId record capturedAt logTruncated }
      }
    }
  }
}
```

`sweep(id: ID!)` retrieves one job. `sweeps` also supports exact `jobId`, `sessionId`,
`parentId`, and `status` filters, plus `startedAfter`. Filters are combined with
AND. Omit filters to browse all builds in the local workspace; include
`remoteIdentity` when comparing work from the same remote configuration.

- `UnixMillis` is a signed 64-bit UTC Unix timestamp in milliseconds, not GraphQL's 32-bit `Int`.
- `startedAt` is backend admission time; `finishedAt` is when the backend observed terminal evidence, not the exact remote process exit time.
- Both time bounds are exclusive. Results sort by `startedAt` descending, then UUID descending. Unknown start times sort last and are excluded by time filters.
- `limit` defaults to 25 and accepts 1-100; `offset` accepts 0-10000. Offset pages are not snapshots across concurrent writes.
- `specRevision` is the submitted content's SHA-256. Continuations inherit the parent's revision rather than hashing feedback or later editor changes. Queued builds use their own frozen snapshot revision.
- `sessionId` is captured from private remote session metadata, including terminal failed/cancelled runs when available. Missing engine metadata stays null.
- `report.claims.unresolved` is the agent's account; `report.unresolved` contains machine-generated missing/truncation warnings.
- `source.retainedLog` optionally returns the captured three-line report block, or a bounded log snapshot when no report exists. Request it on an individual sweep or a small page.

Requests are limited to 64 KiB, query depth 8, and complexity 2000. Retained-log
fields have additional complexity cost. GraphQL errors appear in `errors`,
including storage failures; HTTP success alone does not mean a query succeeded.

## Capture And History

Build and continuation instructions request this exact final-response protocol,
outside Markdown code fences:

```text
SPEC_BUILD_MEMORY_V1
{"whatChanged":["Updated src/example.rs"],"why":["Fix the reported bug"],"whatWasChecked":["cargo test example: passed"],"unresolved":["Live remote validation not run"]}
END_SPEC_BUILD_MEMORY_V1
```

The JSON occupies one line, with at most 32 KiB, 64 strings per array, and 2048
UTF-8 bytes per string. Unknown properties, empty strings, or malformed blocks
are rejected. Only the final standalone opening marker is considered. Raw tool
output can also contain these markers, so even a valid report is untrusted.
Capture happens during checkpoints and authoritative remote-log recovery. Saved
spec content and completion markers are never rewritten to add reports.

Durable jobs remain in the private local `SPEC_WORKSPACE/.spec-output/<UUID>.json`.
New records include sweep metadata and captured report blocks, retaining summaries
even after the output tail changes. A coalesced background worker indexes them in
`.spec-output/memory.sqlite3`. Database failures are logged but do not block run
admission, output draining, or cancellation. Later checkpoints and history queries
retry indexing; queries reconcile changed JSON before returning results.

Existing local JSON jobs are imported automatically without rerunning them,
changing latest-run pointers, or inventing historical timestamps, session IDs, or
summaries. The importer uses inode/size/change-time fingerprints to skip unchanged
records. It limits each request to 20,000 directory entries and 64 MiB of changed
records; a byte-budget error can be retried to continue importing. Entry-count or
512 MiB database limits require operator attention rather than silent omissions.

Back up the private `.spec-output` directory, including both JSON and SQLite.
New captured reports are reconstructable from their JSON; reports imported only
from legacy output may survive solely in SQLite after those logs change. Remote
seven-day run pruning does not remove the local memory database. Do not commit
session storage or expose its contents publicly; reports and logs may contain
sensitive project information.

This does not import arbitrary standalone CLI jobs or every remote `.out` file,
modify the separately installed `spec` launcher, or automatically send GraphQL
history to the remote agent. Callers can retrieve bounded prior memory by keys
and time, reconcile it against code/tests, and supply relevant context themselves.
The existing prior-output review instructions remain active. Rebuild and restart
the backend to enable this feature; already-running remote invocations do not
retroactively receive the new reporting instructions.
