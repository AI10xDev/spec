import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { highlightLog, highlightSpec, LogOutput } from "./highlighting"
import { completionMarker } from "./completion-marker"

describe("spec highlighting", () => {
  it("preserves every source character and logical line, including empty final lines", () => {
    for (const value of ["", "\n\n", "  # Done\r\n## Heading\r\n", "- **bold** and _emphasis_ [link](https://example.com) `code`\n", "```js\n# not done\n```\n", "\tSpaces  \n<img src=x> & \"quotes\"\n"]) {
      const lines = highlightSpec(value)
      expect(lines.map((line) => line.tokens.map((token) => token.text).join("")).join("\n")).toBe(value)
      expect(lines).toHaveLength(value.split("\n").length)
    }
  })

  it("distinguishes completion markers from headings, tags, and inline hashes", () => {
    const lines = highlightSpec("# Done\n  # Done too\n#\n## Heading\n### Heading\n#tag\nUse C# and #fff\nPending")
    expect(lines.map((line) => line.kind)).toEqual(["completed", "completed", "completed", "heading", "heading", undefined, undefined, undefined])
  })

  it("treats matching fences and their contents as code, not completed tasks", () => {
    for (const fence of ["````", "~~~~"]) {
      const lines = highlightSpec(`${fence}js\n# code\n${fence.slice(1)}\n## code\n${fence} trailing\n${fence}\n# Done`)
      expect(lines.map((line) => line.kind)).toEqual(["code", "code", "code", "code", "code", "code", "completed"])
    }
    expect(highlightSpec("# ```\nPending").map((line) => line.kind)).toEqual(["completed", undefined])
    expect(highlightSpec("```bad`info\nPending").map((line) => line.kind)).toEqual([undefined, undefined])
  })

  it("colors inline code, lists, emphasis and links without rendering Markdown", () => {
    const [line] = highlightSpec("  1. **bold** *italic* __bold__ _italic_ ~~strike~~ [link](https://example.com) `# code` ``a ` b``")
    expect(line.tokens.filter((token) => token.kind).map((token) => [token.text, token.kind])).toEqual([
      ["  1.", "list"], ["**bold**", "emphasis"], ["*italic*", "emphasis"], ["__bold__", "emphasis"], ["_italic_", "emphasis"], ["~~strike~~", "emphasis"], ["[link](https://example.com)", "link"], ["`# code`", "code"], ["``a ` b``", "code"],
    ])
    expect(highlightSpec("`**not emphasis**` \\*plain\\*")[0].tokens.filter((token) => token.kind).map((token) => token.kind)).toEqual(["code"])
  })

  it("distinguishes indented code blocks from ordinary task indentation", () => {
    const lines = highlightSpec("Example:\n\n    # shell comment\n    echo ok\n\nPending\n    # indented completed task")
    expect(lines.map((line) => line.kind)).toEqual([undefined, undefined, "code", "code", "code", undefined, "completed"])
  })

  it("agrees with marker eligibility on every line without changing source text", () => {
    for (const value of [
      "Example:\n\n    # comment\n\n\tmore code\nPending\n    # completed task",
      "\t# code at start\nPending\n \tTask\n  # Done",
      "````json\r\n# code\r\n```\r\n~~~~\r\n```` trailing\r\n````\r\n# Done",
      "~~~\n\n    # code\n~~~\nPending",
      "Example:\n\n    ```\nPending\n```bad`info\n# Done",
      "## Example\n    # code\nPending\n    # Done",
      "---\n    code\nPending\n* * *\n    code\nPending\n___\n    code",
      "Example\n===\n    code\nPending\n--\n    code",
      "```\n```\n    code\nPending\n~~~\n~~~\n\tcode",
    ]) {
      let offset = 0
      const lines = highlightSpec(value)
      lines.forEach((line) => {
        const text = line.tokens.map((token) => token.text).join("")
        expect(completionMarker(value, offset) === null).toBe(line.kind === "code")
        expect(completionMarker(value, offset + text.length) === null).toBe(line.kind === "code")
        offset += text.length + 1
      })
      expect(lines.map((line) => line.tokens.map((token) => token.text).join("")).join("\n")).toBe(value)
    }
  })

  it("colors indented code after completed Markdown blocks without absorbing later tasks", () => {
    for (const prefix of ["## Example", "---", "* * *", "___", "Example\n===", "Example\n--", "```\n```", "~~~\n~~~"]) {
      const lines = highlightSpec(`${prefix}\n    # comment\nTasks:\n    # Done`)
      expect(lines.slice(-3).map((line) => line.kind)).toEqual(["code", undefined, "completed"])
    }
  })

  it("keeps very long unmatched inline syntax as a single plain token", () => {
    const text = "[".repeat(2 * 1024 * 1024)
    expect(highlightSpec(text)).toEqual([{ tokens: [{ text }] }])
  })
})

