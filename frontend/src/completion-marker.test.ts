import { describe, expect, it } from "vitest"
import { completionMarker } from "./completion-marker"

describe("spec completion marker", () => {
  it("only removes a single leading hash followed by a space, preserving indentation", () => {
    for (const line of ["Build", "## Heading", "### Heading", "#tag", "Use C#", "", "/# Pending"]) {
      expect(completionMarker(`  ${line}`, 2)).toEqual({ start: 2, end: 2, text: "# " })
    }
    expect(completionMarker("  # Done", 5)).toEqual({ start: 2, end: 4, text: "" })
    expect(completionMarker("# ## Heading", 0)).toEqual({ start: 0, end: 2, text: "" })
    expect(completionMarker("  #", 3)).toEqual({ start: 2, end: 3, text: "" })
  })

  it("targets the current line including empty lines and ordinary indentation", () => {
    expect(completionMarker("First\n    Next\n", 12)).toEqual({ start: 10, end: 10, text: "# " })
    expect(completionMarker("First\n", 6)).toEqual({ start: 6, end: 6, text: "# " })
    expect(completionMarker("\nNext", 0)).toEqual({ start: 0, end: 0, text: "# " })
  })

  it("leaves actual indented blocks alone but keeps ordinary task indentation eligible", () => {
    for (const indent of ["    ", "\t", " \t", "   \t"]) {
      for (const prefix of ["", "Example:\n\n", "## Example\n", "---\n", "* * *\n", "___\n", "Example\n===\n", "Example\n--\n", "```\n```\n", "~~~\n~~~\n"]) {
        const value = `${prefix}${indent}const path = value\n\n${indent}# comment`
        for (const caret of [value.indexOf("const"), value.indexOf("\n\n", prefix.length) + 1, value.length]) {
          expect(completionMarker(value, caret)).toBeNull()
        }
        const after = `${value}\nPending\n${indent}# Done`
        expect(completionMarker(after, after.length)).toEqual({ start: after.length - 6, end: after.length - 4, text: "" })
      }
      const task = `Tasks:\n${indent}Build`
      expect(completionMarker(task, task.length)).toEqual({ start: task.length - 5, end: task.length - 5, text: "# " })
    }
  })

  it("recognizes CRLF fence closers and does not open fences inside indented code", () => {
    const crlf = "```json\r\n# code\r\n```\r\nPending"
    expect(completionMarker(crlf, crlf.indexOf("# code"))).toBeNull()
    expect(completionMarker(crlf, crlf.length)?.text).toBe("# ")
    const indented = "Example:\n\n    ```\nPending"
    expect(completionMarker(indented, indented.length)?.text).toBe("# ")
  })

  it("leaves backtick and tilde fenced code and delimiter lines alone", () => {
    for (const fence of ["```", "~~~~"]) {
      const value = `Before\n  ${fence}js\n# code\n  ${fence}\nAfter`
      for (const position of [value.indexOf(fence), value.indexOf("# code"), value.lastIndexOf(fence)]) {
        expect(completionMarker(value, position)).toBeNull()
      }
      expect(completionMarker(value, value.length)?.text).toBe("# ")
    }
  })

  it("requires matching fence characters, sufficient length, and a bare closer", () => {
    for (const closer of ["~~~", "```", "```` trailing"]) {
      const value = `\`\`\`\`js\n${closer}\n# still code`
      expect(completionMarker(value, value.length)).toBeNull()
    }
    const value = "```js\ncode\n```` \t\nPending"
    expect(completionMarker(value, value.length)?.text).toBe("# ")
  })

  it("does not treat inline backticks or completed fence text as an opener", () => {
    for (const first of ["Use ``` inline", "```bad`info", "# ```js"]) {
      const value = `${first}\nPending`
      expect(completionMarker(value, value.length)?.text).toBe("# ")
    }
  })
})
