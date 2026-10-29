import { describe, expect, it } from "vitest"
import { dirty, openTab, savedTab, recordEdit, stepHistory, type EditorHistory, type EditorSnapshot } from "./tabs"

const document = { name: "idea.md", content: "original", revision: "1" }

describe("editor tabs", () => {
  it("opens multiple independent documents", () => {
    const tabs = openTab(openTab([], document), { ...document, name: "second.md" })
    expect(tabs.map((tab) => tab.name)).toEqual(["idea.md", "second.md"])
    expect(tabs.some(dirty)).toBe(false)
  })

  it("never discards edits when an open file is selected again", () => {
    const tabs = openTab([], document).map((tab) => ({ ...tab, content: "unsaved" }))
    expect(openTab(tabs, document)).toBe(tabs)
    expect(dirty(tabs[0])).toBe(true)
  })

  it("merges out-of-order reads without replacing newer buffers or their identity", () => {
    const tabs = openTab([], { ...document, name: "second.md" })
    const next = openTab(tabs, document)
    expect(next[0]).toBe(tabs[0])
    const edited = next.map((tab) => ({ ...tab, content: "newer local edits" }))
    expect(openTab(edited, { ...document, content: "late disk response" })).toBe(edited)
  })

  it("preserves edits typed while a save was in flight", () => {
    const tabs = openTab([], document).map((tab) => ({ ...tab, content: "typed after save" }))
    const next = savedTab(tabs, { ...document, content: "saved snapshot", revision: "2" })
    expect(next[0].content).toBe("typed after save")
    expect(next[0].saved).toBe("saved snapshot")
    expect(next[0].revision).toBe("2")
    expect(dirty(next[0])).toBe(true)
  })

  it("marks the acknowledged snapshot as clean", () => {
    const tabs = openTab([], document).map((tab) => ({ ...tab, content: "saved snapshot" }))
    expect(dirty(savedTab(tabs, { ...document, content: "saved snapshot", revision: "2" })[0])).toBe(false)
  })

  it("treats an empty new file as unsaved", () => {
    expect(dirty({ name: "new.md", content: "", saved: "", revision: null })).toBe(true)
  })
})

describe("per-editor undo history", () => {
  const view = (value: string, start = value.length): EditorSnapshot => ({ value, start, end: start, direction: "none", top: 120, left: 0 })

  it("groups adjacent typing but isolates commands, caret moves, pauses and other tabs", () => {
    const empty: EditorHistory = { undo: [], redo: [] }
    const typed = recordEdit(recordEdit(empty, view("a"), view("ab"), "insertText", 0), view("ab"), view("abc"), "insertText", 100)
    expect(typed.undo.map((item) => item.value)).toEqual(["a"])
    expect(recordEdit(typed, view("abc"), view("abc completion"), "completion", 200).undo.map((item) => item.value)).toEqual(["a", "abc"])
    expect(recordEdit(typed, view("abc", 0), view("Xabc", 1), "insertText", 200).undo).toHaveLength(2)
    expect(recordEdit(typed, view("abc"), view("abcd"), "insertText", 2000).undo).toHaveLength(2)
    const other = recordEdit(empty, view("other"), view("other tab"), "insertText", 0)
    expect(stepHistory(other, view("other tab"), false)?.snapshot.value).toBe("other")
    expect(stepHistory(typed, view("abc"), false)?.snapshot.value).toBe("a")
  })

  it("restores full views on undo/redo and clears redo only on new text edits", () => {
    const before = { ...view("initial", 2), end: 5, direction: "backward" as const }
    const after = view("replaced")
    const history = recordEdit({ undo: [], redo: [] }, before, after, "insertFromPaste")
    const undone = stepHistory(history, after, false)!
    expect(undone.snapshot).toEqual(before)
    expect(stepHistory(undone.history, before, true)?.snapshot).toEqual(after)
    expect(recordEdit(undone.history, before, before, "input")).toBe(undone.history)
    expect(recordEdit(undone.history, before, view("new"), "insertText").redo).toEqual([])
    expect(stepHistory({ undo: [], redo: [] }, before, false)).toBeNull()
  })

  it("bounds entry count and retained text without mutating older history", () => {
    let history: EditorHistory = { undo: [], redo: [] }
    for (let index = 0; index < 120; index++) history = recordEdit(history, view(String(index)), view(String(index + 1)), "command")
    expect(history.undo).toHaveLength(100)
    const previous = history
    const large = "x".repeat(2 * 1024 * 1024)
    for (let index = 0; index < 10; index++) history = recordEdit(history, view(large + index), view(large + (index + 1)), "command")
    expect(history.undo.length).toBeLessThanOrEqual(4)
    expect(previous.undo).toHaveLength(100)
  })
})
