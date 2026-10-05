export function completionPrefix(value: string, start: number, end = start): string {
  if (start !== end || start < 0 || start > value.length) return ""
  // Only trail a line, never overwrite or suggest through existing text.
  if (start < value.length && value[start] !== "\n") return ""
  // 4,000 UTF-16 units fit the API's 16 KiB UTF-8 limit, even with emoji.
  const prefix = value.slice(Math.max(0, start - 4000), start).replace(/^[\uDC00-\uDFFF]/, "")
  const part = prefix.split(/[\n.!?;,]/).at(-1) ?? ""
  if (!/[\p{L}\p{N}]/u.test(part)) return ""
  return prefix
}
