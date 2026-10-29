export type Document = { name: string; content: string; revision: string }
export type Tab = { name: string; content: string; saved: string; revision: string | null }
export type Output = { id: string; name: string; status: string; output: string; truncated: boolean; recoverable: boolean; transportUnavailable?: boolean }

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

export type EditorSnapshot = { value: string; start: number; end: number; direction: "forward" | "backward" | "none"; top: number; left: number }
export type EditorHistory = { undo: EditorSnapshot[]; redo: EditorSnapshot[]; last?: { snapshot: EditorSnapshot; kind: string; time: number } }

export function recordEdit(history: EditorHistory, before: EditorSnapshot, after: EditorSnapshot, kind: string, time = Date.now()): EditorHistory {
  if (before.value === after.value) return history
  const last = history.last
  const grouped = /^(insertText|insertCompositionText|deleteContentBackward|deleteContentForward)$/.test(kind)
    && last?.kind === kind && time - last.time < 1000 && last.snapshot.value === before.value
    && last.snapshot.start === before.start && last.snapshot.end === before.end
  const undo = grouped ? [...history.undo] : [...history.undo, before]
  // Bound retained text as well as entry count for large specs.
  let bytes = 0
  for (let index = undo.length - 1; index >= 0; index--) {
    bytes += undo[index].value.length * 2
    if (index < undo.length - 1 && (bytes > 16 * 1024 * 1024 || undo.length - index > 100)) { undo.splice(0, index + 1); break }
  }
  return { undo, redo: [], last: { snapshot: after, kind, time } }
}

export function stepHistory(history: EditorHistory, current: EditorSnapshot, redo: boolean): { history: EditorHistory; snapshot: EditorSnapshot } | null {
  const source = redo ? history.redo : history.undo
  const snapshot = source.at(-1)
  if (!snapshot) return null
  return { snapshot, history: redo
    ? { undo: [...history.undo, current], redo: source.slice(0, -1) }
    : { undo: source.slice(0, -1), redo: [...history.redo, current] } }
}
