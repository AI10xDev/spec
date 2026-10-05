export function completionMarker(value: string, caret: number) {
  let offset = 0
  let fence = ""
  for (const line of value.split("\n")) {
    const inCode = !!fence
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (match) {
      if (fence) {
        if (match[1][0] === fence[0] && match[1].length >= fence.length && /^[ \t]*$/.test(match[2])) fence = ""
      } else if (match[1][0] !== "`" || !match[2].includes("`")) {
        fence = match[1]
      }
    }
    if (caret <= offset + line.length) {
      // Both fence delimiters and their contents retain normal slash typing.
      if (inCode || fence) return null
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
