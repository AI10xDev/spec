import { highlightLog } from "./highlighting"
import type { Output } from "./tabs"

type Counts = { completed: number; total: number; cancelled: number }

// Read only complete CLI task-list snapshots, not checkboxes in prose/code or
// a partially streamed list. These are agent reports, not verified completion.
export function taskProgress(output: string): Counts | null {
  const lines = highlightLog(output).map((token) => token.text).join("").split("\n")
  let latest: Counts | null = null
  let pending: Counts | null = null
  let fence = ""
  for (const line of lines.slice(0, -1)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = ""
      continue
    }
    if (delimiter) { fence = delimiter[1]; pending = null; continue }
    if (line.trimEnd() === "# Todos") {
      latest = null
      pending = { completed: 0, total: 0, cancelled: 0 }
    } else if (pending) {
      if (!line.trim()) {
        latest = pending.total ? pending : null
        pending = null
        continue
      }
      const task = /^\[([ \u2713\u2022\u00d7])\] \S/.exec(line)
      if (!task) { pending = null; continue }
      pending.total++
      if (task[1] === "\u2713") pending.completed++
      if (task[1] === "\u00d7") pending.cancelled++
    }
  }
  return latest
}

export function BuildProgress({ output }: { output: Output }) {
  const counts = output.truncated ? null : taskProgress(output.output)
  const percent = counts ? Math.floor(100 * counts.completed / counts.total) : undefined
  const running = output.status === "running"
  const unavailable = output.status.startsWith("unavailable")
  const state = unavailable ? "Connection unavailable; progress may be stale."
    : running ? "Build in progress."
    : output.status === "completed" ? "Build turn ended."
    : `Build ${output.status}.`
  const detail = counts
    ? `${counts.completed} of ${counts.total} tasks reported complete (${percent}%)${counts.cancelled ? `; ${counts.cancelled} cancelled` : ""}.`
    : output.truncated ? "Task counts unavailable in truncated output." : running ? "Waiting for reported task counts." : "No task counts reported."
  return <section className="build-progress" aria-label={`Build progress for ${output.name}`}>
    <div className="build-progress-label"><strong>Build progress</strong><span>{percent === undefined ? "Not measured" : `${percent}%`}</span></div>
    <div className={`build-progress-track ${running && !counts ? "indeterminate" : ""}`} role="progressbar" aria-label={`Reported task completion for ${output.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${state} ${detail}`}>
      <div className="build-progress-fill" style={{ width: counts ? `${percent}%` : running ? "35%" : "0%" }} />
    </div>
    <p aria-live="polite" aria-atomic="true">{state} {detail}</p>
    <small>Agent-reported tasks, not verified spec completion. Run: {output.id}</small>
  </section>
}
