export type ResearchOutput = {
  report: { title: string; summary: string; findings: string[]; limitations: string[] }
  sources: { id: number; url: string; title: string }[]
  grounding: Record<string, number[]>
  warnings: string[]
}
export const MAX_QUERY_BYTES = 8192
export function queryError(query: string): string {
  return !query.trim() || query.includes("\0") || new TextEncoder().encode(query).length > MAX_QUERY_BYTES
    ? "Question must be nonempty, NUL-free, and at most 8 KiB of UTF-8. Nothing was sent." : ""
}
export function safeSourceUrl(raw: string): string | null {
  if (raw.length > 4096 || /[\s\u0000-\u001f\u007f\\]/u.test(raw) || !/^https?:\/\//.test(raw)) return null
  try {
    const url = new URL(raw)
    return url.hostname && !url.username && !url.password && !raw.split("/")[2].includes("@") ? url.href : null
  } catch { return null }
}
// Escape all provider text as plain Markdown text, never HTML, images or instructions.
function text(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, "\\$&").replace(/\r?\n/g, " ")
}
export function researchMarkdown(output: ResearchOutput): string {
  const cited = (field: string) => {
    const ids = (output.grounding[field] ?? []).filter((id) => output.sources.some((s) => s.id === id && safeSourceUrl(s.url)))
    return ids.length ? ` (Exa sources: ${ids.join(", ")})` : " (No usable Exa grounding)"
  }
  const lines = ["# " + text(output.report.title), cited("title"), "", "Generated research, not implementation or verified test evidence. Provider citations are not independent verification.", "", ...output.warnings.map((w) => `> ${text(w)}`), "", "## Summary", text(output.report.summary) + cited("summary"), "", "## Findings", ...output.report.findings.map((f, i) => `- ${text(f)}${cited(`findings[${i}]`)}`), "", "## Limitations", ...output.report.limitations.map((f, i) => `- ${text(f)}${cited(`limitations[${i}]`)}`), "", "## Sources", "Search results without field-level citations do not substantiate report claims."]
  for (const source of output.sources) {
    const url = safeSourceUrl(source.url)
    // Encode delimiter characters even if accepted by URL, to prevent Markdown breakout.
    if (url) lines.push(`${source.id}. [${text(source.title)}](<${url.replace(/[<>`"\\]/g, (c) => encodeURIComponent(c))}>)`)
  }
  return lines.join("\n") + "\n"
}