describe("safe log highlighting", () => {
  const text = (value: string) => highlightLog(value).map((token) => token.text).join("")

  it("preserves plain text, tabs, Unicode and newlines", () => {
    for (const value of ["", "\n\n", "INFO ready\n\tdebug: next\n", "<script>alert('x')</script> & \"text\"", "emoji: \u{1f680}\n"]) expect(text(value)).toBe(value)
  })

  it("supports SGR colors and attributes with selective and full resets", () => {
    const tokens = highlightLog("plain\x1b[31;1;3;4mred\x1b[22;23;24mnormal\x1b[0mreset")
    expect(tokens.map((token) => token.text)).toEqual(["plain", "red", "normal", "reset"])
    expect(tokens[1].style).toMatchObject({ color: expect.any(String), fontWeight: 700, fontStyle: "italic", textDecoration: "underline" })
    expect(tokens[2].style).toEqual({ color: tokens[1].style.color })
    expect(tokens[3].style).toEqual({})
    expect(highlightLog("\x1b[38;2;1;2;3;48;5;196mRGB\x1b[39;49mreset")).toEqual([
      { text: "RGB", style: { color: "rgb(1, 2, 3)", backgroundColor: "rgb(255, 0, 0)" } }, { text: "reset", style: {} },
    ])
    expect(highlightLog("\x9b94mbright\x9bmbare reset")[1].style).toEqual({})
  })

  it("drops unsafe terminal commands, string payloads, and bidi overrides", () => {
    expect(text("before\x1b[2J\x1b[Hafter\r\n\tend\b\x07\u202e\u2066\u2069")).toBe("beforeafter\n\tend")
    for (const open of ["\x1b]", "\x9d"]) {
      for (const close of ["\x07", "\x1b\\", "\x9c"]) {
        expect(text(`a${open}52;c;clipboard${close}b`)).toBe("ab")
      }
    }
    expect(text("\x1b]8;;javascript:alert(1)\x1b\\label\x1b]8;;\x1b\\")).toBe("label")
    for (const open of ["\x1bP", "\x1b^", "\x1b_", "\x1bX", "\x90", "\x98", "\x9e", "\x9f"]) expect(text(`a${open}hidden\x1b\\b`)).toBe("ab")
    expect(text("a\x1b]52;c;secret\x1b[31mstill secret\x07b")).toBe("ab")
  })

  it("handles truncated controls and invalid colors without exposing payloads or styles", () => {
    for (const suffix of ["\x1b", "\x1b[", "\x1b[31;", "\x1b]52;c;secret", "\x1bPsecret"]) expect(text(`safe${suffix}`)).toBe("safe")
    expect(highlightLog("\x1b[38;2;999;0;0mtext")).toEqual([{ text: "text", style: {} }])
    expect(highlightLog("\x1b[38;5;256mtext")).toEqual([{ text: "text", style: {} }])
    expect(highlightLog("\x1b[38;2;1mtext")).toEqual([{ text: "text", style: {} }])
  })

  it("renders only escaped spans with severity colors and no pre wrapper or links", () => {
    const html = renderToStaticMarkup(<LogOutput value={'ER\x1b[31mROR\x1b[0m <img src=x onerror="alert(1)">\nWARN wait\nINFO start\nDEBUG detail\nSUCCESS done\n'} />)
    for (const level of ["error", "warning", "info", "debug", "success"]) expect(html).toContain(`class="log-${level}"`)
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;")
    expect(html).not.toMatch(/<(?:img|script|a|pre)\b/)
    expect(html.replace(/<[^>]*>/g, "")).toBe("ERROR &lt;img src=x onerror=&quot;alert(1)&quot;&gt;\nWARN wait\nINFO start\nDEBUG detail\nSUCCESS done\n")
  })

  it("renders dense logs as safe plain text instead of an unbounded span tree", () => {
    const value = "\x1b[31m<img>\x1b[0m\n".repeat(5000)
    expect(renderToStaticMarkup(<LogOutput value={value} />)).toBe("&lt;img&gt;\n".repeat(5000))
  })
})
