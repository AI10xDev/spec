import { describe, expect, it } from "vitest"
import type { Output } from "./tabs"
import { sessionOutputPdf } from "./session-output-export"

const fixture = (overrides: Partial<Output> = {}): Output => ({
  name: "example.md", id: "run-123", status: "completed", output: "First line\n    indented\n\nLast line",
  truncated: false, recoverable: false, ...overrides,
})

async function pdfText(output: Output) {
  const blob = await sessionOutputPdf(output)
  expect(blob.type).toBe("application/pdf")
  const content = Buffer.from(await blob.arrayBuffer()).toString("latin1")
  expect(content.startsWith("%PDF-")).toBe(true)
  return content
}

describe("session output PDF", () => {
  it("exports session metadata and logs without modifying the snapshot", async () => {
    const output = Object.freeze(fixture())
    const content = await pdfText(output)
    for (const value of ["Spec: example.md", "Run: run-123", "Harness status: completed", "Exported:", "First line", "    indented", "Last line", "Page 1 of 1"]) expect(content).toContain(value)
    expect(content).not.toContain("Older output was truncated")
    expect(content).not.toContain("Completion is not confirmed")
    expect(content).not.toContain("PDF font substitution")
  })

  it("labels incomplete, truncated and stale snapshots", async () => {
    const content = await pdfText(fixture({ status: "running", recoverable: true, transportUnavailable: true, truncated: true }))
    for (const value of ["Harness status: running", "Completion is not confirmed", "Connection unavailable", "Older output was truncated", "First line"]) expect(content).toContain(value)
  })

  it("strips terminal payloads and keeps HTML and links inert", async () => {
    const content = await pdfText(fixture({ output: '\x1b[31mRed\x1b[0m\r\n\x1b]0;hidden-title\x07<img src="https://example.test/image">\n\x1b]8;;https://hidden.test\x07link\x1b]8;;\x07' }))
    expect(content).toContain("Red")
    expect(content).toContain('<img src="https://example.test/image">')
    expect(content).toContain("link")
    for (const value of ["hidden-title", "https://hidden.test", "[31m", "/Subtype /Link", "/Subtype /Image", "/JavaScript"]) expect(content).not.toContain(value)
  })

  it("explicitly substitutes unsupported Unicode in logs and metadata", async () => {
    const content = await pdfText(fixture({ name: "caf\u00e9.md", output: "\u2713 \ud83d\ude80 \u4e16\u754c" }))
    for (const value of ["PDF font substitution", "caf[U+00E9].md", "[U+2713]", "[U+1F680]", "[U+4E16]", "[U+754C]"]) expect(content).toContain(value)
  })

  it("wraps long lines and paginates the available 256 KiB log without losing its end", async () => {
    const content = await pdfText(fixture({ output: "x".repeat(8192) + "\n" + "Long log line\n".repeat(19000) + "LOG-END" }))
    const pages = content.match(/\/Type \/Page\b/g)?.length ?? 0
    expect(pages).toBeGreaterThan(10)
    expect(content).toContain("LOG-END")
    for (let page = 1; page <= pages; page++) expect(content).toContain(`Page ${page} of ${pages}`)
    const logLines = [...content.matchAll(/\((x+)\) Tj/g)].map(match => match[1])
    expect(logLines.join("")).toBe("x".repeat(8192))
    expect(Math.max(...logLines.map(line => line.length))).toBeLessThan(100)
  }, 20000)

  it("handles empty output explicitly", async () => {
    expect(await pdfText(fixture({ output: "" }))).toContain("No output received.")
  })
})
