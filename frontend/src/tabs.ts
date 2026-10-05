export type Document = { name: string; content: string; revision: string }
export type Tab = { name: string; content: string; saved: string; revision: string | null }
export type Output = { id: string; name: string; status: string; output: string; truncated: boolean }

export function openTab(tabs: Tab[], document: Document): Tab[] {
  // Selecting an already-open file must never replace its unsaved buffer.
  if (tabs.some((tab) => tab.name === document.name)) return tabs
  return [...tabs, { ...document, saved: document.content }]
}

export function savedTab(tabs: Tab[], document: Document): Tab[] {
  // Edits typed during a save remain dirty against the snapshot acknowledged by the server.
  return tabs.map((tab) => tab.name === document.name
    ? { ...tab, saved: document.content, revision: document.revision }
    : tab)
}

export function dirty(tab: Tab) {
  return tab.revision === null || tab.content !== tab.saved
}
