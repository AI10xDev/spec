import { fromMarkdown } from "mdast-util-from-markdown"
import type { Root, RootContent } from "mdast"

// This is report Markdown, not the editor's completion-marker dialect. JSON
// payloads are opaque: backticks/HTML in strings cannot quote subsequent events.
// The projection preserves source lines and indentation while reducing parser
// work for large JSONL reports. Measurements/diagnostics still use original text.
export function reportQuotedLines(lines: string[]): Uint8Array {
  const source = lines.map((line) => line.replace(/^([ \t]*)\{.*$/, "$1x")).join("\n")
  const quoted = new Uint8Array(lines.length)
  const pending: (Root | RootContent)[] = [fromMarkdown(source)]
  while (pending.length) {
    const node = pending.pop()!
    if (["code", "inlineCode", "html", "definition", "blockquote"].includes(node.type)) {
      if (node.position) quoted.fill(1, node.position.start.line - 1, node.position.end.line)
    } else if ("children" in node) {
      for (const child of node.children) pending.push(child)
    }
  }
  return quoted
}
