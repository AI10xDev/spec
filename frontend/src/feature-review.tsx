import { useEffect, useRef, useState } from "react"
import { markdown, pdf } from "./feature-review-export"
import type { ReviewOutput } from "./feature-review-export"
import "./feature-review.css"

type Api = <T>(path: string, body?: unknown, method?: string, signal?: AbortSignal) => Promise<T>

export function FeatureReview({ api, onClose }: { api: Api; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const request = useRef<AbortController | null>(null)
  const exporting = useRef(false)
  const mounted = useRef(true)
  const [repositoryUrl, setRepositoryUrl] = useState("")
  const [competitors, setCompetitors] = useState("")
  const [illustrate, setIllustrate] = useState(true)
  const [imageStatus, setImageStatus] = useState("Checking GPT-image configuration...")
  const [busy, setBusy] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState<ReviewOutput | null>(null)

  useEffect(() => {
    const element = dialog.current!
    const opener = document.activeElement
    mounted.current = true
    element.showModal()
    const controller = new AbortController()
    void api<{ imageConfigured: boolean }>("/feature-review", undefined, "GET", controller.signal).then((status) => {
      if (!controller.signal.aborted) setImageStatus(status.imageConfigured
        ? "Azure image configuration is present; deployment availability is checked during generation."
        : "GPT-image is not configured. Reports will include a built-in workflow diagram, not an AI-generated illustration.")
    }).catch(() => { if (!controller.signal.aborted) setImageStatus("Could not check GPT-image configuration. Any image failure will be disclosed in the report.") })
    return () => {
      mounted.current = false
      controller.abort()
      request.current?.abort()
      element.close()
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])

  useEffect(() => { if (result) heading.current?.focus() }, [result])

  function close() {
    if (busy && !window.confirm("Close this review? The result will be discarded. Provider work and charges may continue.")) return
    onClose()
  }

  async function generate() {
    if (request.current) return
    const urls = competitors.split(/\r?\n/).map((url) => url.trim()).filter(Boolean)
    if (urls.length < 1 || urls.length > 3) { setError("Provide one to three competitor repository URLs, one per line."); return }
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setError("")
    try {
      const output = await api<ReviewOutput>("/feature-review", { repositoryUrl: repositoryUrl.trim(), competitorUrls: urls, illustrate }, "POST", controller.signal)
      if (!controller.signal.aborted) setResult(output)
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (!controller.signal.aborted) { setBusy(false); request.current = null }
    }
  }

  async function download(format: "md" | "pdf") {
    if (!result || exporting.current) return
    exporting.current = true
    setDownloading(true); setError("")
    try {
      const blob = format === "pdf" ? await pdf(result) : new Blob([markdown(result)], { type: "text/markdown;charset=utf-8" })
      if (!mounted.current) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url; link.download = `feature-review.${format}`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch (error) {
      if (mounted.current) setError(`Export failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      exporting.current = false
      if (mounted.current) setDownloading(false)
    }
  }

  const citations = (ids: number[]) => <span className="review-citations">{ids.map((id) => <a key={id} href={`#review-source-${id}`} aria-label={`Source ${id}`}>[{id}]</a>)}</span>
  return <dialog ref={dialog} className={`analytics-dialog feature-review ${result ? "analytics-wide" : ""}`} aria-labelledby="feature-review-title" onCancel={(event) => { event.preventDefault(); close() }}>
    <header className="analytics-heading"><div><span className="eyebrow">REPOSITORY / RESEARCH</span><h2 id="feature-review-title" ref={heading} tabIndex={-1}>{result ? result.report.title : "Feature review"}</h2></div><button onClick={close} aria-label="Close feature review">Close</button></header>
    {!result ? <form className="analytics-select" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void generate() }}>
      <p>Compare documented features using live public GitHub metadata and commit-pinned README files. No repository code is executed. Editor content and Performance runs are not used or changed.</p>
      <label htmlFor="review-repository">Repository GIT URL</label>
      <input id="review-repository" type="url" required maxLength={180} placeholder="https://github.com/owner/repository" value={repositoryUrl} disabled={busy} onChange={(event) => setRepositoryUrl(event.target.value)} />
      <label htmlFor="review-competitors">Competitor GIT URLs (one to three, one per line)</label>
      <textarea id="review-competitors" required rows={3} maxLength={550} placeholder="https://github.com/competitor/repository" value={competitors} disabled={busy} onChange={(event) => setCompetitors(event.target.value)} />
      <p>Public github.com repository URLs only. Private repositories, other Git hosts, and documentation subpaths are not supported.</p>
      <label className="review-checkbox"><input type="checkbox" checked={illustrate} disabled={busy} onChange={(event) => setIllustrate(event.target.checked)} /> Request a GPT-image workflow illustration</label>
      <p role="status">{imageStatus}</p>
      <p>Generation sends public repository evidence to the configured AI provider and may incur text and image charges. It can take up to three minutes. Download the report before closing; results are not saved on the server.</p>
      <button className="primary" disabled={busy}>{busy ? "Researching and generating report..." : "Generate feature report"}</button>
    </form> : <div className="analytics-dashboard">
      <div className="review-downloads"><button className="primary" disabled={downloading} onClick={() => void download("pdf")}>Download PDF</button><button disabled={downloading} onClick={() => void download("md")}>Download .md</button><button disabled={downloading} onClick={() => setResult(null)}>Review another repository</button></div>
      {result.warnings.map((warning, index) => <p key={index} className="analytics-warning">{warning}</p>)}
      <section><h3>Feature summary</h3><p>{result.report.summary}</p><div className="analytics-table"><table><caption>Documented features</caption><thead><tr><th>Feature</th><th>Evidence</th></tr></thead><tbody>{result.report.features.map((feature, index) => <tr key={index}><th>{feature.name}</th><td>{feature.detail} {citations(feature.sources)}</td></tr>)}</tbody></table></div></section>
      <section><h3>Key strengths</h3>{result.report.findings.some((finding) => finding.strength) ? result.report.findings.filter((finding) => finding.strength).map((finding, index) => <article key={index}><h4>{finding.title}</h4><p>{finding.detail} {citations(finding.sources)}</p></article>) : <p>No supported strengths were identified in the fetched evidence.</p>}</section>
      <section><h3>Findings</h3>{result.report.findings.map((finding, index) => <article key={index}><h4>{finding.title}{finding.strength ? " / Strength" : ""}</h4><p>{finding.detail} {citations(finding.sources)}</p></article>)}</section>
      <section><h3>Competitor comparison</h3><div className="analytics-table"><table><caption>Documentation comparison, not a benchmark</caption><thead><tr><th>Aspect</th><th>Reviewed repository</th><th>Competitors</th></tr></thead><tbody>{result.report.comparison.map((row, index) => <tr key={index}><th>{row.aspect}</th><td>{row.project}</td><td>{row.competitors} {citations(row.sources)}</td></tr>)}</tbody></table></div></section>
      <section><h3>Feature review workflow</h3><ol className="review-flow" aria-label="Built-in review workflow flowchart">{["Fetch repository evidence", "Pin README revisions", "Summarize documented features", "Compare competitors and unknowns", "Export cited PDF and Markdown"].map((step) => <li key={step}>{step}</li>)}</ol>
        {result.imageDataUrl ? <figure><img className="review-image" src={result.imageDataUrl} alt="GPT-image illustration of the feature review workflow" /><figcaption>AI-generated illustration, not evidence of repository behavior.</figcaption></figure> : <p>No GPT-image illustration was generated. The workflow above is a built-in diagram.</p>}</section>
      <section><h3>Limitations</h3><ul>{result.report.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></section>
      <section><h3>Sources</h3><ol>{result.sources.map((source) => <li id={`review-source-${source.id}`} key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a><p>README revision: <code>{source.revision}</code><br />Fetched: {new Date(Number(source.accessed) * 1000).toISOString()}</p></li>)}</ol></section>
    </div>}
    {error && <p role="alert" className="error review-error">{error}</p>}
  </dialog>
}
