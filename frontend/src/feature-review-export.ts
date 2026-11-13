export type ReviewOutput = {
  report: {
    title: string
    summary: string
    features: { name: string; detail: string; sources: number[] }[]
    findings: { title: string; detail: string; strength: boolean; sources: number[] }[]
    comparison: { aspect: string; project: string; competitors: string; sources: number[] }[]
    limitations: string[]
  }
  sources: { id: number; url: string; title: string; revision: string; accessed: string }[]
  warnings: string[]
  imageDataUrl: string | null
}

const workflow = ["Review primary README", "Auto-discover competitors", "Compare pinned READMEs", "Export report"]
const evidence = ["Repository sources", "Features", "Findings", "Comparisons", "Cited review"]
const missingImage = "Image not generated. Built-in diagrams remain available."
const invalidImage = "Image omitted: expected an embedded base64 PNG; external images are never fetched."
const fontWarning = "PDF font substitution: characters outside printable ASCII were replaced with [U+XXXX] code points to avoid unsupported font glyphs. The Markdown export retains original Unicode."

function png(value: string): boolean {
  const prefix = "data:image/png;base64,"
  const maxBytes = 8 * 1024 * 1024
  const length = value.length - prefix.length
  if (!value.startsWith(prefix) || length <= 0 || length % 4 !== 0 || length > Math.ceil(maxBytes / 3) * 4) return false
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  if (length / 4 * 3 - padding > maxBytes) return false
  const end = value.length - padding
  // A repeated-group regex can exhaust the JS stack on backend-sized images.
  for (let i = prefix.length; i < end; i++) {
    const c = value.charCodeAt(i)
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47)) return false
  }
  const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(value[end - 1])
  return padding === 0 || (last & (padding === 2 ? 15 : 3)) === 0
}

function citations(ids: number[]): string {
  return ids.length ? ids.map(id => `[${id}]`).join(" ") : "No source cited"
}

// Escape before interpolation, including GFM bare-URL/email autolinks and table delimiters.
function literal(text: string): string {
  return text.replace(/\s+/g, " ").trim()
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*{}\[\]()#+.!_~\-]/g, "\\$&")
    .replace(/\|/g, "&#124;").replace(/:/g, "&#58;").replace(/@/g, "&#64;")
}

