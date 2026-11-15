import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { BuildProgress, taskChecklist, taskChecklists, taskProgress } from "./progress"
import type { Output } from "./tabs"

const tasks = "# Todos\n[\u2713] Implement\n[\u2022] Verify\n[ ] Document\n\n"
const output: Output = { id: "run-a", name: "foo.md", status: "running", output: tasks, truncated: false, recoverable: true }

describe("reported build progress", () => {
  it("keeps the latest integrator and supervisor snapshots independently and combines their counts", () => {
    const integrator = tasks.replace("# Todos", "# Todos (Integrator)")
    const supervisor = "# Todos (Supervisor)\n[\u2713] Review plan\n[ ] Review integration\n\n"
    const reports = integrator + supervisor
    expect(taskChecklists(reports)).toEqual({
      Integrator: taskChecklist(tasks),
      Supervisor: [{ text: "Review plan", status: "completed" }, { text: "Review integration", status: "pending" }],
    })
    expect(taskProgress(reports)).toEqual({ completed: 2, total: 5, cancelled: 0 })
    expect(taskProgress(reports + integrator.replace("[\u2022]", "[\u2713]").replace("[ ]", "[\u2713]"))).toEqual({ completed: 4, total: 5, cancelled: 0 })
    const html = renderToStaticMarkup(<BuildProgress output={{ ...output, output: reports }} />)
    expect(html).toContain('aria-label="Integrator checklist"')
    expect(html).toContain('aria-label="Supervisor checklist"')
    expect(html).toContain('aria-valuenow="40"')
    expect(html).toContain("2 of 5 tasks reported complete")
    expect(html).toContain("Review integration: Pending")
  })

  it("does not erase the other role or report a percentage while one role's snapshot is unknown", () => {
    const reports = tasks + "# Todos (Supervisor)\n[\u2713] Review\n\n"
    for (const suffix of ["# Todos (Supervisor)\n", "# Todos (Supervisor)\n[\u2713] Partial\n", "# Todos (Supervisor)\n\n", "# Todos (Supervisor)\n[?] Invalid\n\n"]) {
      expect(taskProgress(reports + suffix)).toBeNull()
      expect(taskChecklists(reports + suffix)).toEqual({ Integrator: taskChecklist(tasks), Supervisor: null })
      const html = renderToStaticMarkup(<BuildProgress output={{ ...output, output: reports + suffix }} />)
      expect(html).not.toContain("aria-valuenow")
      expect(html).toContain("Implement: Completed")
      expect(html).toContain("Waiting for a complete supervisor task report")
    }
    expect(taskProgress("# Todos (Integrator)\n\n# Todos (Supervisor)\n\n")).toBeNull()
  })

  it("ignores fenced and quoted role snapshots as it does legacy examples", () => {
    const supervisor = "# Todos (Supervisor)\n[\u2713] Not an actual task\n\n"
    expect(taskChecklists(tasks + `\`\`\`text\n${supervisor}\`\`\`\n`)).toEqual({ Integrator: taskChecklist(tasks) })
    expect(taskChecklists(supervisor.split("\n").map(line => "> " + line).join("\n"))).toEqual({})
  })

  it("retains task text and all four statuses from the latest complete snapshot", () => {
    expect(taskChecklist(tasks + "# Todos\n[ ] Reopened\n[\u2022] Working\n[\u2713] Done\n[\u00d7] Dropped\n\n")).toEqual([
      { text: "Reopened", status: "pending" },
      { text: "Working", status: "in_progress" },
      { text: "Done", status: "completed" },
      { text: "Dropped", status: "cancelled" },
    ])
    expect(taskChecklist(tasks + "# Todos\n[\u2713] Partial\n")).toBeNull()
  })

  it("renders read-only per-item checkboxes and escapes reported task text", () => {
    const html = renderToStaticMarkup(<BuildProgress output={{ ...output, output: tasks + "# Todos\n[\u2713] <script>alert(1)</script>\n[\u00d7] Dropped\n\n" }} />)
    expect(html).toContain('aria-label="Reported build checklist"')
    expect(html).toContain('aria-checked="true" aria-disabled="true"')
    expect(html).toContain('aria-checked="false" aria-disabled="true"')
    expect(html).toContain('data-status="cancelled"')
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).not.toContain("<script>")
    expect(html).not.toContain(">Implement<")
    for (const change of [{ truncated: true }, { output: "No reported tasks" }]) {
      expect(renderToStaticMarkup(<BuildProgress output={{ ...output, ...change }} />)).not.toContain('role="checkbox"')
    }
  })

  it("counts the latest complete CLI task list and allows revised plans to decrease progress", () => {
    expect(taskProgress(tasks)).toEqual({ completed: 1, total: 3, cancelled: 0 })
    expect(taskProgress(tasks + "# Todos\n[\u2713] Implement\n[\u2713] Verify\n\n")).toEqual({ completed: 2, total: 2, cancelled: 0 })
    expect(taskProgress(tasks + "# Todos\n[ ] Reopened\n[\u00d7] Dropped\n\n")).toEqual({ completed: 0, total: 2, cancelled: 1 })
  })

  it("reads ANSI CLI output, including CRLF, without interpreting terminal payloads", () => {
    expect(taskProgress("\x1b[0m# \x1b[0mTodos\r\n[\u2713] Done\r\n[ ] Next\r\n\x1b[0m\r\n")).toEqual({ completed: 1, total: 2, cancelled: 0 })
    expect(taskProgress(`\x1b]52;c;${tasks}\x07`)).toBeNull()
  })

  it("does not count unfinished snapshots, empty lists, or unknown task markers", () => {
    for (const suffix of ["# Todos\n", "# Todos\n[\u2713] Done\n", "# Todos\n[\u2713] Done\n[", "# Todos\n\n", "# Todos\n[?] Unknown\n\n"]) {
      expect(taskProgress(tasks + suffix)).toBeNull()
    }
    expect(taskProgress(tasks.trimEnd())).toBeNull()
    expect(taskProgress("Starting...")).toBeNull()
  })

  it("ignores ordinary checkboxes, quoted/indented logs, and fenced examples", () => {
    for (const text of ["- [x] Finished\n", `\`\`\`text\n${tasks}\`\`\`\n`, `~~~~\n${tasks}~~~\n~~~~\n`, tasks.split("\n").map((line) => "    " + line).join("\n"), tasks.split("\n").map((line) => "> " + line).join("\n")]) {
      expect(taskProgress(text)).toBeNull()
    }
    expect(taskProgress(`\`\`\`\n${tasks}\`\`\`\n${tasks}`)).toEqual({ completed: 1, total: 3, cancelled: 0 })
  })

  it("renders accessible measured and indeterminate rainbow bars", () => {
    const html = renderToStaticMarkup(<BuildProgress output={output} />)
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuenow="33"')
    expect(html).toContain("1 of 3 tasks reported complete")
    expect(html).toContain("not verified spec completion")
    const unknown = renderToStaticMarkup(<BuildProgress output={{ ...output, output: "Starting..." }} />)
    expect(unknown).not.toContain("aria-valuenow")
    expect(unknown).toContain("indeterminate")
  })

  it("never infers completion from exit status and stops activity on terminal or unavailable states", () => {
    for (const status of ["completed", "cancelled", "failed (7)", "unavailable"]) {
      const html = renderToStaticMarkup(<BuildProgress output={{ ...output, status, output: "Success" }} />)
      expect(html).not.toContain("aria-valuenow")
      expect(html).not.toContain("indeterminate")
      expect(html).not.toContain("100%")
    }
    const html = renderToStaticMarkup(<BuildProgress output={{ ...output, status: "unavailable" }} />)
    expect(html).toContain("progress may be stale")
    expect(html).toContain('aria-valuenow="33"')
  })

  it("keeps reported task completion separate from successful build completion", () => {
    const running = renderToStaticMarkup(<BuildProgress output={{ ...output, output: "# Todos\n[\u2713] Done\n\n" }} />)
    expect(running).toContain('aria-valuenow="100"')
    expect(running).toContain("Build in progress.")
    expect(running).not.toContain("Build run completed.")
    const completed = renderToStaticMarkup(<BuildProgress output={{ ...output, status: "completed", recoverable: false }} />)
    expect(completed).toContain("Build run completed.")
    expect(completed).toContain('aria-valuenow="33"')
    expect(completed).toContain("1 of 3 tasks reported complete")
  })

  it("marks truncated output unknown rather than treating a partial transcript as a full plan", () => {
    const html = renderToStaticMarkup(<BuildProgress output={{ ...output, truncated: true }} />)
    expect(html).not.toContain("aria-valuenow")
    expect(html).toContain("truncated output")
  })

  it("marks transport failures stale independently of harness status without discarding counts", () => {
    for (const status of ["running", "completed", "unavailable", "failed (7)"]) {
      const stale = { ...output, status, transportUnavailable: true }
      const html = renderToStaticMarkup(<BuildProgress output={stale} />)
      expect(html).toContain("progress may be stale")
      expect(html).toContain('aria-valuenow="33"')
      expect(html).not.toContain("Build in progress")
      const unknown = renderToStaticMarkup(<BuildProgress output={{ ...stale, output: "Starting..." }} />)
      expect(unknown).not.toContain("indeterminate")
      expect(unknown).toContain('width:0%')
      expect(stale.recoverable).toBe(true)
    }
    const recovered = renderToStaticMarkup(<BuildProgress output={{ ...output, transportUnavailable: false, output: "Starting..." }} />)
    expect(recovered).toContain("indeterminate")
    expect(recovered).not.toContain("progress may be stale")
  })
})
