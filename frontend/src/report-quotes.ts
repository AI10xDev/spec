import { fromMarkdown } from "mdast-util-from-markdown"
import type { Root, RootContent } from "mdast"

// This is report Markdown, not the editor's completion-marker dialect. JSON
// payloads are opaque: backticks/HTML in strings cannot quote subsequent events.
// The projection preserves source lines and indentation while reducing parser
// work for large JSONL reports. Measurements/diagnostics still use original text.
export function reportQuotedLines(lines: string[]): Uint8Array {
  const quoted = new Uint8Array(lines.length)
  // Plain JSONL has no Markdown context. Avoid building a large paragraph AST.
  if (lines.every((line) => /^(?: {0,3}\{|[ \t]*$)/.test(line))) return quoted
  const source = lines.map((line) => line
    .replace(/^([ \t]*)\{.*$/, "$1x")
    // A quoted JSON record is atomic, unlike prose with lazy continuation.
    .replace(/^((?: {0,3}>[ \t]?)+[ \t]*)\{.*$/, "$1---")).join("\n")
  const pending: (Root | RootContent)[] = [fromMarkdown(source)]
  while (pending.length) {
    const node = pending.pop()!
    if (["code", "inlineCode", "html", "definition", "blockquote"].includes(node.type)) {
      if (node.position) {
        quoted.fill(1, node.position.start.line - 1, node.position.end.line)
        // Report examples indented after a definition are not measurements,
        // even though CommonMark permits them to start a paragraph.
        if (node.type === "definition") {
          for (let i = node.position.end.line; i < lines.length && /^(?: {4}| {0,3}\t|[ \t]*$)/.test(lines[i]); i++) quoted[i] = 1
        }
      }
    } else if ("children" in node) {
      for (const child of node.children) pending.push(child)
    }
  }
  return quoted
}
