import { useEffect, useEffectEvent, useRef, useState } from "react"
import { LogOutput } from "./highlighting"
import { RecoveryNotice } from "./recovery-notice"
import type { Output } from "./tabs"

type Run = { id: string; name: string; status: string; kind: "build" | "repository-save" | "optimization" }
type RunOutput = Output & { continuable: boolean }
type Props = {
  open: boolean
  knownOutputs: RunOutput[]
  api: <T>(path: string, body?: unknown, method?: string, signal?: AbortSignal) => Promise<T>
  onOutput: (output: RunOutput) => void
  onClose: () => void
}

export function ActiveRuns({ open, knownOutputs, api, onOutput, onClose }: Props) {
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [listing, setListing] = useState(false)
  const [listError, setListError] = useState("")
  const [listVersion, setListVersion] = useState(0)
  const [selected, setSelected] = useState<Run | null>(null)
  const [output, setOutput] = useState<RunOutput | null>(null)
  const cache = useRef(new Map<string, RunOutput>())
  const [loading, setLoading] = useState(false)
  const [detailError, setDetailError] = useState("")
  const [detailVersion, setDetailVersion] = useState(0)
  const detailRequest = useRef<AbortController | null>(null)
  const stopRequest = useRef<AbortController | null>(null)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState("")

  const list = useEffectEvent((signal: AbortSignal) => api<Run[]>("/runs", undefined, "GET", signal))
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setListing(true)
    setListError("")
    void list(controller.signal).then((next) => {
      if (!controller.signal.aborted) setRuns(next)
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setListError(`Could not list active runs: ${error instanceof Error ? error.message : String(error)}. The repository guard remains in effect.`)
    }).finally(() => {
      if (!controller.signal.aborted) setListing(false)
    })
    return () => controller.abort()
  }, [open, listVersion])

  const read = useEffectEvent((id: string, signal: AbortSignal) => api<RunOutput>(`/runs/${encodeURIComponent(id)}`, undefined, "GET", signal))
  const latest = useEffectEvent((id: string) => knownOutputs.find((item) => item.id === id && !item.recoverable) ?? cache.current.get(id))
  const receive = useEffectEvent((next: RunOutput) => {
    const previous = latest(next.id)
    const result = previous && !previous.recoverable && next.recoverable ? previous : next.status.startsWith("unavailable") && previous
      ? { ...next, output: previous.output, truncated: previous.truncated }
      : next
    cache.current.set(result.id, result)
    setOutput(result)
    onOutput(result)
    return result
  })
  useEffect(() => {
    if (!open || !selected) return
    const id = selected.id
    const controller = new AbortController()
    detailRequest.current = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    setOutput(cache.current.get(id) ?? null)
    setDetailError("")
    async function check() {
      if (controller.signal.aborted) return
      setLoading(true)
      let delay = 2500
      let recoverable = true
      try {
        const next = await read(id, controller.signal)
        if (controller.signal.aborted) return
        if (next.id !== id) throw new Error("Run identity did not match the requested run")
        const result = receive(next)
        setDetailError("")
        recoverable = result.recoverable
        delay = result.status === "running" ? 650 : 2500
        if (!recoverable) setListVersion((version) => version + 1)
      } catch (error) {
        if (controller.signal.aborted) return
        setDetailError(`Could not check remote status: ${error instanceof Error ? error.message : String(error)}. Cached output is unchanged; unavailable status does not clear the repository guard.`)
        recoverable = latest(id)?.recoverable ?? true
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
          if (recoverable) timer = setTimeout(() => void check(), delay)
        }
      }
    }
    void check()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [open, selected?.id, detailVersion])

  useEffect(() => {
    setStopping(false)
    setStopError("")
    return () => { stopRequest.current?.abort(); stopRequest.current = null }
  }, [open, selected?.id])

  async function stop() {
    if (!selected || stopRequest.current) return
    if (!window.confirm(`Stop run ${selected.name} (${selected.id})? This requests cancellation of this repository run, even if its source file is unopened or deleted. Completion must still be checked.`)) return
    const controller = new AbortController()
    stopRequest.current = controller
    // A pre-cancellation status response must not overwrite the next status check.
    detailRequest.current?.abort()
    setStopping(true)
    setStopError("")
    try {
      await api(`/runs/${encodeURIComponent(selected.id)}/cancel`, {}, "POST", controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) setStopError(`Could not stop run: ${error instanceof Error ? error.message : String(error)}. The repository guard remains in effect.`)
    } finally {
      if (!controller.signal.aborted) {
        stopRequest.current = null
        setStopping(false)
        setDetailVersion((version) => version + 1)
      }
    }
  }

  if (!open) return null
  const current = knownOutputs.find((item) => item.id === selected?.id && !item.recoverable) ?? (output?.id === selected?.id ? output : null)
  return <section id="active-runs" className="active-runs" aria-labelledby="active-runs-heading">
    <div className="active-runs-heading"><h2 id="active-runs-heading">Active runs</h2><div><button onClick={() => setListVersion((version) => version + 1)}>Refresh list</button><button onClick={onClose}>Close active runs</button></div></div>
    <p>Loading output checks remote status; it does not prove completion. Unavailable or unresolved runs keep the repository guard in place. No files are opened, and no runs are retried or stopped automatically.</p>
    {listing && <p role="status">Listing active runs...</p>}
    {listError && <p role="alert" className="error">{listError}{runs && " Showing the last available list."}</p>}
    {runs?.length === 0 && !listing && !listError && <p>No active runs.</p>}
    <div className="active-runs-grid">
      {!!runs?.length && <ul className="active-runs-list" aria-label="Recoverable runs">{runs.map((run) => <li key={run.id}>
        <strong>{run.name}</strong><code>{run.id}</code><span>{run.status} / {run.kind}</span>
        <button aria-label={`Load output for ${run.name} (${run.id})`} aria-pressed={selected?.id === run.id} disabled={stopping && selected?.id === run.id} onClick={() => { setSelected(run); setDetailVersion((version) => version + 1) }}>Load output</button>
      </li>)}</ul>}
      {selected && <div className="active-run-detail" aria-label="Selected active run">
        <h3>{selected.name}</h3><p><code>{selected.id}</code> / {selected.kind} / {current?.status ?? selected.status}</p>
        <div className="active-run-actions"><button disabled={stopping} onClick={() => setDetailVersion((version) => version + 1)}>Check status</button>{(current?.recoverable ?? true) && <button disabled={stopping} onClick={() => void stop()}>{stopping ? "Stopping run..." : "Stop run"}</button>}</div>
        {loading && !stopping && <p role="status">Checking remote status...</p>}
        {detailError && <p role="alert" className="error">{detailError}</p>}
        {stopError && <p role="alert" className="error">{stopError}</p>}
        <p>{current && !current.recoverable ? "This run is terminal and no longer blocks the repository. Other active or unresolved runs may still block it. CLI success alone does not verify saved changes." : "Completion is not confirmed. This active or unresolved run still blocks the repository."}</p>
        {current?.status.startsWith("unavailable") && <p>Remote output is unavailable. Showing cached output, which may be incomplete.</p>}
        {current && <RecoveryNotice output={current} />}
        {current?.truncated && <p>Older output was truncated; showing the latest 256 KiB.</p>}
        <pre className="output" aria-label="Active run output">{current ? <LogOutput value={current.output} /> : "No output loaded yet."}</pre>
      </div>}
    </div>
  </section>
}
