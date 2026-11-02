import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { RecoveryNotice } from "./recovery-notice"

describe("nohup exit-255 diagnostics", () => {
  it.each([
    "failed (exit status: 255)",
    "detached (SSH exit status: 255; remote completion unconfirmed)",
    "unavailable (SSH log recovery exited with status 255; connection refused)",
  ])("does not mistake unresolved %s for a confirmed build failure", (status) => {
    const output = { status, recoverable: true }
    const html = renderToStaticMarkup(<RecoveryNotice output={output} />)
    expect(html).toContain("remote completion is still unconfirmed")
    expect(html).toContain("SSH connectivity, authentication, and host-key verification")
    expect(html).toContain("Do not rerun the build")
    expect(output.recoverable).toBe(true)
  })

  it("preserves authoritative remote exit 255 as a real failure", () => {
    const html = renderToStaticMarkup(<RecoveryNotice output={{ status: "failed (exit status: 255)", recoverable: false }} />)
    expect(html).toContain("confirmed run failure, not a failed log download")
    expect(html).not.toContain("completion is still unconfirmed")
  })

  it.each(["running", "completed", "cancelled", "failed (exit status: 7)", "unknown (remote status unavailable)", "unavailable (connection timed out)"])("does not invent an exit-255 diagnosis for %s", (status) => {
    for (const recoverable of [true, false]) expect(renderToStaticMarkup(<RecoveryNotice output={{ status, recoverable }} />)).toBe("")
  })

  it("does not undo known completion when a subsequent log download fails", () => {
    expect(renderToStaticMarkup(<RecoveryNotice output={{ status: "unavailable (SSH log recovery exited with status 255)", recoverable: false }} />)).toBe("")
  })
})
