import { useEffect, useRef, useState } from "react"
import type { Document, Tab } from "./tabs"
import { dirty } from "./tabs"

export function AgentEditor({ api }: { api: <T>(path: string, body?: unknown, method?: string) => Promise<T> }) {
  const [open, setOpen] = useState(false)
  const [document, setDocument] = useState<Tab | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const pending = useRef(false)
  const changed = document !== null && dirty(document)

  useEffect(() => {
    if (!changed) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [changed])

  async function load() {
    if (pending.current || (changed && !window.confirm("Discard unsaved Agent.md edits and reload from disk?"))) return
    pending.current = true
    setBusy(true)
    setError("")
    setNotice("")
    try {
      const next = await api<Document>("/files/Agent.md")
      setDocument({ ...next, saved: next.content })
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 404) {
        setDocument({ name: "Agent.md", content: "", saved: "", revision: null })
        setNotice("Agent.md does not exist yet. Write a draft and save to create it.")
      } else setError(error instanceof Error ? error.message : String(error))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  async function save() {
    if (!document || pending.current) return
    pending.current = true
    setBusy(true)
    setError("")
    setNotice("")
    try {
      const next = await api<Document>("/files/Agent.md", { content: document.content, revision: document.revision }, "PUT")
      setDocument({ ...next, saved: next.content })
      setNotice("Saved Agent.md in the workspace.")
    } catch (error) {
      setError(`${error instanceof Error ? error.message : String(error)} Your draft is still here. Copy it before reloading to resolve a conflict.`)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return <>
    <div className="chat-tools"><button type="button" aria-expanded={open} aria-controls="agent-editor" onClick={() => {
      setOpen(!open)
      if (!open && !document) void load()
    }}>{open ? "Hide Agent.md" : "Edit Agent.md"}{changed ? " *" : ""}</button></div>
    <section id="agent-editor" className="agent-editor" aria-label="Agent.md editor" hidden={!open}>
      <h2>Agent.md</h2>
      <p>Write or edit the workspace's Agent.md without leaving chat. Saving only updates this file; it does not run commands or install instructions into remote builds or AI conversations.</p>
      {document && <><label htmlFor="agent-content">Agent.md content</label><textarea id="agent-content" value={document.content} onChange={(event) => { setDocument({ ...document, content: event.target.value }); setNotice("") }} disabled={busy} rows={10} spellCheck={false} /></>}
      {busy && <p role="status">Updating Agent.md...</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="chat-tools"><button type="button" disabled={busy} onClick={() => void load()}>Reload Agent.md</button><button type="button" className="primary" disabled={busy || !changed} onClick={() => void save()}>Save Agent.md</button></div>
    </section>
  </>
}
