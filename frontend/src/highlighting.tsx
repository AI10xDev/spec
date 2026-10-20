import type { CSSProperties } from "react"

type SpecToken = { text: string; kind?: string }
type SpecLine = { tokens: SpecToken[]; kind?: string }

// A source highlighter, not a Markdown renderer: delimiters and whitespace stay intact.
export function highlightSpec(value: string): SpecLine[] {
  let fence = ""
  let indented = false
  let previousBlank = true
  let inlineBudget = 4000
  return value.split("\n").map((text) => {
    const blank = !text.trim()
    const codeIndent = /^(?: {4}| {0,3}\t)/.test(text)
    const inIndentedCode = !fence && ((codeIndent && (previousBlank || indented)) || (blank && indented))
    previousBlank = blank
    indented = inIndentedCode
    if (inIndentedCode) return { tokens: [{ text }], kind: "code" }
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)\r?$/.exec(text)
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && /^[ \t\r]*$/.test(delimiter[2])) fence = ""
      return { tokens: [{ text }], kind: "code" }
    }
    if (delimiter && (delimiter[1][0] !== "`" || !delimiter[2].includes("`"))) {
      fence = delimiter[1]
      return { tokens: [{ text }], kind: "code" }
    }
    if (/^[ \t]*#(?: |\r?$)/.test(text)) return { tokens: [{ text }], kind: "completed" }
    const kind = /^[ \t]*#{2,6}(?:[ \t]|\r?$)/.test(text) ? "heading" : undefined
    // Bound inline regex work on generated/minified lines; keep their text intact.
    if (text.length > 1024) return { tokens: [{ text }], kind }
    const tokens: SpecToken[] = []
    const inline = /\\[^\r\n]|(`+)([^`]|`(?!\1))*?\1(?!`)|!?\[[^\[\]\r\n]*\]\([^\)\r\n]*\)|\*\*[^*\r\n]+\*\*|__[^_\r\n]+__|\*[^*\r\n]+\*|_[^_\r\n]+_|~~[^~\r\n]+~~|^[ \t]*(?:[-+*]|\d+[.)])(?=[ \t])/g
    let offset = 0
    for (const match of text.matchAll(inline)) {
      if (--inlineBudget < 0) break
      const start = match.index!
      if (start > offset) tokens.push({ text: text.slice(offset, start) })
      const token = match[0]
      const tokenKind = token.startsWith("\\") ? undefined : token.startsWith("`") ? "code" : /^!?\[/.test(token) ? "link" : /^[ \t]*(?:[-+*]|\d+[.)])$/.test(token) ? "list" : "emphasis"
      tokens.push({ text: token, kind: tokenKind })
      offset = start + token.length
    }
    if (offset < text.length) tokens.push({ text: text.slice(offset) })
    return { tokens, kind }
  })
}

const ansiColors = ["#909299", "#ffb4c4", "#88d781", "#ffd18e", "#8ebcff", "#b59aff", "#80d5dc", "#bdc8dc", "#a7a9ae", "#ffc4d0", "#a4ed9d", "#ffe4b0", "#b0d1ff", "#d0baff", "#a4edf0", "#f4f7f5"]
type LogToken = { text: string; style: CSSProperties }

