import { useEffect, useEffectEvent, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { dirty, openTab, savedTab } from "./tabs"
import type { Document, Output as RunOutput, Tab } from "./tabs"
import { Editor } from "./editor"
import { Chat } from "./chat"
import { LogOutput } from "./highlighting"
import { Analytics } from "./analytics"
import { FeatureReview } from "./feature-review"
import { BuildProgress } from "./progress"
import { Settings } from "./settings"
import { ProjectPicker } from "./project-picker"
import { ActiveRuns } from "./active-runs"
import { RecoveryNotice } from "./recovery-notice"
import type { ProjectSearch } from "./project-picker"
import "./style.css"

type Entry = { name: string; modified: number; bytes: number }
type Repository = { connected: boolean; dirty: boolean; directory: string | null; model: string }
type Output = RunOutput & { continuable: boolean }
type RetainedRuns = { runs: { id: string; modified: number }[]; truncated: boolean }
type PerformanceRun = Pick<Output, "id" | "name" | "status">
type QueuedBuild = { parent_id: string; name: string; revision: string; status: "waiting" | "started" | "paused"; id?: string; reason?: string }
type ComputeruseRun = { id: string; name: string; status: string; output: string; truncated: boolean }
type ComputeruseStatus = { configured: boolean; local_path: string | null; remote_path: string | null; run: ComputeruseRun | null }
type SharedFile = { content: string; revision: string | null }
const chatName = new URLSearchParams(location.search).get("chat")

function App() {
  const [token, setToken] = useState(() => {
    const fragment = new URLSearchParams(location.hash.slice(1)).get("token")
    if (fragment) {
      sessionStorage.setItem("spec-token", fragment)
      history.replaceState(null, "", location.pathname + location.search)
    }
    return fragment ?? sessionStorage.getItem("spec-token") ?? ""
  })
  const [connected, setConnected] = useState(false)
  const [execution, setExecution] = useState(false)
  const [computeruseAvailable, setComputeruseAvailable] = useState(false)
  const [computeruse, setComputeruse] = useState<ComputeruseStatus | null>(null)
  const [computeruseError, setComputeruseError] = useState("")
  const computeruseVersion = useRef(0)
  const [sharedName, setSharedName] = useState("")
  const [sharedRevision, setSharedRevision] = useState<string | null>(null)
  const [completion, setCompletion] = useState(false)
  const [chat, setChat] = useState(false)
  const [realtime, setRealtime] = useState(false)
  const [azureRealtime, setAzureRealtime] = useState(false)
  const [complete, setComplete] = useState(true)
  const [files, setFiles] = useState<Entry[]>([])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState("")
  const navigation = useRef(0)
  const [section, setSection] = useState("history")
  const [query, setQuery] = useState("")
  const [filename, setFilename] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState<{ name: string; automatic: boolean } | null>(null)
  const submitting = useRef(false)
  const edited = useRef(new Set<string>())
  const autosaveBlocked = useRef(new Set<string>())
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus() && !document.hidden)
  const [repository, setRepository] = useState<Repository | null>(null)
  const [repositoryError, setRepositoryError] = useState("")
  const [outputs, setOutputs] = useState<Record<string, Output>>({})
  const [feedback, setFeedback] = useState<Record<string, string>>({})
  const [queuedFeedback, setQueuedFeedback] = useState<Record<string, { name: string; message: string; paused?: string }>>({})
  const queuedIds = useRef(new Set<string>())
  const stoppedIds = useRef(new Set<string>())
  const [queuedBuilds, setQueuedBuilds] = useState<QueuedBuild[] | null>(null)
  const [queueError, setQueueError] = useState("")
  const [queueRefresh, setQueueRefresh] = useState(0)
  const [optimization, setOptimization] = useState<Output | null>(null)
  const [performanceBusy, setPerformanceBusy] = useState(false)
  const performanceSubmitting = useRef(false)
  const [performanceRuns, setPerformanceRuns] = useState<PerformanceRun[] | null>(null)
  const [performanceListError, setPerformanceListError] = useState("")
  const [performanceError, setPerformanceError] = useState("")
  const [performanceRecovered, setPerformanceRecovered] = useState(false)
  const [performanceRefresh, setPerformanceRefresh] = useState(0)
  const performanceRecovery = useRef(0)
  const [performance, setPerformance] = useState(false)
  const [activeRuns, setActiveRuns] = useState(false)
  const activeRunsButton = useRef<HTMLButtonElement>(null)
  const [project, setProject] = useState("")
  const [projectSearching, setProjectSearching] = useState(false)
  const [useEditorSpec, setUseEditorSpec] = useState(false)
  const performanceButton = useRef<HTMLButtonElement>(null)
  const [analytics, setAnalytics] = useState(false)
  const [featureReview, setFeatureReview] = useState(false)
  const [settings, setSettings] = useState(false)
  const configRequest = useRef(0)
  const [outputView, setOutputView] = useState<"file" | "optimization">("file")
  const [loadingOutput, setLoadingOutput] = useState<{ id?: string } | null>(null)
  const [retained, setRetained] = useState<(RetainedRuns & { name: string; output?: Output; loading: boolean; listed: boolean }) | null>(null)
  const retainedRequest = useRef(0)
  const [follow, setFollow] = useState(true)
  const log = useRef<HTMLPreElement>(null)
  const chatWindows = useRef(new Map<Window, string>())
  const tab = tabs.find((item) => item.name === active)
  const sharing = !!tab && sharedName === tab.name
  const computeruseBlocked = !computeruse?.configured || !!computeruseError || computeruse.run?.status === "running"
  const fileOutput = outputs[active]
  const retainedView = outputView === "file" && retained?.name === active ? retained : null
  const historical = retainedView?.output
  const output = outputView === "optimization" ? optimization : historical ?? fileOutput
  const actionBusy = busy && !saving?.automatic
  const queuedEditorForFile = queuedBuilds?.some((item) => item.name === active && item.status !== "started") ?? false
  const canContinue = !!output && !historical && outputView === "file" && execution && !busy && !queuedEditorForFile && !queuedFeedback[output.id] && output.status === "completed" && !output.recoverable && output.continuable === true
  const canQueueFeedback = !!output && !historical && outputView === "file" && execution && !actionBusy && !queuedEditorForFile && !queuedFeedback[output.id] && !stoppedIds.current.has(output.id) && output.continuable === true && (output.status === "running" || (output.status === "completed" && !output.recoverable))
  const message = output ? feedback[output.id] ?? "" : ""
  const blockingRuns = Object.values(outputs).filter((item) => item.recoverable)
  const pendingRuns = blockingRuns.map((item) => item.id).join(",")
  const performanceBlockers = [...(performanceRuns ?? []).filter((run) => run.id !== optimization?.id), ...(optimization?.recoverable ? [optimization] : [])]
  const performanceBlocked = !performanceRecovered || performanceRuns === null || !!performanceListError || !!performanceBlockers.length
  const queuedForFile = queuedEditorForFile || Object.values(queuedFeedback).some((item) => item.name === active)
  const canQueueBuild = !!queuedBuilds && !queueError && !!fileOutput?.recoverable && fileOutput.continuable && !stoppedIds.current.has(fileOutput.id)

  async function api<T>(path: string, body?: unknown, method = "POST", signal?: AbortSignal): Promise<T> {
    // Every cancellation surface must revoke queued execution before any network I/O.
    if (body !== undefined && method === "POST" && /^\/runs\/[^/]+\/cancel$/.test(path)) {
      const id = path.split("/")[2]
      stoppedIds.current.add(id)
      setQueuedFeedback((items) => ({ ...items, ...(items[id] ? { [id]: { ...items[id], paused: "Stop requested. Queued feedback will not resume this run." } } : {}) }))
    }
    const response = await fetch(`/api${path}`, {
      method: body === undefined ? "GET" : method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    if (!response.ok) {
      const text = await response.text()
      const message = (() => {
        try { return (JSON.parse(text) as { error?: string }).error ?? text } catch { return text }
      })()
      throw Object.assign(new Error(message || `HTTP ${response.status}`), { status: response.status })
    }
    const result = await response.json()
    if (typeof result?.queue_error === "string") setError(`Stop requested, but queued build revocation could not be confirmed: ${result.queue_error}. Check the saved build queue before leaving.`)
    return result as T
  }

  function fail(error: unknown) {
    setError(error instanceof Error ? error.message : String(error))
  }

  async function refresh() {
    setFiles(await api<Entry[]>("/files"))
  }

  async function refreshConfig() {
    const request = ++configRequest.current
    const config = await api<{ execution: boolean; computeruse?: boolean; completion: boolean; chat: boolean; realtime: boolean; azureRealtime: boolean }>("/config")
    if (request !== configRequest.current) return
    setExecution(config.execution)
    setComputeruseAvailable(config.computeruse === true)
    setCompletion(config.completion)
    setChat(config.chat)
    setRealtime(config.realtime)
    setAzureRealtime(config.azureRealtime)
  }

  async function connect(event?: React.FormEvent) {
    event?.preventDefault()
    setError("")
    sessionStorage.setItem("spec-token", token)
    await refreshConfig()
    if (chatName) { setConnected(true); return }
    const entries = await api<Entry[]>("/files")
    setFiles(entries)
    let remembered: string | null = null
    try { remembered = localStorage.getItem("spec-active-file") } catch { /* Browser persistence is optional. */ }
    if (remembered && entries.some((file) => file.name === remembered)) {
      await open(remembered).catch(fail)
    }
    setConnected(true)
  }

  useEffect(() => { if (token) void connect().catch(fail) }, [])

  useEffect(() => {
    if (!connected || !computeruseAvailable || chatName) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      const version = computeruseVersion.current
      try {
        const status = await api<ComputeruseStatus>("/computeruse", undefined, "GET", controller.signal)
        if (controller.signal.aborted) return
        if (version === computeruseVersion.current) {
          setComputeruse(status)
          setComputeruseError("")
        }
      } catch (error) {
        if (controller.signal.aborted) return
        if (version === computeruseVersion.current) setComputeruseError(`Local callback status unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
      timer = setTimeout(() => void poll(), 1500)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [connected, computeruseAvailable, token])

  const refreshCapabilities = useEffectEvent(() => {
    void refreshConfig().catch(() => { /* Retain capabilities on transient focus refresh failures. */ })
  })
  useEffect(() => {
    if (!connected) return
    const focus = () => refreshCapabilities()
    window.addEventListener("focus", focus)
    return () => window.removeEventListener("focus", focus)
  }, [connected])

  useEffect(() => {
    const focus = () => setWindowFocused(document.hasFocus() && !document.hidden)
    const blur = () => setWindowFocused(false)
    window.addEventListener("focus", focus)
    window.addEventListener("blur", blur)
    document.addEventListener("visibilitychange", focus)
    return () => {
      window.removeEventListener("focus", focus)
      window.removeEventListener("blur", blur)
      document.removeEventListener("visibilitychange", focus)
    }
  }, [])

  const autosave = useEffectEvent(() => {
    if (!document.hasFocus() || document.hidden || !tab || !edited.current.has(tab.name) || autosaveBlocked.current.has(tab.name) || !dirty(tab)) return
    void save("file", true)
  })
  useEffect(() => {
    if (!connected || chatName || !windowFocused || settings || analytics || busy || !tab || !edited.current.has(tab.name) || autosaveBlocked.current.has(tab.name) || !dirty(tab)) return
    const timer = setTimeout(autosave, 500)
    return () => clearTimeout(timer)
  }, [connected, windowFocused, settings, analytics, busy, tab?.name, tab?.content, tab?.revision])

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.data?.type !== "spec-chat-request") return
      const source = event.source as Window | null
      if (!source) return
      // A workspace reload loses its window map; reconnect only its same-origin chat children.
      if (!chatWindows.current.has(source)) {
        try {
          if (source.opener !== window || source.location.origin !== location.origin || source.location.pathname !== location.pathname || new URLSearchParams(source.location.search).get("chat") !== event.data.name) return
          chatWindows.current.set(source, event.data.name)
        } catch { return }
      }
      if (chatWindows.current.get(source) !== event.data.name) return
      const tab = tabs.find((item) => item.name === event.data.name)
      source.postMessage({ type: "spec-chat-context", id: event.data.id, tab: tab ?? null }, location.origin)
    }
    window.addEventListener("message", receive)
    return () => window.removeEventListener("message", receive)
  }, [tabs])

  useEffect(() => {
    if (!connected || chatName) return
    // Remember only the selection, never unsaved buffers or runtime logs.
    try {
      if (tab?.revision) localStorage.setItem("spec-active-file", tab.name)
      else localStorage.removeItem("spec-active-file")
    } catch { /* Editing still works when browser storage is unavailable. */ }
  }, [connected, tab?.name, tab?.revision])

  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (!tabs.some(dirty) && !Object.keys(queuedFeedback).length) return
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", listener)
    return () => window.removeEventListener("beforeunload", listener)
  }, [tabs, queuedFeedback])

  useEffect(() => {
    // Let an explicit disk read finish without a poll invalidating its result.
    let cancelled = false
    const timers: ReturnType<typeof setTimeout>[] = []
    async function poll(output: Output) {
      try {
        const next = await api<Output>(`/runs/${output.id}`)
        if (cancelled) return
        setOutputs((items) => {
          const previous = items[next.name]
          if (previous?.id !== next.id) return items
          if (!previous.recoverable && next.recoverable) return items
          // Failed recovery can return an older cache than an explicit disk read.
          const output = next.status.startsWith("unavailable")
            ? { ...next, output: previous.output, truncated: previous.truncated }
            : next
          return { ...items, [next.name]: output }
        })
        if (next.recoverable) timers.push(setTimeout(() => void poll(next), next.status === "running" ? 650 : 2500))
      } catch (error) {
        if (cancelled) return
        setOutputs((items) => items[output.name]?.id === output.id
          ? { ...items, [output.name]: { ...items[output.name], transportUnavailable: true } }
          : items)
        fail(error)
        timers.push(setTimeout(() => void poll(output), 2500))
      }
    }
    // A background tab must not leave repository saving blocked by stale status.
    for (const item of Object.values(outputs)) {
      if (item.recoverable && loadingOutput?.id !== item.id) void poll(item)
    }
    return () => { cancelled = true; timers.forEach(clearTimeout) }
  }, [pendingRuns, loadingOutput, token])

  const associateQueuedBuilds = useEffectEvent(async (items: QueuedBuild[], signal: AbortSignal) => {
    for (const item of items) {
      if (item.status !== "started" || !item.id || outputs[item.name]?.id !== item.parent_id) continue
      // Read the latest association, not a stale queued child from an earlier build.
      const latest = await api<Output | null>(`/files/${encodeURIComponent(item.name)}/run`, undefined, "GET", signal)
      if (signal.aborted) return
      if (latest && latest.name === item.name && latest.id !== item.parent_id) {
        setOutputs((previous) => previous[item.name]?.id === item.parent_id ? { ...previous, [item.name]: latest } : previous)
      }
    }
  })
  useEffect(() => {
    if (!connected || chatName) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const items = await api<QueuedBuild[]>("/queued-builds", undefined, "GET", controller.signal)
        if (controller.signal.aborted) return
        setQueuedBuilds(items)
        await associateQueuedBuilds(items, controller.signal)
        if (!controller.signal.aborted) setQueueError("")
      } catch (error) {
        if (controller.signal.aborted) return
        setQueueError(`Could not check saved build queue: ${error instanceof Error ? error.message : String(error)}. Queued work may still execute; refresh before resubmitting.`)
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [connected, token, queueRefresh])

  const dispatchQueuedFeedback = useEffectEvent(() => {
    if (!connected || !execution || busy || submitting.current || settings || analytics) return
    for (const [id, queued] of Object.entries(queuedFeedback)) {
      if (queued.paused || !queuedIds.current.has(id) || stoppedIds.current.has(id)) continue
      if (queuedBuilds?.some((item) => item.name === queued.name && item.status !== "started")) continue
      const current = outputs[queued.name]
      if (!current || current.id !== id || (!current.recoverable && current.status !== "completed")) {
        setQueuedFeedback((items) => ({ ...items, [id]: { ...queued, paused: "The original run changed or did not complete successfully. Feedback was not sent." } }))
        continue
      }
      if (current.status === "completed" && !current.recoverable && !current.transportUnavailable && current.continuable) {
        void continueRun(queued.message, current)
        break
      }
    }
  })
  useEffect(() => { dispatchQueuedFeedback() }, [queuedFeedback, queuedBuilds, outputs, connected, execution, busy, settings, analytics])

  useEffect(() => {
    if (follow && log.current) log.current.scrollTop = log.current.scrollHeight
  }, [output?.output, follow])

  useEffect(() => {
    // Historical reads must not follow another tab or action; local autosaves preserve them.
    retainedRequest.current++
    setRetained(null)
  }, [active, fileOutput?.id, token, actionBusy])

  useEffect(() => {
    if (!connected || !execution || chatName || busy) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const next = await api<Repository>("/repository")
        if (cancelled) return
        setRepository(next)
        setRepositoryError("")
      } catch (error) {
        if (cancelled) return
        // Never offer a save based on stale repository state after a failed probe.
        setRepository(null)
        setRepositoryError(`Repository status unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!cancelled) timer = setTimeout(poll, 5000)
    }
    void poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [connected, execution, busy, fileOutput?.id, fileOutput?.status, token])

  async function recoverOutput(name: string, fromLog = false) {
    const previous = outputs[name]
    if (fromLog) { retainedRequest.current++; setRetained(null); setLoadingOutput({ id: previous?.id }); setError(""); setNotice("") }
    try {
      const latest = await api<Output | null>(`/files/${encodeURIComponent(name)}/run${fromLog ? "/log" : ""}`)
      // A slow recovery must not overwrite a newly started run or a fresher poll.
      if (latest) {
        // An earlier disk read may have shown more output than the server cached.
        const next = latest.status.startsWith("unavailable") && previous?.id === latest.id
          ? { ...latest, output: previous.output, truncated: previous.truncated }
          : latest
        setOutputs((items) => items[name] === previous ? { ...items, [name]: next } : items)
      }
      if (fromLog) {
        if (latest?.status.startsWith("unavailable")) fail(`Remote output for ${name} is ${latest.status}. Showing cached output, which may be incomplete. Browse retained runs to look for other logs without rerunning the spec.`)
        else setNotice(latest ? `Loaded ${name}.out` : `No saved run output for ${name}. Save & run to create one.`)
      }
    } catch (error) {
      fail(`Could not recover output for ${name}: ${error instanceof Error ? error.message : String(error)}.`)
    } finally {
      if (fromLog) setLoadingOutput(null)
    }
  }

  async function browseRetained(name: string, id?: string) {
    const request = ++retainedRequest.current
    setError("")
    setNotice("")
    setRetained((previous) => ({ ...(previous?.name === name ? previous : { name, runs: [], truncated: false, listed: false }), loading: true }))
    try {
      const path = `/files/${encodeURIComponent(name)}/retained-runs`
      if (id) {
        const loaded = await api<Output>(`${path}/${id}/log`)
        if (request !== retainedRequest.current) return
        setRetained((previous) => previous?.name === name ? { ...previous, output: loaded, loading: false } : previous)
      } else {
        const listed = await api<RetainedRuns>(path)
        if (request !== retainedRequest.current) return
        setRetained({ name, ...listed, loading: false, listed: true })
      }
    } catch (error) {
      if (request !== retainedRequest.current) return
      setRetained((previous) => previous ? { ...previous, loading: false } : previous)
      fail(`Could not load retained output for ${name}: ${error instanceof Error ? error.message : String(error)}. Existing output was not replaced.`)
    }
  }

  async function recoverOptimization(id?: string, signal?: AbortSignal) {
    const request = ++performanceRecovery.current
    try {
      const latest = await api<Output | null>(id ? `/performance/runs/${encodeURIComponent(id)}` : "/performance", undefined, "GET", signal)
      if (signal?.aborted || request !== performanceRecovery.current) return
      if (id && latest?.id !== id) throw new Error("Performance run identity did not match")
      setOptimization((item) => {
        if (!latest) return item
        if (item?.id === latest.id) {
          if (!item.recoverable && latest.recoverable) return item
          if (latest.status.startsWith("unavailable")) return { ...latest, output: item.output, truncated: item.truncated }
        }
        return latest
      })
      setPerformanceRecovered(true)
      setPerformanceError("")
      return latest
    } catch (error) {
      if (!signal?.aborted && request === performanceRecovery.current) setPerformanceError(`Could not recover Performance output: ${error instanceof Error ? error.message : String(error)}. Select Recover latest Performance to retry.`)
    }
  }

  const recoverPerformance = useEffectEvent((signal: AbortSignal) => recoverOptimization(undefined, signal))
  useEffect(() => {
    if (!connected || chatName) return
    const controller = new AbortController()
    void recoverPerformance(controller.signal).then((latest) => {
      if (!controller.signal.aborted && latest?.recoverable) setOutputView("optimization")
    })
    return () => controller.abort()
  }, [connected, token])

  useEffect(() => {
    if (!connected || !execution || chatName) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const runs = await api<PerformanceRun[]>("/performance/runs", undefined, "GET", controller.signal)
        if (controller.signal.aborted) return
        setPerformanceRuns(runs)
        setPerformanceListError("")
      } catch (error) {
        if (controller.signal.aborted) return
        setPerformanceListError(`Could not check Performance runs: ${error instanceof Error ? error.message : String(error)}`)
      }
      timer = setTimeout(() => void poll(), 2500)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [connected, execution, token, performanceRefresh])

  useEffect(() => {
    if (!optimization?.recoverable) return
    const id = optimization.id
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      let delay = 2500
      try {
        const next = await api<Output>(`/performance/runs/${encodeURIComponent(id)}`, undefined, "GET", controller.signal)
        if (controller.signal.aborted) return
        if (next.id !== id) throw new Error("Performance run identity did not match")
        setOptimization((item) => item?.id === id && item.recoverable
          ? next.status.startsWith("unavailable") ? { ...next, output: item.output, truncated: item.truncated } : next
          : item)
        if (!next.recoverable) { setPerformanceRefresh((value) => value + 1); return }
        delay = next.status === "running" ? 650 : 2500
      } catch (error) {
        if (controller.signal.aborted) return
        setOptimization((item) => item?.id === id ? { ...item, transportUnavailable: true } : item)
        setPerformanceError(`Performance polling failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      timer = setTimeout(() => void poll(), delay)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [optimization?.id, optimization?.recoverable, token])

  async function open(name: string) {
    const intent = ++navigation.current
    setError("")
    if (!tabs.some((item) => item.name === name)) {
      const document = await api<Document>(`/files/${encodeURIComponent(name)}`)
      setTabs((items) => openTab(items, document))
    }
    if (intent === navigation.current) setActive(name)
    void recoverOutput(name)
  }

  function selectTab(name: string) {
    navigation.current++
    setActive(name)
  }

  function create(event: React.FormEvent) {
    event.preventDefault()
    const name = filename.trim()
    if (!name || name.startsWith(".") || /[/\\:\x00-\x1f\x7f]/.test(name) || new TextEncoder().encode(name).length > 180) {
      setError("Choose a filename without directories, hidden names, or control characters (maximum 180 bytes).")
      return
    }
    if (files.some((file) => file.name === name)) { void open(name).catch(fail); setFilename(""); return }
    setTabs((items) => items.some((item) => item.name === name) ? items : [...items, { name, content: "", saved: "", revision: null }])
    selectTab(name)
    setFilename("")
    setError("")
  }

  function close(item: Tab) {
    if (saving?.name === item.name) return
    if (dirty(item) && !window.confirm(`Discard unsaved changes to ${item.name}?`)) return
    edited.current.delete(item.name)
    autosaveBlocked.current.delete(item.name)
    if (sharedName === item.name) setSharedName("")
    navigation.current++
    const remaining = tabs.filter((tab) => tab.name !== item.name)
    setTabs(remaining)
    if (active === item.name) setActive(remaining.at(-1)?.name ?? "")
  }

  async function save(mode: "file" | "build" | "queue" | "repository" | "share" | "computeruse" = "file", automatic = false, remoteRevision = sharedRevision) {
    const shared = mode === "share" || mode === "computeruse" || (mode === "file" && sharing && !automatic)
    if (settings || analytics || !tab || busy || submitting.current || (!shared && mode !== "file" && queuedForFile)) return
    if (shared && (!computeruseAvailable || !computeruse?.configured || (mode === "computeruse" && computeruseBlocked))) return
    const parent = mode === "queue" ? fileOutput : null
    if (mode === "queue" && (!parent || !canQueueBuild)) return
    submitting.current = true
    setBusy(true)
    setError("")
    setNotice(`Saving ${tab.name}...`)
    setSaving({ name: tab.name, automatic })
    let persisted = false
    try {
      const document = await api<Document>(`/files/${encodeURIComponent(tab.name)}`, { content: tab.content, revision: tab.revision }, "PUT")
      persisted = true
      autosaveBlocked.current.delete(tab.name)
      setTabs((items) => savedTab(items, document))
      setNotice(`Saved ${document.name}`)
      await refresh().catch(fail)
      if (shared) {
        const result = await api<SharedFile & { run?: ComputeruseRun }>(mode === "computeruse" ? "/computeruse/run" : "/computeruse/push", { name: document.name, revision: document.revision, remote_revision: remoteRevision })
        setSharedName(document.name)
        setSharedRevision(result.revision)
        if (result.run) {
          computeruseVersion.current++
          setComputeruse((status) => status ? { ...status, run: result.run! } : status)
        }
        setNotice(mode === "computeruse" ? `Shared ${document.name} and started the local computeruse callback. No remote spec build was submitted.` : `Shared ${document.name} with local and remote files. No callback executed.`)
        return
      }
      if (mode === "file") return
      if (parent) {
        const item = await api<QueuedBuild>(`/runs/${parent.id}/queued-build`, { name: document.name, revision: document.revision })
        setQueuedBuilds((items) => [...(items ?? []).filter((queued) => queued.parent_id !== item.parent_id), item])
        setNotice(`Saved and queued ${document.name}. This snapshot runs after confirmed successful finalization, even if this page closes. Later edits are not included.`)
        return
      }
      const job = await api<{ id: string }>(mode === "repository" ? "/repository/save" : "/runs", { name: document.name, revision: document.revision })
      setOutputs((items) => ({ ...items, [document.name]: { ...job, name: document.name, output: "Starting…", status: "running", truncated: false, recoverable: true, continuable: mode !== "repository" } }))
      setOutputView("file")
      if (mode === "repository") setNotice(`Repository save submitted to ${repository?.model ?? "azure/gpt-6-sol"}. Check Output & logs for the result.`)
    } catch (error) {
      if (!persisted) {
        // A conflict needs explicit resolution; never retry it on every keystroke.
        autosaveBlocked.current.add(tab.name)
        setNotice(`Autosave paused for ${tab.name}. Use Save to retry.`)
      }
      fail(automatic ? `Autosave failed for ${tab.name}: ${error instanceof Error ? error.message : String(error)}` : error)
    } finally { if (parent) setQueueRefresh((value) => value + 1); submitting.current = false; setSaving(null); setBusy(false) }
  }

  function requestBuild() {
    if (sharing) {
      if (settings || analytics || !tab || busy || submitting.current || computeruseBlocked) return
      if (window.confirm("Save this editor snapshot to the shared local and remote text files, then launch the configured computeruse callback on the server computer? It may send instructions and screenshots to a model, incur costs, and control the desktop if the operator enabled --execute. This does not run a remote spec build.")) void save("computeruse")
      return
    }
    if (settings || analytics || !tab || busy || submitting.current || !execution || queuedForFile || (fileOutput?.recoverable && !canQueueBuild)) return
    const queue = !!fileOutput?.recoverable
    const action = queue ? "Save and queue this editor snapshot for a fresh spec build after the current build finishes successfully? The queue survives page closure and server restart. Later saves do not replace this snapshot. Failure or Stop pauses the queue." : "Send this saved spec over SSH and run remote spec build?"
    if (window.confirm(`${action} Automatic tool approval is requested (SPEC_BUILD_AUTO=1), along with recommended answers to runtime questions. It can modify remote files, execute tools, access the network, and incur provider costs. The web server and editor files stay local.`)) void save(queue ? "queue" : "build")
  }

  async function toggleComputeruse() {
    if (busy || submitting.current || !tab) return
    if (sharing) { setSharedName(""); setNotice("Computeruse mode off. Existing callbacks are unchanged; use Stop computeruse to cancel."); return }
    if (!computeruse?.configured || !computeruseAvailable) return
    submitting.current = true
    setBusy(true)
    setSaving({ name: tab.name, automatic: false })
    setError("")
    let remote: SharedFile | undefined
    try {
      remote = await api<SharedFile>("/computeruse/file")
      if (!window.confirm(`Enable computeruse for ${tab.name} and save the editor to both shared files? ${remote.revision === null ? "The remote text file will be created." : "This replaces the current remote text. Cancel and use Reload remote if you want to import it instead."} No callback runs until Save & run. Autosave remains local to the editor.`)) remote = undefined
    } catch (error) { fail(error) }
    finally { submitting.current = false; setBusy(false); setSaving(null) }
    if (remote) await save("share", false, remote.revision)
  }

  async function pullComputeruse() {
    if (!tab || dirty(tab) || busy || submitting.current || !computeruse?.configured) return
    if (!window.confirm(`Replace saved ${tab.name} and the local shared file with the remote text? This does not run computeruse.`)) return
    submitting.current = true
    setBusy(true)
    setSaving({ name: tab.name, automatic: false })
    setError("")
    try {
      const document = await api<Document>("/computeruse/pull", { name: tab.name, revision: tab.revision })
      // A remote read must not discard text typed while the request was in flight.
      setTabs((items) => savedTab(items, document).map((item) => item.name === tab.name && item.content === tab.content ? { ...item, content: document.content } : item))
      setSharedRevision(document.revision)
      autosaveBlocked.current.delete(tab.name)
      setNotice(`Loaded remote text into ${document.name} and the local shared file. No callback executed.`)
      await refresh().catch(fail)
    } catch (error) { fail(error) }
    finally { submitting.current = false; setBusy(false); setSaving(null) }
  }

  async function stopComputeruse() {
    const run = computeruse?.run
    if (!run || run.status !== "running") return
    try {
      await api(`/computeruse/runs/${encodeURIComponent(run.id)}/cancel`, {})
      setNotice("Computeruse stop requested. Waiting for local process termination.")
    } catch (error) { fail(error) }
  }

  async function removeQueuedBuild(item: QueuedBuild) {
    if (busy || submitting.current) return
    submitting.current = true
    setBusy(true)
    try {
      await api(`/runs/${item.parent_id}/queued-build`, {}, "DELETE")
      setQueuedBuilds((items) => items?.filter((queued) => queued.parent_id !== item.parent_id) ?? null)
      setNotice(`Removed queued entry for ${item.name}. If dispatch already started, use Stop run to cancel its build.`)
    } catch (error) { fail(error) }
    finally { setQueueRefresh((value) => value + 1); submitting.current = false; setBusy(false) }
  }

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (settings || analytics || featureReview || !connected || chatName || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key !== "Enter") return
      const target = event.target as HTMLElement | null
      if (target?.closest("[inert]")) return
      if (target?.closest("input, textarea, [contenteditable=true]") && !target.matches(".editor-input textarea")) return
      event.preventDefault()
      requestBuild()
    }
    window.addEventListener("keydown", shortcut)
    return () => window.removeEventListener("keydown", shortcut)
  })

  function removeQueuedFeedback(id: string) {
    queuedIds.current.delete(id)
    setQueuedFeedback((items) => {
      const next = { ...items }
      delete next[id]
      return next
    })
  }

  function submitFeedback() {
    if (!output || queuedIds.current.has(output.id) || !message.trim() || message.includes("\0") || new TextEncoder().encode(message).length > 16 * 1024) return
    if (canContinue) { void continueRun(message); return }
    if (!canQueueFeedback || stoppedIds.current.has(output.id)) return
    queuedIds.current.add(output.id)
    setQueuedFeedback((items) => ({ ...items, [output.id]: { name: output.name, message } }))
    setFeedback((items) => ({ ...items, [output.id]: "" }))
    setNotice(`Feedback queued for ${output.name}. Keep this page open; it sends after confirmed completion.`)
  }

  async function continueRun(message?: string, queuedOutput?: Output) {
    const target = queuedOutput ?? output
    if ((!queuedOutput && !canContinue) || submitting.current || !target || busy || !execution) return
    if (queuedOutput && (!queuedIds.current.has(target.id) || stoppedIds.current.has(target.id))) return
    if (target.status !== "completed" || target.recoverable || !target.continuable || outputs[target.name]?.id !== target.id) return
    if (message !== undefined && (!message.trim() || message.includes("\0") || new TextEncoder().encode(message).length > 16 * 1024)) {
      setError("Feedback must be nonempty, without NUL bytes, and at most 16 KiB.")
      return
    }
    const { id, name } = target
    submitting.current = true
    setBusy(true)
    setError("")
    setNotice(`Submitting ${message === undefined ? "recommendation" : "feedback"} for ${name}...`)
    try {
      const job = await api<{ id: string }>(`/runs/${id}/continue`, message === undefined ? {} : { message })
      if (queuedOutput) removeQueuedFeedback(id)
      setOutputs((items) => ({ ...items, [name]: { ...job, name, output: "Starting...", status: "running", truncated: false, recoverable: true, continuable: true } }))
      if (message !== undefined) setFeedback((items) => {
        const next = { ...items }
        if (items[id] && (queuedOutput || items[id] !== message)) next[job.id] = items[id]
        delete next[id]
        return next
      })
      setFollow(true)
      setNotice(`${message === undefined ? "Recommended choice" : "Feedback"} submitted to the same session for ${name}. Check Output & logs for the result.`)
    } catch (error) {
      if (queuedOutput) setQueuedFeedback((items) => ({ ...items, [id]: { name, message: message!, paused: "Delivery failed or is unconfirmed. Check the associated run before resubmitting; automatic retry is disabled." } }))
      setNotice("")
      fail(error)
    } finally { submitting.current = false; setBusy(false) }
  }

  async function optimize() {
    if (settings || analytics || performanceBusy || performanceSubmitting.current || projectSearching || !execution || performanceBlocked) return
    setPerformanceError("")
    if (!project.trim() || project.includes("\0")) {
      setPerformanceError("Enter a project folder relative to the remote workspace or an absolute remote path, without NUL bytes.")
      return
    }
    if (useEditorSpec && !tab) {
      setPerformanceError("Select an editor tab to use as builder instructions, or uncheck Use current editor as instructions.")
      return
    }
    const spec = useEditorSpec && tab ? { name: tab.name, content: tab.content } : null
    if (spec) {
      if (!spec.content.trim() || spec.content.includes("\0") || new TextEncoder().encode(spec.content).length > 1024 * 1024) {
        setPerformanceError("Builder instructions must be nonempty, without NUL bytes, and at most 1 MiB.")
        return
      }
    }
    performanceSubmitting.current = true
    try {
      if (!window.confirm(`Run Gemma RL (built) for project ${project.trim()} through its own fresh builder session? ${spec ? `Use current editor builder instructions (${spec.name}). Unsaved editor changes are included; this does not save the file locally.` : "No editor content is sent; no editor tab is needed."} Run the existing built workflow only: no automatic rebuild, model or dataset download, or data fabrication. Authorize tools to inspect the project, execute the built workflow, and write artifacts; this can incur compute and provider costs. Spec runs are independent. Use Stop run in Performance output to stop this session only.`)) return
      setPerformanceBusy(true)
      const runs = await api<PerformanceRun[]>("/performance/runs")
      setPerformanceRuns(runs)
      if (runs.length) throw new Error("Performance is blocked by its own active or unresolved sessions. Load their output before launching another session.")
      const job = await api<{ id: string }>("/performance", { project: project.trim(), spec })
      performanceRecovery.current++
      setOptimization({ ...job, name: "Performance", output: "Starting Gemma RL (built)...", status: "running", truncated: false, recoverable: true, continuable: false })
      setOutputView("optimization")
      setFollow(true)
      setPerformance(false)
      setPerformanceRefresh((value) => value + 1)
    } catch (error) { setPerformanceError(error instanceof Error ? error.message : String(error)) } finally { performanceSubmitting.current = false; setPerformanceBusy(false) }
  }

  async function stopPerformance() {
    if (!optimization?.recoverable || performanceSubmitting.current) return
    performanceSubmitting.current = true
    setPerformanceBusy(true)
    setPerformanceError("")
    try {
      await api(`/performance/runs/${encodeURIComponent(optimization.id)}/cancel`, {})
      setPerformanceRefresh((value) => value + 1)
    } catch (error) { setPerformanceError(error instanceof Error ? error.message : String(error)) }
    finally { performanceSubmitting.current = false; setPerformanceBusy(false) }
  }

  function download() {
    if (!tab) return
    const url = URL.createObjectURL(new Blob([tab.content], { type: "text/plain;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = tab.name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function openChat() {
    if (!tab) return
    for (const [window, name] of chatWindows.current) {
      if (window.closed) chatWindows.current.delete(window)
      else if (name === tab.name) { window.focus(); return }
    }
    const url = new URL(location.pathname, location.origin)
    url.searchParams.set("chat", tab.name)
    const child = window.open(url, "_blank", "popup,width=960,height=900")
    if (child) chatWindows.current.set(child, tab.name)
    else setError("Allow popups for this site to open session chat in a separate window.")
  }

  if (!connected) return <main className="connect">
    <div className="brand"><span className="brand-mark">spec</span><span className="brand-caption">/ local workspace</span></div>
    <h1>A place to think.<br /><span className="rainbow-text">A space to build.</span></h1>
    <p>Connect to your Rust server. Your files stay on this machine.</p>
    <form onSubmit={(event) => void connect(event).catch(fail)}>
      <label htmlFor="token">Server access token</label>
      <input id="token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste the token from your terminal" required />
      <button className="primary">Open workspace →</button>
    </form>
    {error && <p role="alert" className="error">{error}</p>}
  </main>

  if (chatName) return <Chat name={chatName} api={api} available={chat} execution={execution} realtime={realtime} azureRealtime={azureRealtime} />

  return <div className="app">
    <header className="topbar"><div className="brand"><span className="brand-mark">spec</span><span className="brand-caption">/ {settings ? "settings" : "workspace"}</span></div><div className="topbar-actions"><div className="connection"><i /> Local · Rust + TypeScript</div>{optimization?.recoverable && <span className="badge">Performance: {optimization.status}</span>}<div className="analysis-actions">{execution && <button ref={activeRunsButton} aria-expanded={activeRuns} aria-controls="active-runs" onClick={() => setActiveRuns(!activeRuns)}>Active runs</button>}<button aria-current={settings ? "page" : undefined} onClick={() => setSettings(true)}>Settings</button><button title="analytics" disabled={settings} onClick={() => setAnalytics(true)}>Analytics</button><button ref={performanceButton} className="primary" title="performance" aria-expanded={performance && !settings} aria-controls="performance-form" disabled={settings} onClick={() => { if (!performance) setUseEditorSpec(false); setPerformance(!performance) }}>Performance</button></div></div></header>
    <ActiveRuns key={token} open={activeRuns && execution} api={api} knownOutputs={Object.values(outputs)} onClose={() => { setActiveRuns(false); activeRunsButton.current?.focus() }} onOutput={(next) => {
      // A delayed recoverable response cannot undo confirmed completion of the same run.
      const updated = (previous: Output) => !previous.recoverable && next.recoverable ? previous : next.status.startsWith("unavailable")
        ? { ...next, output: previous.output, truncated: previous.truncated }
        : next
      // Inspection never associates an unknown run or replaces an unrelated latest run.
      setOutputs((items) => Object.fromEntries(Object.entries(items).map(([name, previous]) => [name, previous.id === next.id ? updated(previous) : previous])))
    }} />
    {performance && !settings && <form id="performance-form" className="performance-form" aria-label="Performance builder" onSubmit={(event) => { event.preventDefault(); void optimize() }}>
      <h2>Run Gemma RL (built)</h2>
      <p id="performance-config">Run the existing built Gemma Reinforcement Learning workflow through its own fresh builder session, independent of spec runs. No editor tab is needed. No automatic rebuild, model or dataset download, or data fabrication. Tool execution can write artifacts and incur compute or provider costs; confirmation is required.</p>
      <p>Remote project safety checks still apply: conflicting harnesses in the same Git worktree or non-Git project cannot overlap.</p>
      <div id="performance-availability" aria-live="polite">
        {!execution ? <p>Remote execution is disabled. Configure SPEC_SSH_TARGET and SPEC_SSH_WORKSPACE on the backend and restart it to enable the builder. Opening Performance does not start a run.</p>
          : performanceBusy ? <p>A Performance request is in progress. Spec saving and running remain independent.</p>
          : performanceBlockers.length ? <p>Performance launch is blocked by its own active or unresolved sessions. Load their output to check completion or explicitly stop a Performance session. Spec runs do not block this action.</p>
          : performanceBlocked ? <p>Checking Performance recovery and active sessions. Unavailable Performance status must be resolved before launching.</p>
          : projectSearching ? <p>Wait for project search to finish before running Gemma RL.</p>
          : <p>Ready to run Gemma RL (built). Spec saving, active runs, and unknown spec status do not block Performance.</p>}
        {!!performanceBlockers.length && <ul aria-label="Performance blockers" style={{ overflowWrap: "anywhere" }}>{performanceBlockers.map((run) => <li key={run.id}><strong>{run.name}</strong> / <code>{run.id}</code> / {run.status} <button type="button" disabled={performanceBusy} onClick={() => { setOutputView("optimization"); void recoverOptimization(run.id) }}>Load Performance output for {run.id}</button></li>)}</ul>}
        {performanceListError && <p role="alert" className="error">{performanceListError}</p>}
      </div>
      <ProjectPicker value={project} onChange={setProject} disabled={performanceBusy || !execution} onSearchingChange={setProjectSearching} search={(query, signal) => api<ProjectSearch>("/projects/search", { query }, "POST", signal)} />
      <label className="performance-option"><input type="checkbox" checked={useEditorSpec} disabled={performanceBusy} onChange={(event) => setUseEditorSpec(event.target.checked)} aria-describedby="performance-spec" /> Use current editor as instructions</label>
      <p id="performance-spec">Optional builder instructions, any extension; JSON is not required. Unsaved content is included without saving locally (maximum 1 MiB).{useEditorSpec && <> Current editor: <strong>{tab?.name ?? "No tab selected"}</strong>.</>}</p>
      {performanceError && <div role="alert" className="error">{performanceError}</div>}
      <div className="performance-actions"><button type="submit" className="primary" aria-describedby="performance-availability" disabled={performanceBusy || projectSearching || !execution || performanceBlocked}>Run Gemma RL (built)</button>{execution && <button type="button" disabled={performanceBusy} onClick={() => setPerformanceRefresh((value) => value + 1)}>Refresh Performance runs</button>}<button type="button" disabled={performanceBusy} onClick={() => { setPerformance(false); performanceButton.current?.focus() }}>Cancel</button></div>
    </form>}
    {analytics && <Analytics api={api} active={active} onClose={() => setAnalytics(false)} />}
    {featureReview && <FeatureReview api={api} onClose={() => setFeatureReview(false)} />}
    {settings && <Settings api={api} onClose={() => setSettings(false)} onChanged={refreshConfig} />}
    <div className="workspace" hidden={settings} inert={settings}>
      <aside>
        <div className="sidebar-heading">YOUR WORKSPACE <button title="Refresh file list" aria-label="Refresh file list" onClick={() => void refresh().catch(fail)}>↻</button></div>
        <form className="new-file" onSubmit={create}>
          <input aria-label="New filename" placeholder="New file, e.g. idea.md" value={filename} onChange={(event) => setFilename(event.target.value)} required />
          <button aria-label="Create file" title="Create file">＋</button>
        </form>
        <div className="switcher" role="tablist" aria-label="File navigation" onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
          event.preventDefault()
          const next = event.key === "Home" ? "history" : event.key === "End" ? "tabs" : section === "history" ? "tabs" : "history"
          setSection(next)
          document.getElementById(`navigation-${next}`)?.focus()
        }}>
          <button id="navigation-history" role="tab" aria-controls="navigation-history-panel" tabIndex={section === "history" ? 0 : -1} aria-selected={section === "history"} onClick={() => setSection("history")}>Saved files</button>
          <button id="navigation-tabs" role="tab" aria-controls="navigation-tabs-panel" tabIndex={section === "tabs" ? 0 : -1} aria-selected={section === "tabs"} onClick={() => setSection("tabs")}>Open tabs ({tabs.length})</button>
        </div>
        <input className="search" aria-label="Filter files" placeholder="Filter files…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div id="navigation-history-panel" className="file-list" role="tabpanel" aria-labelledby="navigation-history" tabIndex={0} hidden={section !== "history"}>
          {files.filter((file) => file.name.toLowerCase().includes(query.toLowerCase())).map((file) => <button key={file.name} className={`file ${active === file.name ? "selected" : ""}`} onClick={() => void open(file.name).catch(fail)}><span>▤ <strong>{file.name}</strong></span><small>{new Date(file.modified).toLocaleString()} · {file.bytes} B</small></button>)}
          {!files.length && <p className="hint">Previously written files appear here after saving. This list persists across server restarts.</p>}
        </div>
        <div id="navigation-tabs-panel" className="file-list" role="tabpanel" aria-labelledby="navigation-tabs" tabIndex={0} hidden={section !== "tabs"}>
          {tabs.filter((item) => item.name.toLowerCase().includes(query.toLowerCase())).map((item) => <button key={item.name} className={`file ${active === item.name ? "selected" : ""}`} onClick={() => selectTab(item.name)}>{item.name}{dirty(item) ? " •" : ""}</button>)}
        </div>
        <div className="sidebar-footer">One workspace. Many ideas.<br /><span>Files are saved locally, not in the browser.</span></div>
      </aside>
      <main className="editor-area">
        <nav className="editor-tabs" aria-label="Editor tabs">
          {tabs.map((item) => <div className={`editor-tab ${item.name === active ? "active" : ""}`} key={item.name}>
            <button onClick={() => selectTab(item.name)} aria-current={item.name === active ? "page" : undefined}>{item.name}{dirty(item) ? " •" : ""}</button>
            <button className="close" aria-label={`Close ${item.name}`} disabled={saving?.name === item.name} onClick={() => close(item)}>×</button>
          </div>)}
          {!tabs.length && <span className="empty-tabs">Open a saved file or create something new</span>}
        </nav>
        {error && <div role="alert" className="error">{error}<button aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
        {performanceError && !performance && <div role="alert" className="error">{performanceError}<button aria-label="Dismiss Performance error" onClick={() => setPerformanceError("")}>×</button></div>}
        <div className="panes">
          <section className="editor-pane" aria-label="Spec editing pane">
            <div className="pane-heading"><div><span className="eyebrow">01 / SPEC</span><h2>{tab?.name ?? "Your next idea"}</h2></div><span className="badge">{tab ? dirty(tab) ? "Unsaved" : "Saved" : "Editor"}</span></div>
            {tabs.map((editor) => <Editor key={editor.name} active={!settings && editor.name === active} name={editor.name} value={editor.content} token={token} available={completion} enabled={complete} onEnabled={setComplete} onSave={() => void save()} onChange={(content) => {
              if (content !== editor.content) edited.current.add(editor.name)
              setTabs((items) => items.map((item) => item.name === editor.name ? { ...item, content } : item))
            }} />)}
            {!tab && <div className="empty-editor"><span aria-hidden="true">✳</span><h2>Start with a spec.</h2><p>Create a file on the left, describe your idea,<br />then save it when you're ready.</p></div>}
            <footer className="toolbar"><span>{tab ? `${tab.content.split("\n").length} lines · ${new TextEncoder().encode(tab.content).length} bytes` : "UTF-8"}</span><div><button disabled={!tab} onClick={download}>Download</button><button aria-pressed={sharing} disabled={!tab || busy || (!sharing && (!computeruseAvailable || !computeruse?.configured))} title={computeruseAvailable ? "Toggle shared-file mode; enabling saves without running" : "Configure SPEC_COMPUTERUSE_LOCAL_FILE, SPEC_COMPUTERUSE_REMOTE_FILE and SPEC_COMPUTERUSE_COMMAND on the local server"} onClick={() => void toggleComputeruse()}>Computeruse: {sharing ? "on" : "off"}</button><button disabled={!tab || busy} onClick={() => void save()}>Save</button><button className="primary" disabled={!tab || busy || (sharing ? computeruseBlocked : !execution || queuedForFile || (!!fileOutput?.recoverable && !canQueueBuild))} title={sharing ? "Save & run: local computeruse callback (Ctrl/Cmd+Enter)" : fileOutput?.recoverable ? "Save & run: queue snapshot until successful finalization (Ctrl/Cmd+Enter)" : "Save & run (Ctrl/Cmd+Enter)"} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={requestBuild}>Save & run ↗</button></div></footer>
            {computeruseAvailable && <section className="computeruse-panel" aria-label="Computeruse shared files">
              <strong>{sharing ? `Computeruse mode: ${sharedName}` : "Computeruse shared files"}</strong>
              <p>Save &amp; run targets {sharing ? "the local computeruse callback" : "remote spec build"}. Enabling saves to the shared files without executing. Autosave only updates the editor file. Mode resets on page reload.</p>
              <p>Local (server): <code>{computeruse?.local_path ?? "Checking..."}</code><br />Remote: <code>{computeruse?.remote_path ?? "Checking..."}</code></p>
              {sharedName && !sharing && <p>Shared mode belongs to {sharedName}, not this tab.</p>}
              <button disabled={!tab || dirty(tab) || busy || !computeruse?.configured} title="Save local edits first, or download them before resolving a conflict" onClick={() => void pullComputeruse()}>Reload remote</button>
              {computeruseError && <p role="alert">{computeruseError}</p>}
              {computeruse?.run && <><p aria-live="polite">Local callback / {computeruse.run.name} / {computeruse.run.status}</p>{computeruse.run.status === "running" && <button onClick={() => void stopComputeruse()}>Stop computeruse</button>}{computeruse.run.truncated && <p>Older callback output was truncated.</p>}<pre aria-label="Computeruse output"><LogOutput value={computeruse.run.output} /></pre></>}
            </section>}
            {!sharing && fileOutput?.recoverable && <p className="hint">Save &amp; run queues the saved editor snapshot until this build finishes successfully. Save and autosave never schedule execution.</p>}
            {(!!queuedBuilds?.length || !!queueError) && <section className="build-feedback chat-composer" aria-label="Saved build queue">
              <strong>Saved build queue</strong>
              <span>Snapshots are stored on the server and survive closing this page. One per parent run. Later saves do not change them.</span>
              {queueError && <p>{queueError}</p>}
              {queuedBuilds?.map((item) => <div key={item.parent_id}>
                <strong>{item.name}</strong>
                <p style={{ overflowWrap: "anywhere" }}>Revision <code>{item.revision.slice(0, 12)}</code> / {item.status}{item.reason ? `: ${item.reason}` : item.status === "waiting" ? ": waiting for successful finalization and no conflicting runs" : ""}</p>
                {item.id && <p style={{ overflowWrap: "anywhere" }}>Build: <code>{item.id}</code></p>}
                <button disabled={busy} onClick={() => void removeQueuedBuild(item)}>{item.status === "waiting" ? "Cancel queued build" : "Dismiss queued build"} for {item.name}</button>
              </div>)}
              <button disabled={busy} onClick={() => setQueueRefresh((value) => value + 1)}>Refresh saved build queue</button>
            </section>}
            {execution && <div className="repository-controls">
              <span>{repositoryError || (repository?.connected ? `${repository.directory} / ${repository.dirty ? "Uncommitted changes" : "No uncommitted changes"}` : repository ? "No repository connected in the remote directory." : "Checking remote repository...")}</span>
              {repository?.connected && repository.dirty && <button disabled={!tab?.content.trim() || busy || queuedForFile || !!pendingRuns} title={`Use ${repository.model} with the existing repository workflow`} onClick={() => {
                if (window.confirm(`Save edited repository changes in ${repository.directory} using ${repository.model}? This saves the current spec as context, then runs the existing repository workflow with automatic tool approval. It authorizes focused commits, but no push, and can execute tools and incur provider costs. Wait for harness completion in Output & logs and review its reported result.`)) void save("repository")
              }}>Save repo changes</button>}
            </div>}
          </section>
          <section className="output-pane" aria-label="Output and logs pane">
            <div className="pane-heading"><div><span className="eyebrow">02 / OUTPUT</span><h2>Output & logs</h2></div><span className="badge">{output?.transportUnavailable ? `${output.status} (connection unavailable)` : output?.status ?? "Idle"}</span></div>
            <div className="output-selector" role="group" aria-label="Output view"><button aria-pressed={outputView === "file"} onClick={() => setOutputView("file")}>Current file{tab ? `: ${tab.name}` : " output"}</button><button aria-pressed={outputView === "optimization"} disabled={!optimization && !execution} onClick={() => {
              setOutputView("optimization")
              if (!optimization) void recoverOptimization()
            }}>Performance output</button><button onClick={() => setFeatureReview(true)}>Feature review</button></div>
            {outputView === "optimization" && <div className="output-controls"><button disabled={performanceBusy} onClick={() => { void recoverOptimization(); setPerformanceRefresh((value) => value + 1) }}>Recover latest Performance</button></div>}
            {tab && outputView === "file" && <div className="chat-launch"><button onClick={openChat}>Open session chat</button><span>{historical ? "Chat uses the associated run, not this retained log" : "Spec + current nohup output in a separate window"}</span></div>}
            <div className="output-controls"><label><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /> Follow output</label>{outputView === "file" && tab?.revision && <><button disabled={!!loadingOutput || !execution} title={`Read ${tab.name}.out from the latest remote background run`} onClick={() => void recoverOutput(tab.name, true)}>{loadingOutput ? "Loading output..." : "Load nohup output"}</button><button disabled={!!loadingOutput || !!retainedView?.loading || busy || !execution} onClick={() => void browseRetained(tab.name)}>Browse retained runs</button></>}{!historical && output?.recoverable && execution && <button disabled={outputView === "optimization" && performanceBusy} onClick={() => outputView === "optimization" ? void stopPerformance() : void api(`/runs/${output.id}/cancel`, {}).catch(fail)}>Stop run</button>}{output && outputView === "file" && <button disabled={!canContinue} title="Submits the recommended choice to the same build session immediately, with automatic tool approval. Can modify files, execute tools, access the network, and incur provider costs. Does not save or upload editor changes." onClick={() => void continueRun()}>Use recommended &amp; continue</button>}</div>
            {!!Object.keys(queuedFeedback).length && <section className="build-feedback chat-composer" aria-label="Queued follow-ups">
              <strong>Queued follow-ups</strong>
              <span>Keep this page open. One follow-up per run; sent after confirmed completion, not as live input. Cancel to replace.</span>
              {Object.entries(queuedFeedback).map(([id, queued]) => <div key={id}>
                <strong>{queued.name}</strong>
                <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{queued.message}</pre>
                <p>{queued.paused ?? "Waiting to send to the same session with automatic tool approval. Can modify files and incur provider costs."}</p>
                <button type="button" disabled={actionBusy} onClick={() => removeQueuedFeedback(id)}>Cancel queued follow-up for {queued.name}</button>
              </div>)}
            </section>}
            {retainedView && <div className="retained-runs" aria-label="Retained run selection" aria-busy={retainedView.loading}>
              <label htmlFor="retained-run">Retained runs for {retainedView.name} (log updated)</label>
              <select id="retained-run" value={historical?.id ?? ""} disabled={retainedView.loading || !retainedView.runs.length} onChange={(event) => { if (event.target.value) void browseRetained(retainedView.name, event.target.value) }}>
                <option value="">Choose a run to view</option>
                {retainedView.runs.map((run) => <option key={run.id} value={run.id}>{run.id} / {new Date(run.modified * 1000).toLocaleString()}</option>)}
              </select>
              {retainedView.loading ? <p>Loading retained output...</p> : !retainedView.listed ? <p>Retained-run search did not complete. Retry Browse retained runs.</p> : !retainedView.runs.length && <p>No matching retained logs found. Missing logs cannot be recreated by retrying recovery.</p>}
              {retainedView.truncated && <p>Search limit reached. This list is incomplete and may omit newer runs.</p>}
              {historical && <p>Read-only snapshot from run <code>{historical.id}</code>. {fileOutput ? <>This does not replace or resolve the associated run <code>{fileOutput.id}</code> ({fileOutput.status}).</> : "No run is associated with this file."} It may have used different instructions.</p>}
              <button onClick={() => { retainedRequest.current++; setRetained(null) }}>Return to associated output</button>
            </div>}
            {!historical && outputView === "file" && output?.continuable && <BuildProgress key={output.id} output={output} />}
            {output && <RecoveryNotice output={output} />}
            {output?.truncated && <p className="hint">Older output was truncated; showing the latest 256 KiB.</p>}
            <pre ref={log} className="output" aria-label="Run output">{output ? <LogOutput value={output.output} /> : (outputView === "optimization" ? "No Performance output loaded. Select Recover latest Performance to retry recovery. To run Gemma RL (built) through its own fresh builder session, click Performance and enter a project folder relative to the remote workspace or an absolute remote path. No editor tab is needed. Optional editor content is builder instructions, not necessarily JSON, and is sent without saving locally. No automatic rebuild, model or dataset download, or data fabrication. Performance runs and cancellation are independent of spec runs." : execution ? "Remote spec build is ready.\n\nSave & run sends the saved snapshot over SSH. The web server stays local. Remote output and logs appear here.\n\nEach file has its own output view." : "Remote execution is disabled.\n\nSet SPEC_SSH_TARGET (user@host) and SPEC_SSH_WORKSPACE (absolute remote build directory) on the local Rust server, then restart it. Optionally set SPEC_SSH_KEY to a local private-key path. The remote shell must define spec in ~/.bash_aliases or PATH.\n\nEditing and saving work without a model or credentials.")}</pre>
            {!historical && output && outputView === "file" && output.continuable === true && <form className="chat-composer build-feedback" onSubmit={(event) => { event.preventDefault(); submitFeedback() }}>
              <label htmlFor="build-feedback">Feedback to build session</label>
              <textarea id="build-feedback" aria-describedby="feedback-help feedback-limit feedback-shortcuts" placeholder="Answer the agent or explain what to change..." value={message} disabled={actionBusy} onChange={(event) => setFeedback((items) => ({ ...items, [output.id]: event.target.value }))} onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing || event.keyCode === 229) return
                event.preventDefault()
                if (!event.repeat) event.currentTarget.form?.requestSubmit()
              }} />
              <span id="feedback-shortcuts">Enter to send. Shift+Enter for a new line.</span>
              <span id="feedback-limit">{new TextEncoder().encode(message).length.toLocaleString()} / 16,384 bytes</span>
              <div><span id="feedback-help">{queuedFeedback[output.id] ? "A follow-up is already queued for this run. Cancel it to submit a replacement." : canContinue ? "Continues the same session with automatic tool approval. Can modify files and incur provider costs. Editor changes are not sent." : canQueueFeedback ? "Queues for the same session after confirmed completion. Keep this page open. Automatic tool approval can modify files and incur provider costs. Editor changes are not sent." : "Waiting for a supported run. Stopped, failed and unconfirmed runs cannot be continued."}</span><button className="primary" disabled={(!canContinue && !canQueueFeedback) || !message.trim() || message.includes("\0") || new TextEncoder().encode(message).length > 16 * 1024}>{output.status === "running" ? "Queue follow-up" : "Send & continue"}</button></div>
            </form>}
            <footer className="output-footer">{output && <span>Harness: {output.status}{output.recoverable ? " (completion not confirmed)" : ""}. CLI success alone does not verify saved changes.<br /></span>}Available output only. No hidden model reasoning is requested.</footer>
          </section>
        </div>
        <div className="statusbar"><span role="status">{notice || "Ready"}</span><span id="editor-shortcuts">/ toggle completed (outside fenced code); Alt+/ type /</span><span>Autosave after 500 ms in focused window · Ctrl/Cmd+S save · Ctrl/Cmd+Enter save &amp; run · 2 MiB file limit</span></div>
      </main>
    </div>
  </div>
}

createRoot(document.getElementById("root")!).render(<App />)
