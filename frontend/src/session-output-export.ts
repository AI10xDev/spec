import type { Output } from "./tabs"
import { normalizeTerminal } from "./terminal"

export async function sessionOutputPdf(output: Output): Promise<Blob> {
  const exported = new Date().toISOString()
  const { jsPDF } = await import("jspdf")
  const doc = new jsPDF({ unit: "mm", format: "a4" })
  const clean = (value: string) => normalizeTerminal(value.replace(/\r\n?/g, "\n")).replace(/\t/g, "    ")
  const values = [output.name, output.id, output.status, output.output].map(clean)
  // Built-in PDF fonts cannot represent all CLI glyphs; make substitutions explicit.
  const unsupported = /[^\x20-\x7e\n]/u
  const text = (value: string) => Array.from(value).map(char => unsupported.test(char)
    ? `[U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]` : char).join("")
  const [name, id, status, logs] = values.map(text)
  const margin = 16
  const width = doc.internal.pageSize.getWidth() - margin * 2
  const bottom = doc.internal.pageSize.getHeight() - 20
  let y = margin
  const paragraph = (value: string, size = 10, font = "helvetica") => {
    doc.setFont(font, "normal")
    doc.setFontSize(size)
    const height = size * 0.3528 * 1.4
    // Split each source line separately to retain blank lines and log indentation.
    for (const source of value.split("\n")) {
      const lines: string[] = doc.splitTextToSize(source, width)
      for (const line of lines.length ? lines : [""]) {
        if (y + height > bottom) { doc.addPage(); y = margin }
        doc.text(line, margin, y + height * 0.78)
        y += height
      }
    }
    y += 3
  }

  doc.setProperties({ title: `${name} - session output`, subject: "Available session output snapshot", creator: "Spec" })
  paragraph("SPEC / SESSION OUTPUT", 18)
  paragraph(`Spec: ${name}`)
  paragraph(`Run: ${id}`)
  paragraph(`Harness status: ${status}`)
  paragraph(`Exported: ${exported}`, 9)
  paragraph("Snapshot of available output only. Later output and unsent follow-ups are not included. CLI success alone does not verify saved changes.", 9)
  if (output.recoverable) paragraph("Completion is not confirmed; this session may still be running.", 9)
  if (output.transportUnavailable) paragraph("Connection unavailable: this snapshot contains the last received output; status may be stale.", 9)
  if (output.truncated) paragraph("Older output was truncated. This PDF includes only the available log tail, not the full session.", 9)
  if (values.some(value => unsupported.test(value))) paragraph("PDF font substitution: characters outside printable ASCII appear as [U+XXXX] code points instead of unsupported glyphs.", 9)
  paragraph("Output & logs", 12)
  paragraph(logs || "No output received.", 9, "courier")

  const pages = doc.getNumberOfPages()
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    doc.setDrawColor(205, 216, 224)
    doc.line(margin, bottom + 5, margin + width, bottom + 5)
    doc.text("SPEC / SESSION OUTPUT", margin, bottom + 11)
    doc.text(`Page ${page} of ${pages}`, margin + width, bottom + 11, { align: "right" })
  }
  return doc.output("blob")
}
