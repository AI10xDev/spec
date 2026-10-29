import { codeBlockClassifier } from "./code-block"

export function completionMarker(value: string, caret: number) {
  let offset = 0
  const inCodeBlock = codeBlockClassifier()
  for (const line of value.split("\n")) {
    const inCode = inCodeBlock(line)
    if (caret <= offset + line.length) {
      // Code and fence delimiters retain normal slash typing.
      if (inCode) return null
      const indent = /^[ \t]*/.exec(line)![0].length
      const start = offset + indent
      const marker = line.slice(indent)
      const length = marker.startsWith("# ") ? 2 : marker === "#" ? 1 : 0
      return { start, end: start + length, text: length ? "" : "# " }
    }
    offset += line.length + 1
  }
  return null
}
