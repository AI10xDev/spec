import { describe, expect, it } from "vitest"
import { dirty, openTab, savedTab } from "./tabs"

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
