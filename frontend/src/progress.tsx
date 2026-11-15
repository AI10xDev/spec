import { highlightLog } from "./highlighting"
import type { Output } from "./tabs"

type Counts = { completed: number; total: number; cancelled: number }
type Task = { text: string; status: "pending" | "in_progress" | "completed" | "cancelled" }
type Role = "Integrator" | "Supervisor"
type Checklists = Partial<Record<Role, Task[] | null>>
const roles: Role[] = ["Integrator", "Supervisor"]
const taskStates = { pending: "Pending", in_progress: "In progress", completed: "Completed", cancelled: "Cancelled" }

// Read only complete CLI task-list snapshots, not checkboxes in prose/code or
// a partially streamed list. These are agent reports, not verified completion.
export function taskChecklists(output: string): Checklists {
  const lines = highlightLog(output).map((token) => token.text).join("").split("\n")
  const latest: Checklists = {}
  let pending: { role: Role; tasks: Task[] } | null = null
  let fence = ""
  for (const line of lines.slice(0, -1)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = ""
      continue
    }
    if (delimiter) { fence = delimiter[1]; pending = null; continue }
    const heading = /^# Todos(?: \((Integrator|Supervisor)\))?$/.exec(line.trimEnd())
    if (heading) {
      // Unlabeled CLI snapshots in existing/retained logs belong to the integrator.
      const role = (heading[1] ?? "Integrator") as Role
      latest[role] = null
      pending = { role, tasks: [] }
    } else if (pending) {
      if (!line.trim()) {
        latest[pending.role] = pending.tasks.length ? pending.tasks : null
        pending = null
        continue
      }
      const task = /^\[([ \u2713\u2022\u00d7])\] (\S.*)$/.exec(line)
      if (!task) { pending = null; continue }
      pending.tasks.push({ text: task[2], status: task[1] === "\u2713" ? "completed" : task[1] === "\u2022" ? "in_progress" : task[1] === "\u00d7" ? "cancelled" : "pending" })
    }
  }
  return latest
}

function combinedTasks(checklists: Checklists): Task[] | null {
  const lists = roles.filter(role => role in checklists).map(role => checklists[role])
  return lists.length && lists.every(tasks => tasks?.length) ? lists.flatMap(tasks => tasks ?? []) : null
}

export function taskChecklist(output: string): Task[] | null {
  return combinedTasks(taskChecklists(output))
}

function countsFor(tasks: Task[] | null): Counts | null {
  return tasks ? { completed: tasks.filter((task) => task.status === "completed").length, total: tasks.length, cancelled: tasks.filter((task) => task.status === "cancelled").length } : null
}

export function taskProgress(output: string): Counts | null {
  return countsFor(taskChecklist(output))
}

export function BuildProgress({ output }: { output: Output }) {
  const checklists = output.truncated ? {} : taskChecklists(output.output)
  const counts = countsFor(combinedTasks(checklists))
  const percent = counts ? Math.floor(100 * counts.completed / counts.total) : undefined
  const unavailable = output.transportUnavailable || output.status.startsWith("unavailable")
  const running = output.status === "running" && !unavailable
  const state = unavailable ? "Connection unavailable; progress may be stale."
    : running ? "Build in progress."
    : output.status === "completed" ? "Build run completed."
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
    <div className="build-checklists">{roles.filter(role => role in checklists).map(role => {
      const tasks = checklists[role] ?? null
      const reported = countsFor(tasks)
      return <div className="build-checklist-group" role="group" aria-label={`${role} checklist`} key={role}>
        <div className="build-checklist-heading"><strong>{role}</strong><span>{reported ? `${reported.completed} of ${reported.total} complete` : "Not measured"}</span></div>
        {tasks ? <ul className="build-checklist" aria-label="Reported build checklist" aria-live="polite">
          {tasks.map((task, index) => <li key={index} data-status={task.status}>
            <span className="task-checkbox" role="checkbox" aria-checked={task.status === "completed"} aria-disabled="true" aria-label={`${task.text}: ${taskStates[task.status]}`} />
            <span className="task-text">{task.text}</span>
            <span className="task-state">{taskStates[task.status]}</span>
          </li>)}
        </ul> : <p>Waiting for a complete {role.toLowerCase()} task report.</p>}
      </div>
    })}</div>
    <small>Agent-reported tasks, not verified spec completion. Run: {output.id}</small>
  </section>
}
