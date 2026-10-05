import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { dirty, openTab, savedTab } from "./tabs"
import type { Document, Output, Tab } from "./tabs"
import "./style.css"

type Entry = { name: string; modified: number; bytes: number }

function App() {
  const [token, setToken] = useState(() => {
    const fragment = new URLSearchParams(location.hash.slice(1)).get("token")
    if (fragment) {
      sessionStorage.setItem("spec-token", fragment)
      history.replaceState(null, "", location.pathname)
    }
    return fragment ?? sessionStorage.getItem("spec-token") ?? ""
  })
  const [connected, setConnected] = useState(false)
  const [execution, setExecution] = useState(false)
  const [files, setFiles] = useState<Entry[]>([])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState("")
  const [section, setSection] = useState("history")
  const [query, setQuery] = useState("")
  const [filename, setFilename] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const [outputs, setOutputs] = useState<Record<string, Output>>({})
  const [follow, setFollow] = useState(true)
  const log = useRef<HTMLPreElement>(null)
  const tab = tabs.find((item) => item.name === active)
  const output = outputs[active]

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
      throw new Error(message || `HTTP ${response.status}`)
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
    const config = await api<{ execution: boolean }>("/config")
    setExecution(config.execution)
    await refresh()
    setConnected(true)
  }

  useEffect(() => { if (token) void connect().catch(fail) }, [])

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
    if (!output || output.status !== "running") return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const next = await api<Output>(`/runs/${output!.id}`)
        if (cancelled) return
        setOutputs((items) => ({ ...items, [next.name]: next }))
        if (next.status === "running") timer = setTimeout(poll, 650)
      } catch (error) {
        if (cancelled) return
        fail(error)
        timer = setTimeout(poll, 2500)
      }
    }
    void poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [output?.id, output?.status, token])

  useEffect(() => {
    if (follow && log.current) log.current.scrollTop = log.current.scrollHeight
  }, [output?.output, follow])

  async function open(name: string) {
    setError("")
    if (tabs.some((item) => item.name === name)) { setActive(name); return }
    const document = await api<Document>(`/files/${encodeURIComponent(name)}`)
    setTabs((items) => openTab(items, document))
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
    setActive(name)
    setFilename("")
    setError("")
  }

  function close(item: Tab) {
    if (dirty(item) && !window.confirm(`Discard unsaved changes to ${item.name}?`)) return
    const remaining = tabs.filter((tab) => tab.name !== item.name)
    setTabs(remaining)
    if (active === item.name) setActive(remaining.at(-1)?.name ?? "")
  }

  async function save(run = false) {
    if (!tab || busy) return
    setBusy(true)
    setError("")
    try {
      const document = await api<Document>(`/files/${encodeURIComponent(tab.name)}`, { content: tab.content, revision: tab.revision }, "PUT")
      setTabs((items) => savedTab(items, document))
      setNotice(`Saved ${document.name}`)
      await refresh()
      if (!run) return
      const job = await api<{ id: string }>("/runs", { name: document.name, revision: document.revision })
      setOutputs((items) => ({ ...items, [document.name]: { ...job, name: document.name, output: "Starting…", status: "running", truncated: false } }))
    } catch (error) { fail(error) } finally { setBusy(false) }
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

  return <div className="app">
    <header className="topbar"><div className="brand"><span className="brand-mark">spec</span><span className="brand-caption">/ workspace</span></div><div className="connection"><i /> Local · Rust + TypeScript</div></header>
    <div className="workspace">
      <aside>
        <div className="sidebar-heading">YOUR WORKSPACE <button title="Refresh file list" aria-label="Refresh file list" onClick={() => void refresh().catch(fail)}>↻</button></div>
        <form className="new-file" onSubmit={create}>
          <input aria-label="New filename" placeholder="New file, e.g. idea.md" value={filename} onChange={(event) => setFilename(event.target.value)} required />
          <button aria-label="Create file" title="Create file">＋</button>
        </form>
        <div className="switcher" role="tablist" aria-label="File navigation">
          <button role="tab" aria-selected={section === "history"} onClick={() => setSection("history")}>Saved files</button>
          <button role="tab" aria-selected={section === "tabs"} onClick={() => setSection("tabs")}>Open tabs ({tabs.length})</button>
        </div>
        <input className="search" aria-label="Filter files" placeholder="Filter files…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="file-list" role="tabpanel">
          {section === "history" && files.filter((file) => file.name.toLowerCase().includes(query.toLowerCase())).map((file) => <button key={file.name} className={`file ${active === file.name ? "selected" : ""}`} onClick={() => void open(file.name).catch(fail)}><span>▤ <strong>{file.name}</strong></span><small>{new Date(file.modified).toLocaleString()} · {file.bytes} B</small></button>)}
          {section === "history" && !files.length && <p className="hint">Previously written files appear here after saving. This list persists across server restarts.</p>}
          {section === "tabs" && tabs.filter((item) => item.name.toLowerCase().includes(query.toLowerCase())).map((item) => <button key={item.name} className={`file ${active === item.name ? "selected" : ""}`} onClick={() => setActive(item.name)}>{item.name}{dirty(item) ? " •" : ""}</button>)}
        </div>
        <div className="sidebar-footer">One workspace. Many ideas.<br /><span>Files are saved locally, not in the browser.</span></div>
      </aside>
      <main className="editor-area">
        <nav className="editor-tabs" aria-label="Editor tabs">
          {tabs.map((item) => <div className={`editor-tab ${item.name === active ? "active" : ""}`} key={item.name}>
            <button onClick={() => setActive(item.name)} aria-current={item.name === active ? "page" : undefined}>{item.name}{dirty(item) ? " •" : ""}</button>
            <button className="close" aria-label={`Close ${item.name}`} onClick={() => close(item)}>×</button>
          </div>)}
          {!tabs.length && <span className="empty-tabs">Open a saved file or create something new</span>}
        </nav>
        {error && <div role="alert" className="error">{error}<button aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
        <div className="panes">
          <section className="editor-pane" aria-label="Spec editing pane">
            <div className="pane-heading"><div><span className="eyebrow">01 / SPEC</span><h2>{tab?.name ?? "Your next idea"}</h2></div><span className="badge">{tab ? dirty(tab) ? "Unsaved" : "Saved" : "Editor"}</span></div>
            {tab ? <textarea className="code" aria-label={`Edit ${tab.name}`} spellCheck={false} value={tab.content} placeholder="# What should we build?" onChange={(event) => {
              const content = event.target.value
              setTabs((items) => items.map((item) => item.name === active ? { ...item, content } : item))
            }} onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save() }
            }} /> : <div className="empty-editor"><span aria-hidden="true">✳</span><h2>Start with a spec.</h2><p>Create a file on the left, describe your idea,<br />then save it when you're ready.</p></div>}
            <footer className="toolbar"><span>{tab ? `${tab.content.split("\n").length} lines · ${new TextEncoder().encode(tab.content).length} bytes` : "UTF-8"}</span><div><button disabled={!tab} onClick={download}>Download</button><button disabled={!tab || busy} onClick={() => void save()}>Save</button><button className="primary" disabled={!tab || busy || !execution || output?.status === "running"} onClick={() => {
              if (window.confirm("Send this saved spec over SSH and run remote spec build? Automatic tool approval is requested (SPEC_BUILD_AUTO=1). It can modify remote files, execute tools, access the network, and incur provider costs. The web server and editor files stay local.")) void save(true)
            }}>Save & run ↗</button></div></footer>
          </section>
          <section className="output-pane" aria-label="Output and logs pane">
            <div className="pane-heading"><div><span className="eyebrow">02 / OUTPUT</span><h2>Output & logs</h2></div><span className="badge">{output?.status ?? "Idle"}</span></div>
            <div className="output-controls"><label><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /> Follow output</label>{output?.status === "running" && <button onClick={() => void api(`/runs/${output.id}/cancel`, {}).catch(fail)}>Stop run</button>}</div>
            {output?.truncated && <p className="hint">Older output was truncated; showing the latest 256 KiB.</p>}
            <pre ref={log} className="output" aria-label="Run output">{output?.output ?? (execution ? "Remote spec build is ready.\n\nSave & run sends the saved snapshot over SSH. The web server stays local. Remote output and logs appear here.\n\nEach file has its own output view." : "Remote execution is disabled.\n\nSet SPEC_SSH_TARGET (user@host) and SPEC_SSH_WORKSPACE (absolute remote build directory) on the local Rust server, then restart it. Optionally set SPEC_SSH_KEY to a local private-key path. The remote shell must define spec in ~/.bash_aliases or PATH.\n\nEditing and saving work without a model or credentials.")}</pre>
            <footer className="output-footer">Available output only. No hidden model reasoning is requested.</footer>
          </section>
        </div>
        <div className="statusbar"><span role="status">{notice || "Ready"}</span><span>⌘ / Ctrl + S to save · 2 MiB file limit</span></div>
      </main>
    </div>
  </div>
}

createRoot(document.getElementById("root")!).render(<App />)
