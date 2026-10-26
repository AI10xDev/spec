import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { BuildProgress, taskProgress } from "./progress"
import type { Output } from "./tabs"

const tasks = "# Todos\n[\u2713] Implement\n[\u2022] Verify\n[ ] Document\n\n"
const output: Output = { id: "run-a", name: "foo.md", status: "running", output: tasks, truncated: false, recoverable: true }

describe("reported build progress", () => {
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

  it("marks truncated output unknown rather than treating a partial transcript as a full plan", () => {
    const html = renderToStaticMarkup(<BuildProgress output={{ ...output, truncated: true }} />)
    expect(html).not.toContain("aria-valuenow")
    expect(html).toContain("truncated output")
  })
})