function code(text: string): string {
  const value = text.replace(/\s+/g, " ")
  const fence = "`".repeat(Math.max(0, ...(value.match(/`+/g) ?? []).map(run => run.length)) + 1)
  return `${fence} ${value} ${fence}`
}

export function markdown(output: ReviewOutput): string {
  const { report, sources, warnings, imageDataUrl } = output
  const items = (values: string[]) => values.length ? values.map(value => `- ${literal(value)}`).join("\n") : "None reported."
  const findings = (strengths: boolean) => {
    const rows = report.findings.filter(row => !strengths || row.strength)
    return rows.length ? rows.map(row => `### ${literal(row.title)}\n\n${literal(row.detail)}\n\n${row.strength ? "Key strength. " : ""}Sources: ${citations(row.sources)}`).join("\n\n") : "None reported."
  }
  return [
    `# ${literal(report.title)}`,
    `Exported: ${new Date().toISOString()}`,
    "## Concise Summary", literal(report.summary),
    "## Features",
    report.features.length ? report.features.map(row => `### ${literal(row.name)}\n\n${literal(row.detail)}\n\nSources: ${citations(row.sources)}`).join("\n\n") : "None reported.",
    "## Findings", findings(false),
    "## Key Strengths", findings(true),
    "## Comparisons",
    "| Aspect | Project | Competitors | Sources |\n| --- | --- | --- | --- |\n" +
      (report.comparison.length ? report.comparison.map(row => `| ${literal(row.aspect)} | ${literal(row.project)} | ${literal(row.competitors)} | ${citations(row.sources)} |`).join("\n") : "| None reported | | | |"),
    "## Limitations", items(report.limitations),
    "## Warnings", items(warnings),
    "## Workflow", "Fixed review workflow, not an assertion of executed tests.",
    `\`\`\`mermaid\nflowchart LR\n${workflow.map((label, i) => `  W${i}["${label}"]`).join("\n")}\n  W0 --> W1 --> W2 --> W3\n\`\`\``,
    "## Evidence Diagram", "Conceptual evidence flow; numbered citations identify the actual sources for each claim.",
    `\`\`\`mermaid\nflowchart TD\n${evidence.map((label, i) => `  E${i}["${label}"]`).join("\n")}\n  E0 --> E1\n  E0 --> E2\n  E0 --> E3\n  E1 --> E4\n  E2 --> E4\n  E3 --> E4\n\`\`\``,
    "## Workflow Illustration",
    imageDataUrl && png(imageDataUrl)
      ? `AI-generated Azure workflow illustration; illustrative, not evidence.\n\n![AI-generated workflow illustration](${imageDataUrl})`
      : imageDataUrl ? invalidImage : missingImage,
    "## Sources",
    sources.length ? sources.map(source => `### [${source.id}] ${literal(source.title)}\n\nURL: ${code(source.url)}\n\nCommit / revision: ${code(source.revision)}\n\nAccessed: ${code(source.accessed)}`).join("\n\n") : "None reported.",
  ].join("\n\n") + "\n"
}

export async function pdf(output: ReviewOutput): Promise<Blob> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")])
  const doc = new jsPDF({ unit: "mm", format: "a4" })
  const { report, sources, imageDataUrl } = output
  const warnings = [...output.warnings]
  const unsupported = /[^\x20-\x7e\n\r\t]/u
  // ASCII is a deliberately conservative subset of the built-in Helvetica font.
  const text = (value: string) => Array.from(value.replace(/\r\n?/g, "\n").replace(/\t/g, "    "))
    .map(char => unsupported.test(char) ? `[U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]` : char).join("")
  let substitution = false
  JSON.stringify({ report, sources, warnings }, (_key, value) => {
    if (typeof value === "string" && unsupported.test(value)) substitution = true
    return value
  })
  if (substitution) warnings.unshift(fontWarning)
  const margin = 16
  const width = doc.internal.pageSize.getWidth() - margin * 2
  const bottom = doc.internal.pageSize.getHeight() - 20
  let y = margin
  const space = (height: number) => {
    if (y + height > bottom) {
      doc.addPage()
      y = margin
    }
  }
  const paragraph = (value: string, size = 10, bold = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal")
    doc.setFontSize(size)
    doc.setTextColor(35, 48, 65)
    const lines: string[] = doc.splitTextToSize(text(value), width)
    const height = size * 0.3528 * 1.4
    for (const line of lines) {
      space(height)
      doc.text(line, margin, y + height * 0.78)
      y += height
    }
    y += 3
  }
  const heading = (value: string) => {
    space(22)
    y += 3
    paragraph(value, 14, true)
  }
  const table = (headers: string[], rows: string[][], widths?: number[]) => {
    if (!rows.length) {
      paragraph("None reported.")
      return
    }
    space(20)
    autoTable(doc, {
      startY: y,
      margin: { top: margin, bottom: 20, left: margin, right: margin },
      tableWidth: width,
      head: [headers], body: rows.map(row => row.map(text)),
      theme: "striped", showHead: "everyPage", pageBreak: "auto", rowPageBreak: "auto",
      styles: { font: "helvetica", fontSize: 9, cellPadding: 2.5, overflow: "linebreak", valign: "top" },
      headStyles: { fillColor: [27, 59, 83], textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [242, 246, 249] },
      columnStyles: widths ? Object.fromEntries(widths.map((cellWidth, index) => [index, { cellWidth }])) : {},
      didDrawPage: data => { y = data.cursor?.y ?? margin },
    })
    y += 5
  }

  doc.setProperties({ title: text(report.title), subject: "Feature review", creator: "Spec feature review" })
  paragraph("FEATURE REVIEW", 10, true)
  paragraph(report.title, 24, true)
  paragraph(`Exported ${new Date().toISOString()} | Research report`, 9)
  if (warnings.includes(fontWarning)) paragraph(fontWarning, 9)
  heading("Concise Summary")
  paragraph(report.summary)
  heading("Features")
  table(["Feature", "Detail", "Sources"], report.features.map(row => [row.name, row.detail, citations(row.sources)]), [38, 113, 27])
  heading("Findings")
  table(["Finding", "Detail", "Assessment", "Sources"], report.findings.map(row => [row.title, row.detail, row.strength ? "Key strength" : "Finding", citations(row.sources)]), [34, 89, 28, 27])
  heading("Key Strengths")
  table(["Strength", "Detail", "Sources"], report.findings.filter(row => row.strength).map(row => [row.title, row.detail, citations(row.sources)]), [38, 113, 27])
  heading("Comparisons")
  table(["Aspect", "Project", "Competitors", "Sources"], report.comparison.map(row => [row.aspect, row.project, row.competitors, citations(row.sources)]), [31, 60, 60, 27])
  heading("Limitations")
  for (const value of report.limitations.length ? report.limitations : ["None reported."]) paragraph(`- ${value}`)

  // Fixed labels and vector geometry cannot execute model-supplied Mermaid or HTML.
  const diagram = (kind: "workflow" | "evidence") => {
    space(kind === "workflow" ? 55 : 91)
    heading(kind === "workflow" ? "Workflow" : "Evidence Diagram")
    const top = y
    const box = (label: string, x: number, yy: number, w: number) => {
      doc.setFillColor(235, 243, 249)
      doc.setDrawColor(55, 94, 122)
      doc.roundedRect(x, yy, w, 14, 2, 2, "FD")
      doc.setFont("helvetica", "normal")
      doc.setFontSize(8)
      doc.setTextColor(27, 59, 83)
      doc.text(label, x + w / 2, yy + 8, { align: "center" })
    }
    const arrow = (x1: number, y1: number, x2: number, y2: number) => {
      doc.setDrawColor(55, 94, 122)
      doc.line(x1, y1, x2, y2)
      const angle = Math.atan2(y2 - y1, x2 - x1)
      for (const delta of [-0.45, 0.45]) doc.line(x2, y2, x2 - 2 * Math.cos(angle + delta), y2 - 2 * Math.sin(angle + delta))
    }
    if (kind === "workflow") {
      workflow.forEach((label, i) => {
        const x = margin + i * 46
        box(label, x, top, 40)
        if (i < 3) arrow(x + 40, top + 7, x + 46, top + 7)
      })
      y += 19
      paragraph("Fixed review workflow; does not imply code execution or testing.", 8)
    } else {
      box(evidence[0], margin + 64, top, 50)
      box(evidence[4], margin + 64, top + 50, 50)
      evidence.slice(1, 4).forEach((label, i) => {
        const x = margin + i * 64
        box(label, x, top + 25, 50)
        arrow(margin + 89, top + 14, x + 25, top + 25)
        arrow(x + 25, top + 39, margin + 89, top + 50)
      })
      y += 69
      paragraph("Conceptual flow. See numbered citations and source revisions for actual evidence.", 8)
    }
  }
  diagram("workflow")
  diagram("evidence")
  heading("Workflow Illustration")
  if (!imageDataUrl) paragraph(missingImage)
  else if (!png(imageDataUrl)) {
    warnings.push(invalidImage)
    paragraph(invalidImage)
  } else {
    try {
      const image = doc.getImageProperties(imageDataUrl)
      const scale = Math.min(width / image.width, 120 / image.height)
      const w = image.width * scale
      const h = image.height * scale
      space(h + 16)
      doc.addImage(imageDataUrl, "PNG", margin + (width - w) / 2, y, w, h)
      y += h + 3
      paragraph("AI-generated Azure workflow illustration; illustrative, not evidence.", 8)
    } catch {
      const warning = "Image omitted: embedded PNG could not be decoded. Report text and diagrams are preserved."
      warnings.push(warning)
      paragraph(warning)
    }
  }
  heading("Sources")
  table(["Source", "URL / commit / access time"], sources.map(source => [
    `[${source.id}] ${source.title}`,
    `URL: ${source.url}\nCommit / revision: ${source.revision}\nAccessed: ${source.accessed}`,
  ]), [43, 135])
  heading("Warnings")
  for (const value of warnings.length ? warnings : ["None reported."]) paragraph(`- ${value}`)

  const count = doc.getNumberOfPages()
  for (let page = 1; page <= count; page++) {
    doc.setPage(page)
    doc.setDrawColor(205, 216, 224)
    doc.line(margin, bottom + 5, margin + width, bottom + 5)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    doc.setTextColor(90, 105, 120)
    doc.text("FEATURE REVIEW", margin, bottom + 11)
    doc.text(`Page ${page} of ${count}`, margin + width, bottom + 11, { align: "right" })
  }
  return doc.output("blob")
}