// Only SGR styling is interpreted. OSC/DCS payloads and cursor/erase commands are
// discarded rather than replayed, so logs cannot rewrite text or create links.
export function highlightLog(value: string): LogToken[] {
  const tokens: LogToken[] = []
  let style: CSSProperties = {}
  const controls = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b\]|\x9d)(?:[^\x07\x1b\x9c]|\x1b(?!\\))*(?:\x07|\x1b\\|\x9c|$)|(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])(?:[^\x1b\x9c]|\x1b(?!\\))*(?:\x1b\\|\x9c|$)|(?:\x1b\[|\x9b)[0-?]*[ -/]*$|\x1b[ -/]*[@-~]?|[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
  let offset = 0
  for (const match of value.matchAll(controls)) {
    if (match.index! > offset) tokens.push({ text: value.slice(offset, match.index), style: { ...style } })
    offset = match.index! + match[0].length
    const sgr = /^(?:\x1b\[|\x9b)([\d;]*)m$/.exec(match[0])
    if (!sgr) continue
    const codes = sgr[1].split(";").map(Number)
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index]
      if (code === 0) style = {}
      else if (code === 1) style.fontWeight = 700
      else if (code === 2) style.opacity = 0.75
      else if (code === 3) style.fontStyle = "italic"
      else if (code === 4) style.textDecoration = "underline"
      else if (code === 22) { delete style.fontWeight; delete style.opacity }
      else if (code === 23) delete style.fontStyle
      else if (code === 24) delete style.textDecoration
      else if (code === 39) delete style.color
      else if (code === 49) delete style.backgroundColor
      else if (code >= 30 && code <= 37) style.color = ansiColors[code - 30]
      else if (code >= 90 && code <= 97) style.color = ansiColors[code - 90 + 8]
      else if (code >= 40 && code <= 47) style.backgroundColor = ansiColors[code - 40]
      else if (code >= 100 && code <= 107) style.backgroundColor = ansiColors[code - 100 + 8]
      else if (code === 38 || code === 48) {
        const mode = codes[++index]
        let color: string | undefined
        if (mode === 5) {
          const n = codes[++index]
          if (n >= 0 && n <= 255) {
            const levels = [0, 95, 135, 175, 215, 255]
            color = n < 16 ? ansiColors[n] : n < 232
              ? `rgb(${levels[Math.floor((n - 16) / 36)]}, ${levels[Math.floor((n - 16) / 6) % 6]}, ${levels[(n - 16) % 6]})`
              : `rgb(${8 + (n - 232) * 10}, ${8 + (n - 232) * 10}, ${8 + (n - 232) * 10})`
          }
        } else if (mode === 2) {
          const rgb = codes.slice(index + 1, index + 4)
          index += 3
          if (rgb.length === 3 && rgb.every((n) => n >= 0 && n <= 255)) color = `rgb(${rgb.join(", ")})`
        } else break
        if (color) style[code === 38 ? "color" : "backgroundColor"] = color
      }
    }
  }
  if (offset < value.length) tokens.push({ text: value.slice(offset), style: { ...style } })
  return tokens
}

export function LogOutput({ value }: { value: string }) {
  const tokens = highlightLog(value)
  // Keep dense logs readable without creating hundreds of thousands of DOM nodes.
  if (tokens.length > 4000 || (value.match(/\n/g)?.length ?? 0) > 2000) return <>{tokens.map((token) => token.text).join("")}</>
  // Classify after stripping controls so ANSI boundaries cannot hide a level name.
  const lines: LogToken[][] = [[]]
  for (const token of tokens) {
    const parts = token.text.split("\n")
    parts.forEach((text, index) => {
      if (index) lines.push([])
      if (text) lines[lines.length - 1].push({ text, style: token.style })
    })
  }
  return <>{lines.map((line, index) => {
    const text = line.map((token) => token.text).join("")
    const level = /\b(ERROR|FATAL|PANIC|FAILED|FAILURE|WARN(?:ING)?|INFO|DEBUG|TRACE|SUCCESS|SUCCEEDED)\b/i.exec(text)?.[1].toLowerCase()
    const severity = level && (/error|fatal|panic|fail/.test(level) ? "error" : /^warn/.test(level) ? "warning" : /success|succeeded/.test(level) ? "success" : /debug|trace/.test(level) ? "debug" : "info")
    return <span key={index} className={severity ? `log-${severity}` : undefined}>{line.map((token, part) => <span key={part} style={token.style}>{token.text}</span>)}{index < lines.length - 1 ? "\n" : ""}</span>
  })}</>
}
