import { describe, expect, it } from "vitest"
import { fromMarkdown } from "mdast-util-from-markdown"
import { markdown, pdf, type ReviewOutput } from "./feature-review-export"

const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4XmNQCKj4f+LOh/8AE5cFe63xRWwAAAAASUVORK5CYII="

function largePng() {
  const tiny = Buffer.from(image.split(",")[1], "base64")
  // Insert a private ancillary chunk before IEND without changing the tiny pixel data.
  const chunk = Buffer.alloc(8 * 1024 * 1024 - tiny.length)
  chunk.writeUInt32BE(chunk.length - 12, 0)
  chunk.write("raNd", 4, "ascii")
  let crc = 0xffffffff
  for (let i = 4; i < chunk.length - 4; i++) {
    crc ^= chunk[i]
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return "data:image/png;base64," + Buffer.concat([tiny.subarray(0, -12), chunk, tiny.subarray(-12)]).toString("base64")
}

const bigImage = largePng()
const fixture = (): ReviewOutput => ({
  report: {
    title: "Repository feature review",
    summary: "A concise research summary.",
    features: [{ name: "Editor", detail: "Documented editing workflow.", sources: [1] }],
    findings: [
      { title: "Traceability", detail: "Evidence is tied to commits.", strength: true, sources: [1, 2] },
      { title: "Coverage gap", detail: "Runtime behavior was not tested.", strength: false, sources: [] },
    ],
    comparison: [{ aspect: "Editing", project: "Integrated", competitors: "Separate", sources: [1, 2] }],
    limitations: ["Documentation review only."],
  },
  sources: [
    { id: 1, url: "https://github.com/example/project", title: "Project README", revision: "abc123def", accessed: "2026-11-07T12:00:00Z" },
    { id: 2, url: "https://github.com/example/competitor", title: "Competitor README", revision: "fed987cba", accessed: "2026-11-07T12:01:00Z" },
  ],
  warnings: ["Comparison based on public documentation.", "Discovery is limited to GitHub search results.", "Selected example/competitor for its documented editing workflow.", "Search URL: https://github.com/search?q=editor&type=repositories"],
  imageDataUrl: null,
})

function nodes(content: string) {
  const result: { type: string; value?: string; url?: string }[] = []
  const visit = (node: ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>["children"][number]) => {
    result.push(node)
    if ("children" in node) for (const child of node.children) visit(child as Parameters<typeof visit>[0])
  }
  visit(fromMarkdown(content))
  return result
}

async function pdfText(output: ReviewOutput) {
  const blob = await pdf(output)
  expect(blob).toBeInstanceOf(Blob)
  expect(blob.type).toBe("application/pdf")
  return Buffer.from(await blob.arrayBuffer()).toString("latin1")
}

describe("feature review Markdown export", () => {
  it("includes every section, citations, source provenance and fixed diagrams", () => {
    const output = fixture()
    const content = markdown(output)
    for (const section of ["Concise Summary", "Features", "Findings", "Key Strengths", "Comparisons", "Limitations", "Warnings", "Sources", "Workflow", "Evidence Diagram"]) {
      expect(content).toContain(`## ${section}`)
    }
    const rendered = nodes(content).map(node => node.value ?? "").join(" ")
    for (const value of [output.report.title, output.report.summary, "Documented editing workflow.", "Runtime behavior was not tested.", ...output.report.limitations, ...output.warnings]) expect(rendered).toContain(value)
    for (const source of output.sources) {
      for (const value of [source.url, source.revision, source.accessed, source.title]) expect(rendered).toContain(value)
    }
    expect(content).toContain("Sources: [1] [2]")
    expect(content).toContain("| Editing | Integrated | Separate | [1] [2] |")
    expect(content.match(/```mermaid/g)).toHaveLength(2)
    expect(nodes(content).find(node => node.type === "code")?.value).toBe('flowchart LR\n  W0["Review primary README"]\n  W1["Auto-discover competitors"]\n  W2["Compare pinned READMEs"]\n  W3["Export report"]\n  W0 --> W1 --> W2 --> W3')
    expect(content).toContain("Image not generated")
    expect(nodes(content).filter(node => node.type === "image")).toHaveLength(0)
  })

  it("keeps HTML, Markdown, autolinks, table breaks and diagram injection inert in all fields", () => {
    const attack = '<img src="https://evil.test/pixel"> ![x](https://evil.test/image) [x](javascript:alert(1)) <https://evil.test> https://evil.test user@evil.test &lt;svg&gt; |\n# injected\n```mermaid\nclick E0 "https://evil.test"\n```'
    const output = fixture()
    output.report.title = output.report.summary = attack
    output.report.features = [{ name: attack, detail: attack, sources: [1] }]
    output.report.findings = [{ title: attack, detail: attack, strength: true, sources: [1] }]
    output.report.comparison = [{ aspect: attack, project: attack, competitors: attack, sources: [1] }]
    output.report.limitations = output.warnings = [attack]
    output.sources = [{ id: 1, title: attack, url: attack, revision: attack, accessed: attack }]
    const content = markdown(output)
    const parsed = nodes(content)
    expect(parsed.filter(node => ["html", "image", "link", "definition", "imageReference", "linkReference"].includes(node.type))).toEqual([])
    const diagrams = parsed.filter(node => node.type === "code")
    expect(diagrams).toHaveLength(2)
    expect(diagrams.every(node => !node.value?.includes("evil.test"))).toBe(true)
    expect(content).toContain("&#124;")
    expect(content).toContain("https&#58;//evil")
    expect(content).not.toContain("\n# injected")
  })

  it("embeds only the supplied PNG directly without sidecar files", () => {
    const content = markdown({ ...fixture(), imageDataUrl: image })
    expect(content).toContain(image)
    expect(content).not.toContain("Image not generated")
    expect(nodes(content).filter(node => node.type === "image")).toEqual([expect.objectContaining({ url: image })])
  })

  it("embeds a valid 8 MiB PNG without overflowing the validator stack", () => {
    const content = markdown({ ...fixture(), imageDataUrl: bigImage })
    expect(content).toContain(`![AI-generated workflow illustration](${bigImage})`)
    expect(content).toContain("A concise research summary")
    expect(content).toContain("abc123def")
    expect(content).not.toContain("Image omitted")
  })

  it.each(["https://evil.test/pixel.png", "data:image/svg+xml,<svg onload=alert(1)>", "data:image/png;base64,AAAA)\n![bad](https://evil.test)"])("rejects unsafe image input %s", imageDataUrl => {
    const content = markdown({ ...fixture(), imageDataUrl })
    expect(content).toContain("Image omitted")
    expect(nodes(content).filter(node => ["image", "html", "link"].includes(node.type))).toEqual([])
  })

  it("preserves Unicode in Markdown and handles empty collections", () => {
    const output = fixture()
    output.report.summary = "Caf\u00e9 \u4e16\u754c \ud83d\ude80"
    output.report.features = []
    output.report.findings = []
    output.report.comparison = []
    output.report.limitations = []
    output.sources = []
    output.warnings = []
    const content = markdown(output)
    expect(content).toContain(output.report.summary)
    expect(content).toContain("None reported.")
  })
})

describe("feature review PDF export", () => {
  it("generates a real PDF with all report sections, provenance and vector diagrams", async () => {
    const output = fixture()
    const content = await pdfText(output)
    expect(content.startsWith("%PDF-")).toBe(true)
    for (const value of ["Repository feature review", "A concise research summary.", "Concise Summary", "Features", "Findings", "Key Strengths", "Comparisons", "Limitations", "Warnings", "Sources", "[1] [2]", "abc123def", "2026-11-07T12:00:00Z", "https://github.com/example/project", ...output.warnings, "Image not generated", "Review primary README", "Auto-discover competitors", "Compare pinned READMEs", "Export report", "Repository sources", "Cited review"]) expect(content).toContain(value)
    expect(content).not.toContain("PDF font substitution")
    expect(content).toMatch(/\d+(?:\.\d+)? \d+(?:\.\d+)? m\n/)
    const pages = content.match(/\/Type \/Page\b/g)?.length ?? 0
    expect(pages).toBeGreaterThan(0)
    for (let page = 1; page <= pages; page++) expect(content).toContain(`Page ${page} of ${pages}`)
  })

  it("embeds the Azure PNG as an image object", async () => {
    const content = await pdfText({ ...fixture(), imageDataUrl: image })
    expect(content).toContain("/Subtype /Image")
    expect(content).toContain("AI-generated Azure workflow illustration")
    expect(content).not.toContain("Image omitted")
  })

  it("embeds a valid 8 MiB PNG without overflowing the validator stack", async () => {
    const content = await pdfText({ ...fixture(), imageDataUrl: bigImage })
    expect(content).toContain("/Subtype /Image")
    expect(content).toContain("AI-generated Azure workflow illustration")
    expect(content).toContain("A concise research summary.")
    expect(content).toContain("abc123def")
    expect(content).not.toContain("Image omitted")
  })

  it.each(["https://evil.test/pixel.png", "data:image/png;base64,AAAA"])("preserves the report and warns for unusable image %s", async imageDataUrl => {
    const content = await pdfText({ ...fixture(), imageDataUrl })
    expect(content).toContain("Image omitted")
    expect(content).toContain("A concise research summary.")
    expect(content).toContain("abc123def")
    expect(content).not.toContain("/Subtype /Image")
  })

  it("preserves the report when a multi-megabyte image cannot be decoded", async () => {
    const content = await pdfText({ ...fixture(), imageDataUrl: "data:image/png;base64," + "AAAA".repeat(2 * 1024 * 1024) })
    expect(content).toContain("embedded PNG could not be decoded")
    expect(content).toContain("A concise research summary.")
    expect(content).toContain("abc123def")
    expect(content).not.toContain("/Subtype /Image")
  })

  it("explicitly substitutes unsupported characters in every report area", async () => {
    const output = fixture()
    output.report.title = "Caf\u00e9 \u4e16\u754c \ud83d\ude80"
    output.report.features[0].detail = "Feature \u03b1"
    output.sources[0].revision = "revision \u03b2"
    output.warnings.push("Warning \u03b3")
    const content = await pdfText(output)
    for (const value of ["PDF font substitution", "[U+00E9]", "[U+4E16]", "[U+754C]", "[U+1F680]", "[U+03B1]", "[U+03B2]", "[U+03B3]"]) expect(content).toContain(value)
    expect(output.warnings).not.toContain(expect.stringContaining("PDF font substitution"))
  })

  it("wraps and paginates oversized paragraphs and cells without losing their ends", async () => {
    const output = fixture()
    output.report.title = "Long title ".repeat(180) + "TITLE-END"
    output.report.summary = "Long summary text. ".repeat(900) + "SUMMARY-END"
    output.report.features[0].detail = "Long feature detail. ".repeat(1600) + "FEATURE-END"
    output.report.comparison[0].project = "Project description. ".repeat(900) + "PROJECT-END"
    output.report.comparison[0].competitors = "Competitor description. ".repeat(1000) + "COMPETITOR-END"
    output.sources[0].url += "/" + "unbroken".repeat(300) + " URL-END"
    output.warnings.push("Long warning. ".repeat(900) + "WARNING-END")
    const content = await pdfText(output)
    const pages = content.match(/\/Type \/Page\b/g)?.length ?? 0
    expect(pages).toBeGreaterThan(10)
    for (const value of ["TITLE-END", "SUMMARY-END", "FEATURE-END", "PROJECT-END", "COMPETITOR-END", "URL-END", "WARNING-END"]) expect(content).toContain(value)
    expect(content.match(/\(Feature\) Tj/g)!.length).toBeGreaterThan(1)
    expect(content.match(/\(Competitors\) Tj/g)!.length).toBeGreaterThan(1)
    for (let page = 1; page <= pages; page++) expect(content).toContain(`Page ${page} of ${pages}`)
  }, 20000)

  it("warns even when the only unsupported character is a control character", async () => {
    const output = fixture()
    output.report.summary = "Unexpected \u0001 control"
    const content = await pdfText(output)
    expect(content).toContain("PDF font substitution")
    expect(content).toContain("Unexpected [U+0001] control")
  })
})

describe("feature review image validation", () => {
  it.each(["", "A", "AAA", "====", "=AAA", "A=AA", "AA=A", "A===", "AAAA=", "AB==", "AAB=", "AAA\n", "AAA ", "AAA)", "AAA_", "AAA-", "AAA\u00e9"])("preserves both reports for invalid base64 %j", async encoded => {
    const output = { ...fixture(), imageDataUrl: "data:image/png;base64," + encoded }
    for (const content of [markdown(output), await pdfText(output)]) {
      expect(content).toContain("Image omitted")
      expect(content).toContain("A concise research summary")
      expect(content).toContain("abc123def")
      expect(content).not.toContain("![AI-generated workflow illustration]")
      expect(content).not.toContain("/Subtype /Image")
    }
  })

  it.each([1, 3])("rejects images %i bytes over the 8 MiB limit without losing either report", async extra => {
    const imageDataUrl = "data:image/png;base64," + Buffer.alloc(8 * 1024 * 1024 + extra).toString("base64")
    const output = { ...fixture(), imageDataUrl }
    for (const content of [markdown(output), await pdfText(output)]) {
      expect(content).toContain("Image omitted")
      expect(content).toContain("A concise research summary")
      expect(content).toContain("abc123def")
      expect(content).not.toContain(imageDataUrl)
      expect(content).not.toContain("/Subtype /Image")
    }
  })
})
