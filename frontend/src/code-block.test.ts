import { describe, expect, it } from "vitest"
import { codeBlockClassifier } from "./code-block"

describe("code block boundaries", () => {
  it.each([
    "# Example", "  ## Example", "######\tExample", "###",
    "---", " * * * ", "  _\t_\t_", "Example\n=", "Example\n  --",
    "Example\nmore title\n===", "```json\n{}\n```", "~~~\n~~~",
  ])("allows indented code immediately after %j", (prefix) => {
    for (const newline of ["\n", "\r\n"]) {
      for (const indent of ["    ", "\t", " \t"]) {
        const classify = codeBlockClassifier()
        const lines = `${prefix}\n${indent}code\n\n${indent}more\nTasks:\n${indent}Build`.replaceAll("\n", newline).split("\n")
        expect(lines.map(classify).slice(-5)).toEqual([true, true, true, false, false])
      }
    }
  })

  it.each([
    "Tasks:", "#tag", "####### Not a heading", "--- text", "*-*", "__",
    "===", "## Heading\n===", "- Task\n==", "> Quote\n==",
  ])("preserves ordinary indentation after %j", (prefix) => {
    const classify = codeBlockClassifier()
    expect(`${prefix}\n    Build`.split("\n").map(classify).at(-1)).toBe(false)
  })

  it("does not let heading-like code or invalid closers end a fence", () => {
    const classify = codeBlockClassifier()
    expect("````\n## Example\n---\n```\n    code\n~~~~\n    more".split("\n").map(classify)).toEqual(Array(7).fill(true))
  })
})
