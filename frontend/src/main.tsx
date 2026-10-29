import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { dirty, openTab, savedTab } from "./tabs"
import type { Document, Output as RunOutput, Tab } from "./tabs"
import { Editor } from "./editor"
import { Chat } from "./chat"
import { LogOutput } from "./highlighting"
import { Analytics } from "./analytics"
import { BuildProgress } from "./progress"
import "./style.css"

type Entry = { name: string; modified: number; bytes: number }
type Repository = { connected: boolean; dirty: boolean; directory: string | null; model: string }
type Output = RunOutput & { continuable: boolean }
type RetainedRuns = { runs: { id: string; modified: number }[]; truncated: boolean }
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
  const submitting = useRef(false)
  const [repository, setRepository] = useState<Repository | null>(null)
  const [repositoryError, setRepositoryError] = useState("")
  const [outputs, setOutputs] = useState<Record<string, Output>>({})
  const [feedback, setFeedback] = useState<Record<string, string>>({})
  const [optimization, setOptimization] = useState<Output | null>(null)
  const [analytics, setAnalytics] = useState(false)
  const [outputView, setOutputView] = useState<"file" | "optimization">("file")
  const [loadingOutput, setLoadingOutput] = useState<{ id?: string } | null>(null)
  const [retained, setRetained] = useState<(RetainedRuns & { name: string; output?: Output; loading: boolean; listed: boolean }) | null>(null)
  const retainedRequest = useRef(0)
  const [follow, setFollow] = useState(true)
  const log = useRef<HTMLPreElement>(null)
  const chatWindows = useRef(new Map<Window, string>())
  const tab = tabs.find((item) => item.name === active)
  const fileOutput = outputs[active]
  const retainedView = outputView === "file" && retained?.name === active ? retained : null
  const historical = retainedView?.output
  const output = outputView === "optimization" ? optimization : historical ?? fileOutput
  const canContinue = !!output && !historical && outputView === "file" && execution && !busy && !optimization?.recoverable && output.status === "completed" && !output.recoverable && output.continuable === true
  const message = output ? feedback[output.id] ?? "" : ""
  const pendingRuns = [...Object.values(outputs), ...(optimization ? [optimization] : [])].filter((item) => item.recoverable).map((item) => item.id).join(",")

  async function api<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
    const response = await fetch(`/api${path}`, {
      method: body === undefined ? "GET" : method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      const text = await response.text()
      const message = (() => {
        try { return (JSON.parse(text) as { error?: string }).error ?? text } catch { return text }
      })()
      throw Object.assign(new Error(message || `HTTP ${response.status}`), { status: response.status })
    }
    return response.json() as Promise<T>
  }

  function fail(error: unknown) {
    setError(error instanceof Error ? error.message : String(error))
  }

  async function refresh() {
    setFiles(await api<Entry[]>("/files"))
  }

  async function connect(event?: React.FormEvent) {
    event?.preventDefault()
    setError("")
    sessionStorage.setItem("spec-token", token)
    const config = await api<{ execution: boolean; completion: boolean; chat: boolean; realtime: boolean; azureRealtime: boolean }>("/config")
    setExecution(config.execution)
    setCompletion(config.completion)
    setChat(config.chat)
    setRealtime(config.realtime)
    setAzureRealtime(config.azureRealtime)
    if (chatName) { setConnected(true); return }
    const entries = await api<Entry[]>("/files")
    setFiles(entries)
    let remembered: string | null = null
    try { remembered = localStorage.getItem("spec-active-file") } catch { /* Browser persistence is optional. */ }
    if (remembered && entries.some((file) => file.name === remembered)) {
      await open(remembered).catch(fail)
    }
    try {
      const latest = await recoverOptimization()
      if (latest?.recoverable) setOutputView("optimization")
    } catch (error) {
      fail(`Could not recover optimization output: ${error instanceof Error ? error.message : String(error)}. Select Optimization to retry.`)
    }
    setConnected(true)
  }

  useEffect(() => { if (token) void connect().catch(fail) }, [])

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
      if (!tabs.some(dirty)) return
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", listener)
    return () => window.removeEventListener("beforeunload", listener)
  }, [tabs])

  useEffect(() => {
    // Let an explicit disk read finish without a poll invalidating its result.
    let cancelled = false
    const timers: ReturnType<typeof setTimeout>[] = []
    async function poll(output: Output, optimizer = false) {
      try {
        const next = await api<Output>(`/runs/${output.id}`)
        if (cancelled) return
        if (optimizer) setOptimization((item) => item?.id === next.id ? next : item)
        else setOutputs((items) => {
          const previous = items[next.name]
          if (previous?.id !== next.id) return items
          // Failed recovery can return an older cache than an explicit disk read.
          const output = next.status.startsWith("unavailable")
            ? { ...next, output: previous.output, truncated: previous.truncated }
            : next
          return { ...items, [next.name]: output }
        })
        if (next.recoverable) timers.push(setTimeout(() => void poll(next, optimizer), next.status === "running" ? 650 : 2500))
      } catch (error) {
        if (cancelled) return
        if (optimizer) setOptimization((item) => item?.id === output.id ? { ...item, transportUnavailable: true } : item)
        else setOutputs((items) => items[output.name]?.id === output.id
          ? { ...items, [output.name]: { ...items[output.name], transportUnavailable: true } }
          : items)
        fail(error)
        timers.push(setTimeout(() => void poll(output, optimizer), 2500))
      }
    }
    // A background tab must not leave repository saving blocked by stale status.
    for (const item of Object.values(outputs)) {
      if (item.recoverable && loadingOutput?.id !== item.id) void poll(item)
    }
    if (optimization?.recoverable) void poll(optimization, true)
    return () => { cancelled = true; timers.forEach(clearTimeout) }
  }, [pendingRuns, loadingOutput, token])

  useEffect(() => {
    if (follow && log.current) log.current.scrollTop = log.current.scrollHeight
  }, [output?.output, follow])

  useEffect(() => {
    // Historical reads must not replace a new run or follow the user to another tab.
    retainedRequest.current++
    setRetained(null)
  }, [active, fileOutput?.id, token, busy])

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
  }, [connected, execution, busy, output?.id, output?.status, token])

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

  async function recoverOptimization() {
    const previous = optimization
    const latest = await api<Output | null>("/optimize")
    setOptimization((item) => item === previous ? latest : item)
    return latest
  }

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
    if (dirty(item) && !window.confirm(`Discard unsaved changes to ${item.name}?`)) return
    navigation.current++
    const remaining = tabs.filter((tab) => tab.name !== item.name)
    setTabs(remaining)
    if (active === item.name) setActive(remaining.at(-1)?.name ?? "")
  }

  async function save(mode: "file" | "build" | "repository" = "file") {
    if (analytics || !tab || busy || submitting.current || (mode !== "file" && optimization?.recoverable)) return
    submitting.current = true
    setBusy(true)
    setError("")
    try {
      const document = await api<Document>(`/files/${encodeURIComponent(tab.name)}`, { content: tab.content, revision: tab.revision }, "PUT")
      setTabs((items) => savedTab(items, document))
      setNotice(`Saved ${document.name}`)
      await refresh()
      if (mode === "file") return
      const job = await api<{ id: string }>(mode === "repository" ? "/repository/save" : "/runs", { name: document.name, revision: document.revision })
      setOutputs((items) => ({ ...items, [document.name]: { ...job, name: document.name, output: "Starting…", status: "running", truncated: false, recoverable: true, continuable: mode !== "repository" } }))
      setOutputView("file")
      if (mode === "repository") setNotice(`Repository save submitted to ${repository?.model ?? "azure/gpt-6-sol"}. Check Output & logs for the result.`)
    } catch (error) { fail(error) } finally { submitting.current = false; setBusy(false) }
  }

  function requestBuild() {
    if (analytics || !tab || busy || submitting.current || !execution || fileOutput?.recoverable || optimization?.recoverable) return
    if (window.confirm("Send this saved spec over SSH and run remote spec build? Automatic tool approval is requested (SPEC_BUILD_AUTO=1), along with recommended answers to runtime questions. It can modify remote files, execute tools, access the network, and incur provider costs. The web server and editor files stay local.")) void save("build")
  }

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (analytics || !connected || chatName || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key !== "Enter") return
      const target = event.target as HTMLElement | null
      if (target?.closest("[inert]")) return
      if (target?.closest("input, textarea, [contenteditable=true]") && !target.matches(".editor-input textarea")) return
      event.preventDefault()
      requestBuild()
    }
    window.addEventListener("keydown", shortcut)
    return () => window.removeEventListener("keydown", shortcut)
  })

  async function continueRun(message?: string) {
    if (!canContinue || submitting.current || !output) return
    if (message !== undefined && (!message.trim() || message.includes("\0") || new TextEncoder().encode(message).length > 16 * 1024)) {
      setError("Feedback must be nonempty, without NUL bytes, and at most 16 KiB.")
      return
    }
    const { id, name } = output
    submitting.current = true
    setBusy(true)
    setError("")
    setNotice(`Submitting ${message === undefined ? "recommendation" : "feedback"} for ${name}...`)
    try {
      const job = await api<{ id: string }>(`/runs/${id}/continue`, message === undefined ? {} : { message })
      setOutputs((items) => ({ ...items, [name]: { ...job, name, output: "Starting...", status: "running", truncated: false, recoverable: true, continuable: true } }))
      if (message !== undefined) setFeedback((items) => {
        if (items[id] !== message) return items
        const next = { ...items }
        delete next[id]
        return next
      })
      setFollow(true)
      setNotice(`${message === undefined ? "Recommended choice" : "Feedback"} submitted to the same session for ${name}. Check Output & logs for the result.`)
    } catch (error) { setNotice(""); fail(error) } finally { submitting.current = false; setBusy(false) }
  }

  async function optimize() {
    if (busy || submitting.current || !execution || pendingRuns) return
    if (!tab || !tab.name.endsWith(".optim") || !tab.content.trim()) {
      setNotice("")
      setError("Open or create a file with a name ending in .optim, enter your optimization instructions, and select that tab before clicking Performance.")
      return
    }
    submitting.current = true
    try {
      if (!window.confirm(`Upload the current .optim editor buffer (${tab.name}) to remote ~/projects and run optimization using its absolute remote path? Unsaved editor changes are included; this does not save the file locally. Only run trusted .optim commands or prose instructions. Prose mode sends project context to model providers and uses OpenCode builder and review tools. Both modes can modify files, execute tools, access the network, and incur provider costs. The optimizer loops until convergence, with no automatic time or iteration cap. Use Stop run to stop it manually.`)) return
      setBusy(true)
      setError("")
      setNotice("Starting optimization...")
      const job = await api<{ id: string }>("/optimize", { name: tab.name, content: tab.content })
      setOptimization({ ...job, name: "optimization", output: "Starting...", status: "running", truncated: false, recoverable: true, continuable: false })
      setOutputView("optimization")
      setFollow(true)
      setNotice("Optimization started. Progress and gain reports appear in Output & logs. Use Stop run to stop manually.")
    } catch (error) { setNotice(""); fail(error) } finally { submitting.current = false; setBusy(false) }
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
    <header className="topbar"><div className="brand"><span className="brand-mark">spec</span><span className="brand-caption">/ workspace</span></div><div className="topbar-actions"><div className="connection"><i /> Local · Rust + TypeScript</div>{optimization?.recoverable && <span className="badge">Optimization: {optimization.status}</span>}<div className="analysis-actions"><button title="analytics" onClick={() => setAnalytics(true)}>Analytics</button><button className="primary" title="performance" disabled={!execution || busy || !!pendingRuns} onClick={() => void optimize()}>Performance</button></div></div></header>
    {analytics && <Analytics api={api} active={active} onClose={() => setAnalytics(false)} />}
    <div className="workspace">
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
            <button className="close" aria-label={`Close ${item.name}`} onClick={() => close(item)}>×</button>
          </div>)}
          {!tabs.length && <span className="empty-tabs">Open a saved file or create something new</span>}
        </nav>
        {error && <div role="alert" className="error">{error}<button aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
        <div className="panes">
          <section className="editor-pane" aria-label="Spec editing pane">
            <div className="pane-heading"><div><span className="eyebrow">01 / SPEC</span><h2>{tab?.name ?? "Your next idea"}</h2></div><span className="badge">{tab ? dirty(tab) ? "Unsaved" : "Saved" : "Editor"}</span></div>
            {tabs.map((editor) => <Editor key={editor.name} active={editor.name === active} name={editor.name} value={editor.content} token={token} available={completion} enabled={complete} onEnabled={setComplete} onSave={() => void save()} onChange={(content) => {
              setTabs((items) => items.map((item) => item.name === editor.name ? { ...item, content } : item))
            }} />)}
            {!tab && <div className="empty-editor"><span aria-hidden="true">✳</span><h2>Start with a spec.</h2><p>Create a file on the left, describe your idea,<br />then save it when you're ready.</p></div>}
            <footer className="toolbar"><span>{tab ? `${tab.content.split("\n").length} lines · ${new TextEncoder().encode(tab.content).length} bytes` : "UTF-8"}</span><div><button disabled={!tab} onClick={download}>Download</button><button disabled={!tab || busy} onClick={() => void save()}>Save</button><button className="primary" disabled={!tab || busy || !execution || fileOutput?.recoverable || optimization?.recoverable} title="Save & run (Ctrl/Cmd+Enter)" aria-keyshortcuts="Control+Enter Meta+Enter" onClick={requestBuild}>Save & run ↗</button></div></footer>
            {execution && <div className="repository-controls">
              <span>{repositoryError || (repository?.connected ? `${repository.directory} / ${repository.dirty ? "Uncommitted changes" : "No uncommitted changes"}` : repository ? "No repository connected in the remote directory." : "Checking remote repository...")}</span>
              {repository?.connected && repository.dirty && <button disabled={!tab?.content.trim() || busy || !!pendingRuns} title={`Use ${repository.model} with the existing repository workflow`} onClick={() => {
                if (window.confirm(`Save edited repository changes in ${repository.directory} using ${repository.model}? This saves the current spec as context, then runs the existing repository workflow with automatic tool approval. It authorizes focused commits, but no push, and can execute tools and incur provider costs. Wait for harness completion in Output & logs and review its reported result.`)) void save("repository")
              }}>Save repo changes</button>}
            </div>}
          </section>
          <section className="output-pane" aria-label="Output and logs pane">
            <div className="pane-heading"><div><span className="eyebrow">02 / OUTPUT</span><h2>Output & logs</h2></div><span className="badge">{output?.transportUnavailable ? `${output.status} (connection unavailable)` : output?.status ?? "Idle"}</span></div>
            <div className="output-selector" role="group" aria-label="Output view"><button aria-pressed={outputView === "file"} onClick={() => setOutputView("file")}>Current file{tab ? `: ${tab.name}` : " output"}</button><button aria-pressed={outputView === "optimization"} disabled={!optimization && !execution} onClick={() => {
              setOutputView("optimization")
              if (!optimization) { setError(""); void recoverOptimization().catch(fail) }
            }}>Optimization</button></div>
            {tab && outputView === "file" && <div className="chat-launch"><button onClick={openChat}>Open session chat</button><span>{historical ? "Chat uses the associated run, not this retained log" : "Spec + current nohup output in a separate window"}</span></div>}
            <div className="output-controls"><label><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /> Follow output</label>{outputView === "file" && tab?.revision && <><button disabled={!!loadingOutput || !execution} title={`Read ${tab.name}.out from the latest remote background run`} onClick={() => void recoverOutput(tab.name, true)}>{loadingOutput ? "Loading output..." : "Load nohup output"}</button><button disabled={!!loadingOutput || !!retainedView?.loading || busy || !execution} onClick={() => void browseRetained(tab.name)}>Browse retained runs</button></>}{!historical && output?.recoverable && execution && <button onClick={() => void api(`/runs/${output.id}/cancel`, {}).catch(fail)}>Stop run</button>}{output && outputView === "file" && <button disabled={!canContinue} title="Submits the recommended choice to the same build session immediately, with automatic tool approval. Can modify files, execute tools, access the network, and incur provider costs. Does not save or upload editor changes." onClick={() => void continueRun()}>Use recommended &amp; continue</button>}</div>
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
            {output?.truncated && <p className="hint">Older output was truncated; showing the latest 256 KiB.</p>}
            <pre ref={log} className="output" aria-label="Run output">{output ? <LogOutput value={output.output} /> : (outputView === "optimization" ? "No optimization output loaded. Select Optimization to retry recovery. To start a new run, open or create a nonempty .optim file and select its tab, then click Performance. The current editor buffer, including unsaved changes, is uploaded to remote ~/projects and its absolute path is sent to the optimizer. No local save is performed." : execution ? "Remote spec build is ready.\n\nSave & run sends the saved snapshot over SSH. The web server stays local. Remote output and logs appear here.\n\nEach file has its own output view." : "Remote execution is disabled.\n\nSet SPEC_SSH_TARGET (user@host) and SPEC_SSH_WORKSPACE (absolute remote build directory) on the local Rust server, then restart it. Optionally set SPEC_SSH_KEY to a local private-key path. The remote shell must define spec in ~/.bash_aliases or PATH.\n\nEditing and saving work without a model or credentials.")}</pre>
            {!historical && output && outputView === "file" && output.continuable === true && <form className="chat-composer build-feedback" onSubmit={(event) => { event.preventDefault(); void continueRun(message) }}>
              <label htmlFor="build-feedback">Feedback to build session</label>
              <textarea id="build-feedback" aria-describedby="feedback-help feedback-limit" placeholder="Answer the agent or explain what to change..." value={message} disabled={busy} onChange={(event) => setFeedback((items) => ({ ...items, [output.id]: event.target.value }))} />
              <span id="feedback-limit">{new TextEncoder().encode(message).length.toLocaleString()} / 16,384 bytes</span>
              <div><span id="feedback-help">{canContinue ? "Continues the same session with automatic tool approval. Can modify files and incur provider costs. Editor changes are not sent." : "Send after the agent turn finishes. Live input and stopped or failed runs are not supported."}</span><button className="primary" disabled={!canContinue || !message.trim() || message.includes("\0") || new TextEncoder().encode(message).length > 16 * 1024}>Send &amp; continue</button></div>
            </form>}
            <footer className="output-footer">{output && <span>Harness: {output.status}{output.recoverable ? " (completion not confirmed)" : ""}. CLI success alone does not verify saved changes.<br /></span>}Available output only. No hidden model reasoning is requested.</footer>
          </section>
        </div>
        <div className="statusbar"><span role="status">{notice || "Ready"}</span><span id="editor-shortcuts">/ toggle completed (outside fenced code); Alt+/ type /</span><span>Ctrl/Cmd+S save · Ctrl/Cmd+Enter save &amp; run · 2 MiB file limit</span></div>
      </main>
    </div>
  </div>
}

createRoot(document.getElementById("root")!).render(<App />)
