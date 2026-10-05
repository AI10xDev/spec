import { useEffect, useRef, useState } from "react"
import { completionPrefix } from "./completions"

type Props = {
  name: string
  value: string
  token: string
  available: boolean
  enabled: boolean
  onEnabled: (enabled: boolean) => void
  onChange: (value: string) => void
  onSave: () => void
}

export function Editor({ name, value: content, token, available, enabled, onEnabled, onChange, onSave }: Props) {
  // Textarea values and caret offsets use LF, even when the saved file uses CRLF.
  const value = content.replace(/\r\n?/g, "\n")
  const input = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [focused, setFocused] = useState(false)
  const [composing, setComposing] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [suggestion, setSuggestion] = useState({ value: "", start: 0, suffix: "" })
  const [message, setMessage] = useState("")
  const prefix = completionPrefix(value, selection.start, selection.end)
  const ready = available && enabled && focused && !composing && !dismissed && !!prefix
  const suffix = ready && suggestion.value === value && suggestion.start === selection.start ? suggestion.suffix : ""

  function select() {
    const node = input.current!
    setSelection((previous) => {
      if (previous.start === node.selectionStart && previous.end === node.selectionEnd) return previous
      return { start: node.selectionStart, end: node.selectionEnd }
    })
  }

  function scroll() {
    if (!input.current || !mirror.current) return
    mirror.current.scrollTop = input.current.scrollTop
    mirror.current.scrollLeft = input.current.scrollLeft
  }

  useEffect(() => {
    setSuggestion({ value: "", start: 0, suffix: "" })
    setMessage("")
    if (!ready) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setMessage("Completing sentence part...")
      try {
        const response = await fetch("/api/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ prefix }),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error("Completion unavailable. Continue typing to retry.")
        const result = await response.json() as { suffix: string }
        if (controller.signal.aborted) return
        setSuggestion({ value, start: selection.start, suffix: result.suffix })
        setMessage("")
      } catch {
        if (!controller.signal.aborted) setMessage("Completion unavailable. Continue typing to retry.")
      }
    }, 500)
    return () => { clearTimeout(timer); controller.abort() }
  }, [value, prefix, selection.start, ready, token])

  useEffect(scroll, [value, suffix])

  function accept() {
    const node = input.current
    if (!node || !suffix || node.value !== value || node.selectionStart !== selection.start || node.selectionEnd !== selection.end) return
    node.focus()
    // insertText preserves native textarea undo; setRangeText covers browsers without it.
    if (!document.execCommand("insertText", false, suffix)) node.setRangeText(suffix, selection.start, selection.end, "end")
    onChange(node.value)
    select()
    setSuggestion({ value: "", start: 0, suffix: "" })
  }

  return <>
    <div className="completion-controls">
      <label title={available ? "Sends recent editor text to your configured Azure provider" : "Configure Azure completion on the local Rust server"}>
        <input type="checkbox" checked={available && enabled} disabled={!available} onChange={(event) => onEnabled(event.target.checked)} /> Trailing completions
      </label>
      <span id="completion-help" aria-live="polite">{!available ? "Azure not configured" : suffix ? "Tab to accept part / Esc to dismiss" : message || "One sentence part at a time"}</span>
      {suffix && <button onPointerDown={(event) => event.preventDefault()} onClick={accept} title={suffix}>Accept part</button>}
    </div>
    <div className="editor-input">
      <div ref={mirror} className="code completion-mirror" aria-hidden="true">
        {value.slice(0, selection.start)}<span className="completion-anchor"><span className="completion-ghost">{suffix}</span></span>{value.slice(selection.start)}{"\n"}
      </div>
      <textarea ref={input} className="code" aria-label={`Edit ${name}`} aria-describedby="completion-help" spellCheck={false} value={value} placeholder="# What should we build?"
        onChange={(event) => { onChange(event.target.value); select(); setDismissed(false) }}
        onSelect={select} onScroll={scroll}
        onFocus={() => { setFocused(true); select() }} onBlur={() => setFocused(false)}
        onCompositionStart={() => setComposing(true)} onCompositionEnd={() => { setComposing(false); select() }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); onSave() }
          if (event.key === "Escape") { setDismissed(true); setSuggestion({ value: "", start: 0, suffix: "" }) }
          if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && suffix) { event.preventDefault(); accept() }
        }} />
    </div>
  </>
}
