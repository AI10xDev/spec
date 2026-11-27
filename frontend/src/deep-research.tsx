import { useEffect, useRef, useState } from "react"
import { MAX_QUERY_BYTES, queryError, researchMarkdown, safeSourceUrl } from "./deep-research-export"
import type { ResearchOutput } from "./deep-research-export"
import "./deep-research.css"

type Api = <T>(path: string, body?: unknown, method?: string, signal?: AbortSignal) => Promise<T>
type Status = { configured: boolean; message: string; preferences?: import("./exa-settings").ExaPreferences | null }

export function DeepResearch({ api, editorText, onClose }: { api: Api; editorText: string | undefined; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const request = useRef<AbortController | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState<ResearchOutput | null>(null)

  useEffect(() => {
    const element = dialog.current!
    const opener = document.activeElement
    element.showModal()
    const controller = new AbortController()
    void api<Status>("/research", undefined, "GET", controller.signal).then((value) => {
      if (!controller.signal.aborted) setStatus(value)
    }).catch(() => {
      if (!controller.signal.aborted) setError("Could not check research configuration. Close and reopen to try again.")
    })
    return () => {
      controller.abort()
      request.current?.abort()
      element.close()
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])
  useEffect(() => { if (result) heading.current?.focus() }, [result])

  function close() {
    if (request.current && !window.confirm("Stop waiting and close? The result will be discarded. Exa work and charges may continue.")) return
    onClose()
  }
  async function generate() {
    if (request.current || !status?.configured) return
    const invalid = queryError(query)
    if (invalid) { setError(invalid); return }
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setError("")
    try {
      const output = await api<ResearchOutput>("/research", { query }, "POST", controller.signal)
      if (!controller.signal.aborted) setResult(output)
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (!controller.signal.aborted) { request.current = null; setBusy(false) }
    }
  }
  function download() {
    if (!result) return
    try {
      const url = URL.createObjectURL(new Blob([researchMarkdown(result)], { type: "text/markdown;charset=utf-8" }))
      const link = document.createElement("a")
      link.href = url; link.download = "deep-research.md"; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch { setError("Could not download the report. Keep this dialog open and try again.") }
  }
  function citations(field: string) {
    const ids = (result?.grounding[field] ?? []).filter((id) => result?.sources.some((s) => s.id === id && safeSourceUrl(s.url)))
    return ids.length ? <span className="research-citations">{ids.map((id) => <a key={id} href={`#research-source-${id}`} aria-label={`Exa source ${id}`}>[{id}]</a>)}</span>
      : <small className="research-ungrounded"> No usable Exa grounding</small>
  }
  return <dialog ref={dialog} className="analytics-dialog deep-research" aria-labelledby="deep-research-title" onCancel={(event) => { event.preventDefault(); close() }}>
    <header className="analytics-heading"><div><span className="eyebrow">EXA / RESEARCH</span><h2 id="deep-research-title" ref={heading} tabIndex={-1}>Deep research</h2></div><button onClick={close} aria-label="Close deep research">{busy ? "Stop waiting & close" : "Close"}</button></header>
    {!result ? <form className="analytics-select" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void generate() }}>
      <p>Research a question with Exa Deep Search. Opening this dialog sends no editor content. Research never edits your spec, launches builds, or grants approval.</p>
      <p role="status">{status?.message ?? "Checking Exa configuration…"}</p>
      {status?.preferences && <p>Server settings when opened: {status.preferences.enabled ? "enabled" : "disabled"}; up to {status.preferences.numResults} returned pages; {status.preferences.domainMode === "any" ? "any domain" : `${status.preferences.domainMode} domains: ${status.preferences.domains.join(", ")}`}. Change these in Settings → Exa Deep Search. Another authorized browser may change server settings before submission; this is not a per-request filter override.</p>}
      <label htmlFor="research-query">Research question</label>
      <textarea id="research-query" rows={6} value={query} disabled={busy} aria-describedby="research-limit research-disclosure" onChange={(event) => setQuery(event.target.value)} />
      <span id="research-limit">{new TextEncoder().encode(query).length.toLocaleString()} / {MAX_QUERY_BYTES.toLocaleString()} UTF-8 bytes</span>
      <button type="button" disabled={busy || editorText === undefined} onClick={() => {
        if (editorText === undefined) return
        const invalid = queryError(editorText)
        if (invalid) { setError(invalid); return }
        setQuery(editorText); setError("")
      }}>Use current editor text</button>
      <p id="research-disclosure">The visible question and configured search filters are sent to Exa when you select Start research. No filenames, editor buffers or logs are sent implicitly. Review it and remove private data or credentials first. Exa may incur charges and perform multiple internal searches. Waiting is limited to 90 seconds; closing or timing out does not guarantee stopping provider work or charges. No automatic retries.</p>
      <p>Read-only results are not saved as history. Download before closing.</p>
      <button className="primary" disabled={busy || !status?.configured}>{busy ? "Researching…" : "Start research"}</button>
      {busy && <p role="status">Waiting for Exa research. You can stop waiting and close.</p>}
    </form> : <div className="analytics-dashboard">
      <div className="research-actions"><button onClick={download}>Download Markdown</button><button onClick={() => { setResult(null); setError("") }}>Research another question</button></div>
      <h3>{result.report.title} {citations("title")}</h3>
      <p>Generated research, not implementation or verified test evidence. Provider citations are not independent verification.</p>
      {result.warnings.map((warning, i) => <p className="analytics-warning" key={i}>{warning}</p>)}
      <section><h3>Summary</h3><p>{result.report.summary} {citations("summary")}</p></section>
      <section><h3>Findings</h3><ol>{result.report.findings.map((finding, i) => <li key={i}>{finding} {citations(`findings[${i}]`)}</li>)}</ol></section>
      <section><h3>Limitations</h3>{!result.report.limitations.length && <p>Exa did not supply limitations; this does not establish completeness.</p>}<ul>{result.report.limitations.map((item, i) => <li key={i}>{item} {citations(`limitations[${i}]`)}</li>)}</ul></section>
      <section><h3>Sources</h3><p>Search results without field-level citations do not substantiate report claims.</p>{!result.sources.length && <p>No usable sources were returned.</p>}<ol>{result.sources.map((source) => {
        const url = safeSourceUrl(source.url)
        return url ? <li key={source.id} id={`research-source-${source.id}`} value={source.id}><a href={url} target="_blank" rel="noopener noreferrer">{source.title}</a><p>{url}</p></li> : null
      })}</ol></section>
    </div>}
    {error && <p role="alert" className="error research-error">{error}</p>}
  </dialog>
}
