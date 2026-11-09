import { useRef, useState } from "react"
import type { Output } from "./tabs"
import { sessionOutputPdf } from "./session-output-export"

export function OutputDownload({ output }: { output: Output | null | undefined }) {
  const exporting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function download(owner: Document) {
    if (!output?.output || exporting.current) return
    exporting.current = true
    setBusy(true)
    setError("")
    // Capture the selected run before lazy loading; polling/tab changes must not mix snapshots.
    const snapshot = { ...output }
    try {
      const blob = await sessionOutputPdf(snapshot)
      const url = URL.createObjectURL(blob)
      try {
        const link = owner.createElement("a")
        const safe = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 100) || "session"
        link.href = url
        link.download = `${safe(snapshot.name)}-${safe(snapshot.id)}-output.pdf`
        owner.body.append(link)
        try { link.click() } finally { link.remove() }
      } finally { setTimeout(() => URL.revokeObjectURL(url), 30_000) }
    } catch (error) {
      setError(`PDF export failed: ${error instanceof Error ? error.message : String(error)}. Try downloading again.`)
    } finally { exporting.current = false; setBusy(false) }
  }

  return <div className="output-controls">
    <button type="button" disabled={!output?.output || busy} title="Download a PDF snapshot of the selected session's available output, not the editor text" onClick={(event) => void download(event.currentTarget.ownerDocument)}>{busy ? "Preparing PDF..." : "Download output PDF"}</button>
    {error && <span role="alert" className="error">{error}</span>}
  </div>
}
