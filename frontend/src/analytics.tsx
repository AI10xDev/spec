import { useEffect, useRef, useState } from "react"
import type { Document, Output } from "./tabs"
import { evaluate, extractMetrics, parseSuite } from "./evaluation"
import type { Metric, Metrics, Result } from "./evaluation"

type Api = <T>(path: string, body?: unknown, method?: string) => Promise<T>
type Report = { report: Output | null; runs: { id: string; modified: number }[]; warnings: string[] }
type Dashboard = { name: string; report: Output; metrics: Metrics; checks: Result[]; warnings: string[]; evalName: string; revision: string; digest: string }
const format = (value: number) => new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 }).format(value)

function Chart({ metric }: { metric: Metric }) {
  const values = metric.samples
  let min = Infinity
  let max = -Infinity
  for (const sample of values) { min = Math.min(min, sample.value); max = Math.max(max, sample.value) }
  // Scaling first avoids overflow for finite measurements near Number.MAX_VALUE.
  const scale = Math.max(Math.abs(min), Math.abs(max), 1)
  const low = min / scale
  const range = max / scale - low
  const plot = values.filter((_, index) => index % Math.max(1, Math.ceil(values.length / 200)) === 0 || index === values.length - 1)
  const points = plot.map((sample) => `${40 + 620 * (sample.line - values[0].line) / Math.max(1, values.at(-1)!.line - values[0].line)},${range ? 155 - 125 * (sample.value / scale - low) / range : 90}`).join(" ")
  return <article className="metric-chart">
    <h3>{metric.name}</h3>
    <p>Latest <strong>{format(values.at(-1)!.value)}</strong> / {values.length.toLocaleString()} samples</p>
    <svg viewBox="0 0 700 200" role="img" aria-label={`${metric.name}: minimum ${format(min)}, maximum ${format(max)}, latest ${format(values.at(-1)!.value)}`}>
      <path className="chart-axis" d="M40 20V165H670" />
      <polyline className="chart-line" points={points} />
      {values.length === 1 && <circle className="chart-dot" cx="40" cy="90" r="4" />}
      <text x="40" y="190">Report line {values[0].line}</text><text x="660" y="190" textAnchor="end">{values.at(-1)!.line}</text>
    </svg>
    <p>Min {format(min)} / Max {format(max)}. {values.length > 200 ? "Chart sampled; checks use every extracted sample." : "In report order."}</p>
  </article>
}

