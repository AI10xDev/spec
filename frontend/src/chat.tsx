import { useEffect, useEffectEvent, useRef, useState } from "react"
import type { Document, Output, Tab } from "./tabs"
import { dirty } from "./tabs"

type Api = <T>(path: string, body?: unknown) => Promise<T>
type Context = { spec: string; unsaved: boolean; source: string; output: Output | null; updated: string }
type Message = { role: "user" | "assistant"; content: string }

async function editorBuffer(name: string): Promise<Tab | null> {
  if (!window.opener || window.opener.closed) return null
  return new Promise((resolve) => {
    const id = crypto.randomUUID()
    const finish = (tab: Tab | null) => {
      clearTimeout(timer)
      window.removeEventListener("message", receive)
      resolve(tab)
    }
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== window.opener || event.data?.type !== "spec-chat-context" || event.data.id !== id) return
      finish(event.data.tab?.name === name ? event.data.tab : null)
    }
    const timer = setTimeout(() => finish(null), 700)
    window.addEventListener("message", receive)
    window.opener.postMessage({ type: "spec-chat-request", id, name }, location.origin)
  })
}

export function Chat({ name, api, available, execution }: { name: string; api: Api; available: boolean; execution: boolean }) {
  const [context, setContext] = useState<Context | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [question, setQuestion] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [contextError, setContextError] = useState("")
  const [answerContext, setAnswerContext] = useState<Context | null>(null)
  const [notice, setNotice] = useState("")
  const [truncated, setTruncated] = useState(false)
  const conversationRun = useRef<string | null>(null)
  const sending = useRef(false)
  const controller = useRef<HTMLDivElement>(null)

  async function refresh(fromLog: boolean): Promise<Context> {
    const tab = await editorBuffer(name)
    const document = tab ?? await api<Document>(`/files/${encodeURIComponent(name)}`)
    const output = execution && document.revision
      ? await api<Output | null>(`/files/${encodeURIComponent(name)}/run${fromLog ? "/log" : ""}`)
      : null
    return {
      spec: document.content,
      unsaved: tab ? dirty(tab) : false,
      source: tab ? "Live editor buffer" : "Saved file (editor unavailable)",
      output,
      updated: new Date().toLocaleTimeString(),
    }
  }

  const poll = useEffectEvent(() => refresh(false))
  useEffect(() => {
    if (busy) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function update() {
      try {
        const next = await poll()
        if (!cancelled) { setContext(next); setContextError("") }
      } catch (error) {
        if (!cancelled) setContextError(`Context refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        if (!cancelled) timer = setTimeout(update, 3000)
      }
    }
    void update()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [name, busy])

  useEffect(() => {
    if (controller.current) controller.current.scrollTop = controller.current.scrollHeight
  }, [messages, busy])

  async function ask(event: React.FormEvent) {
    event.preventDefault()
    const text = question.trim()
    if (!text || sending.current || !available) return
    if (new TextEncoder().encode(text).length > 8192) { setError("Keep questions within 8 KiB of UTF-8 text."); return }
    sending.current = true
    setBusy(true)
    setError("")
    setNotice("")
    try {
      // Refresh disk output before every answer; never silently use stale logs on failure.
      const next = await refresh(true)
      setContext(next)
      setContextError("")
      const run = next.output?.id ?? null
      const changed = conversationRun.current !== run
      const prior = changed ? [] : messages
      if (changed && messages.length) setNotice("A different run is now current. Earlier conversation was cleared to keep sessions separate.")
      setMessages(prior)
      if (changed) { setAnswerContext(null); setTruncated(false) }
      conversationRun.current = run
      const request: Message[] = [...prior.slice(-8), { role: "user", content: text }]
      const output = next.output
      const response = await api<{ answer: string; contextTruncated: boolean }>("/chat", {
        name, spec: next.spec, unsaved: next.unsaved,
        output: output ? { id: output.id, status: output.status, output: output.output, truncated: output.truncated } : null,
        messages: request,
      })
      setMessages([...prior, { role: "user", content: text }, { role: "assistant", content: response.answer }])
      setTruncated(response.contextTruncated)
      setAnswerContext(next)
      setQuestion("")
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  return <div className="app chat-app">
    <header className="topbar"><div className="brand"><span className="brand-mark">spec</span><span className="brand-caption">/ session chat</span></div><a href="/" target="_blank" rel="opener">Open workspace</a></header>
    <main className="chat-space">
      <div className="pane-heading"><div><span className="eyebrow">A SEPARATE SPACE / READ ONLY</span><h1>{name}</h1></div><span className="badge">{context?.output?.status ?? "Spec only"}</span></div>
      <section className="chat-context" aria-label="Chat context">
        <p>Current session output first. Written spec next. Earlier conversation last.</p>
        <dl><div><dt>Session</dt><dd>{context?.output?.id ?? "No associated run output"}</dd></div><div><dt>Spec</dt><dd>{context ? `${context.source}${context.unsaved ? " / unsaved" : " / saved"}` : "Loading context..."}</dd></div></dl>
        <p>Bound to this file, independent of workspace selection. Nohup output is refreshed before each question. Current spec text is not a historical build snapshot.</p>
        {context && <small>Session preview checked at {context.updated}; polling may use cached output. {context.output?.truncated ? "Available output is truncated." : ""}</small>}
        <details><summary>Inspect current context</summary><h2>Written spec</h2><pre>{context?.spec ?? "Loading..."}</pre><h2>Available output</h2><pre>{context?.output?.output ?? "No output supplied. You can still ask about the spec or general topics."}</pre></details>
      </section>
      {!available && <p className="hint">AI chat is not configured. Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY and DEPLOYMENT_NAME on the Rust server, then restart and reload.</p>}
      <div ref={controller} className="chat-messages" role="log" aria-label="Conversation" aria-live="polite">
        {answerContext && <details className="chat-answer-context"><summary>Inspect last answer input</summary><p>Session: {answerContext.output?.id ?? "Spec only"}{answerContext.output ? ` / ${answerContext.output.status}` : ""}. Checked at {answerContext.updated}. {answerContext.source}{answerContext.unsaved ? " / unsaved" : " / saved"}.</p><p>Snapshot before provider context limits. Later polling does not change this evidence.</p><h2>Written spec</h2><pre>{answerContext.spec}</pre><h2>Nohup output</h2><pre>{answerContext.output?.output ?? "No output supplied."}</pre></details>}
        {answerContext && (context?.output?.id ?? null) !== conversationRun.current && <p className="hint">The current session has changed; your next question will start a new conversation.</p>}
        {!messages.length && <div className="chat-empty"><h2>Ask about what is happening.</h2><p>Explain a log line, check progress against the spec, or explore a general question.</p><p>Questions send the current spec and available output to the configured model provider. Chat cannot edit files or run commands.</p></div>}
        {messages.map((message, index) => <article className={`chat-message ${message.role}`} key={index}><h2>{message.role === "user" ? "You" : "Spec assistant"}</h2><div>{message.content}</div></article>)}
        {busy && <p role="status">Refreshing context and asking the model...</p>}
      </div>
      {notice && <p className="hint" role="status">{notice}</p>}
      {truncated && <p className="hint">The last answer used partial context: up to the first 64 KiB of spec and last 64 KiB of available output.</p>}
      {(error || contextError) && <p className="error" role="alert">{error || contextError}</p>}
      <form className="chat-composer" onSubmit={(event) => void ask(event)}>
        <label htmlFor="question">Your question</label>
        <textarea id="question" value={question} onChange={(event) => setQuestion(event.target.value)} disabled={busy || !available} placeholder="What does this output mean for my spec?" rows={3} />
        <div><span>Read-only answers. Verify important claims.</span><button type="button" disabled={busy || !messages.length} onClick={() => { setMessages([]); setTruncated(false); setNotice(""); setAnswerContext(null) }}>Clear chat</button><button className="primary" disabled={busy || !available || !question.trim()}>Ask</button></div>
      </form>
    </main>
  </div>
}
