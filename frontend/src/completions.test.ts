import { describe, expect, it } from "vitest"
import { completionPrefix } from "./completions"

describe("sentence-part completion context", () => {
  it("retains context for a partial word or clause at a line's end", () => {
    for (const text of ["Build a dash", "Save files, then sync", "A sentence. Another part", "你好", "  # Add a tool"]) {
      expect(completionPrefix(text, text.length)).toBe(text)
    }
    expect(completionPrefix("First part\nNext line", 10)).toBe("First part")
  })

  it("does not suggest for selections, existing suffixes or empty sentence parts", () => {
    expect(completionPrefix("Some text", 4, 9)).toBe("")
    expect(completionPrefix("Some text", 4)).toBe("")
    for (const text of ["", "  ", "# ", "Done. ", "Part, ", "Part;", "Done!", "Done?", "Line\n"]) {
      expect(completionPrefix(text, text.length)).toBe("")
    }
  })

  it("bounds Unicode context without splitting surrogate pairs", () => {
    const text = "😀".repeat(6000) + " Add"
    const prefix = completionPrefix(text, text.length)
    expect(new TextEncoder().encode(prefix).length).toBeLessThanOrEqual(16 * 1024)
    expect(prefix).toBe(new TextDecoder().decode(new TextEncoder().encode(prefix)))
    expect(prefix.endsWith(" Add")).toBe(true)
  })
})