export function Analytics({ api, active, onClose }: { api: Api; active: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const request = useRef(0)
  const submitting = useRef(false)
  const [files, setFiles] = useState<string[]>([])
  const [name, setName] = useState("")
  const [evalName, setEvalName] = useState("")
  const [runId, setRunId] = useState("")
  const [source, setSource] = useState<Report | null>(null)
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const specs = files.filter((file) => !file.endsWith(".out") && !file.endsWith(".eval") && !file.endsWith(".optim"))

  useEffect(() => {
    const element = dialog.current!
    const opener = document.activeElement
    element.showModal()
    let cancelled = false
    void api<{ name: string }[]>("/files").then((entries) => {
      if (cancelled) return
      const files = entries.map((entry) => entry.name)
      setFiles(files)
      if (files.includes(active) && !/\.(out|eval|optim)$/.test(active)) {
        setName(active)
        setEvalName(files.includes(`${active}.eval`) ? `${active}.eval` : "")
      }
    }).catch((error: unknown) => { if (!cancelled) setError(error instanceof Error ? error.message : String(error)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => {
      cancelled = true; request.current++; element.close()
      // Unmount can detach the dialog before native focus restoration runs.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])

  useEffect(() => { if (dashboard) heading.current?.focus() }, [dashboard])

  async function analyse(event: React.FormEvent) {
    event.preventDefault()
    if (!name || submitting.current) return
    submitting.current = true
    const current = ++request.current
    setLoading(true)
    setError("")
    try {
      const source = await api<Report>("/analytics", { name, ...(runId ? { runId } : {}) })
      if (current !== request.current) return
      setSource(source)
      if (!source.report) return
      const report = source.report
      const warnings = [...source.warnings]
      const metrics = extractMetrics(report.output)
      warnings.push(...metrics.diagnostics)
      let checks: Result[] = []
      let revision = ""
      if (evalName) {
        // IO failures are not evidence of a non-eval file; surface them for retry.
        const document = await api<Document>(`/files/${encodeURIComponent(evalName)}`)
        revision = document.revision
        try {
          const suite = parseSuite(document.content, name)
          const provisional = report.truncated || !["completed", "snapshot"].includes(report.status)
          checks = evaluate(suite, metrics, provisional)
          if (provisional) warnings.push("Report is incomplete or not a completed run; checks are inconclusive.")
        } catch (error) {
          warnings.push(`${error instanceof Error ? error.message : String(error)} Showing report analytics without an evaluation sweep.`)
        }
      } else warnings.push("No .eval selected. Showing report analytics without an evaluation sweep.")
      if (!report.output.trim()) warnings.push("The report is empty; there is no session evidence to evaluate.")
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(report.output))
      if (current !== request.current) return
      setDashboard({ name, report, metrics, checks, warnings, evalName, revision, digest: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") })
    } catch (error) {
      if (current === request.current) setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (current === request.current) { submitting.current = false; setLoading(false) }
    }
  }

  return <dialog ref={dialog} className={`analytics-dialog ${dashboard ? "analytics-wide" : ""}`} aria-labelledby="analytics-title" onCancel={onClose}>
    <header className="analytics-heading"><div><span className="eyebrow">READ-ONLY / EVALUATION</span><h2 id="analytics-title" ref={heading} tabIndex={-1}>{dashboard ? `Analytics: ${dashboard.name}` : "Which spec would you like to analyse?"}</h2></div><button type="button" onClick={onClose} aria-label="Close analytics">Close</button></header>
    {!dashboard ? <form className="analytics-select" onSubmit={(event) => void analyse(event)} aria-busy={loading}>
      <p>Review a saved spec's .out report. Analytics never reruns the spec or executes .eval instructions. Unsaved editor changes are not included.</p>
      <label htmlFor="analytics-spec">Spec to analyse</label>
      <select id="analytics-spec" required disabled={loading} value={name} onChange={(event) => {
        const name = event.target.value
        setName(name); setEvalName(files.includes(`${name}.eval`) ? `${name}.eval` : ""); setRunId(""); setSource(null); setError("")
      }}><option value="">Choose a saved spec</option>{specs.map((file) => <option key={file}>{file}</option>)}</select>
      {!loading && !specs.length && <p>No saved specs available. Save a spec before opening analytics.</p>}
      <label htmlFor="analytics-eval">Evaluation spec (.eval, optional)</label>
      <select id="analytics-eval" disabled={loading} value={evalName} onChange={(event) => setEvalName(event.target.value)}><option value="">Dashboard only</option>{files.filter((file) => file.endsWith(".eval")).map((file) => <option key={file}>{file}</option>)}</select>
      <p>Defaults to &lt;spec filename&gt;.eval when present. Only version 1 JSON with kind "eval" and a matching spec is accepted.</p>
      {!!source?.runs.length && <><label htmlFor="analytics-run">Retained run</label><select id="analytics-run" required disabled={loading} value={runId} onChange={(event) => setRunId(event.target.value)}><option value="">Choose a session report</option>{source.runs.map((run) => <option key={run.id} value={run.id}>{run.id} / {new Date(run.modified * 1000).toLocaleString()}</option>)}</select></>}
      {source?.warnings.map((warning, index) => <p key={index} role="alert" className="analytics-warning">{warning}</p>)}
      {source && !source.report && !source.runs.length && <p role="alert" className="analytics-warning">No report available. If this spec has never been run, run it first; otherwise check the output location or retained logs.</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <button className="primary" disabled={loading || !name}>{loading ? "Loading analytics..." : "Open analytics"}</button>
    </form> : <div className="analytics-dashboard">
      <div className="analytics-source"><p><strong>{dashboard.name}.out</strong><br />Run: {dashboard.report.id} / {dashboard.report.status}</p><button onClick={() => { setDashboard(null); setSource(null); setRunId("") }}>Choose another spec or run</button></div>
      {dashboard.warnings.length > 0 && <div className="analytics-warning" role="status">{dashboard.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
      <section aria-label="Evaluation results"><h3>Evaluation sweep</h3>
        {dashboard.checks.length ? <><div className="evaluation-summary">{["pass", "fail", "inconclusive"].map((status) => <div key={status}><strong>{dashboard.checks.filter((check) => check.status === status).length}</strong><span>{status}</span></div>)}</div>
          <div className="analytics-table"><table><caption>Checks from {dashboard.evalName}</caption><thead><tr><th>Check / metric</th><th>Observed</th><th>Target</th><th>Result</th></tr></thead><tbody>{dashboard.checks.map((check) => <tr key={check.name}><th>{check.name}<small>{check.aggregate}({check.metric})</small></th><td>{check.value === null ? "No data" : format(check.value)}</td><td>{check.operator} {format(check.threshold)}</td><td className={`eval-${check.status}`}>{check.status}</td></tr>)}</tbody></table></div></> : <p>No evaluation checks applied. Add a matching .eval to define a sweep; a successful process exit is not a quality score.</p>}
      </section>
      <section aria-label="Evaluation metric charts"><h3>Measured metrics</h3>{dashboard.metrics.metrics.length ? <div className="metric-grid">{dashboard.metrics.metrics.map((metric) => <Chart key={metric.name} metric={metric} />)}</div> : <p>No structured evaluation measurements found. Emit JSON lines with event "eval" and numeric "metrics" to chart quality, latency, cost or other measured values. No scores are inferred from prose.</p>}</section>
      <section aria-label="Report diagnostics"><h3>Report diagnostics</h3><p>Text counts only, not evaluation outcomes. Lines can contain both error and warning words.</p><svg className="diagnostic-chart" viewBox="0 0 700 120" role="img" aria-label={`${dashboard.metrics.lines} nonempty lines; ${dashboard.metrics.errors} error-word lines; ${dashboard.metrics.warnings} warning-word lines`}>
        {[['Nonempty lines', dashboard.metrics.lines], ['Error-word lines', dashboard.metrics.errors], ['Warning-word lines', dashboard.metrics.warnings]].map(([label, count], index) => <g key={label}><text x="0" y={25 + index * 35}>{label}</text><rect x="150" y={10 + index * 35} width={460 * Number(count) / Math.max(1, dashboard.metrics.lines)} height="20" /><text x="625" y={25 + index * 35}>{count}</text></g>)}
      </svg></section>
      <details><summary>Evidence and evaluator</summary><p>Evaluator: declarative v1. Measurements are unverified claims in this report, not independent proof of implementation. Checks cover extracted samples, not hidden reasoning or other sessions. Local snapshots have no verified terminal status.</p><p>Report text SHA-256: <code>{dashboard.digest}</code></p>{dashboard.revision && <p>Saved .eval revision: <code>{dashboard.revision}</code></p>}</details>
    </div>}
  </dialog>
}
