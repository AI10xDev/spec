import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react"
import { completionPrefix } from "./completions"
import { completionMarker } from "./completion-marker"
import { highlightSpec } from "./highlighting"
import { recordEdit, stepHistory, type EditorHistory, type EditorSnapshot } from "./tabs"

type Props = {
  active: boolean
  name: string
  value: string
  token: string
  available: boolean
  enabled: boolean
  onEnabled: (enabled: boolean) => void
  onChange: (value: string) => void
  onSave: () => void
}

export function Editor({ active, name, value: content, token, available, enabled, onEnabled, onChange, onSave }: Props) {
  // Textarea values and caret offsets use LF, even when the saved file uses CRLF.
  const value = content.replace(/\r\n?/g, "\n")
  const input = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const syntax = useRef<HTMLDivElement>(null)
  const history = useRef<EditorHistory>({ undo: [], redo: [] })
  const beforeInput = useRef<EditorSnapshot | null>(null)
  const composition = useRef<EditorSnapshot | null>(null)
  const editing = useRef(false)
  const plain = value.length > 256 * 1024 || (value.match(/\n/g)?.length ?? 0) >= 5000
  const lines = plain ? [] : highlightSpec(value)
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [focused, setFocused] = useState(false)
  const [composing, setComposing] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [suggestion, setSuggestion] = useState({ value: "", start: 0, suffix: "" })
  const [message, setMessage] = useState("")
  const prefix = completionPrefix(value, selection.start, selection.end)
  const ready = active && available && enabled && focused && !composing && !dismissed && !!prefix
  const suffix = ready && suggestion.value === value && suggestion.start === selection.start ? suggestion.suffix : ""

  function select() {
    const node = input.current!
    setSelection((previous) => {
      if (previous.start === node.selectionStart && previous.end === node.selectionEnd) return previous
      return { start: node.selectionStart, end: node.selectionEnd }
    })
  }

  function scroll() {
    if (!input.current) return
    for (const layer of [mirror.current, syntax.current]) {
      if (!layer) continue
      layer.scrollTop = input.current.scrollTop
      layer.scrollLeft = input.current.scrollLeft
    }
  }

  function snapshot(): EditorSnapshot {
    const node = input.current!
    return { value: node.value, start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection, top: node.scrollTop, left: node.scrollLeft }
  }

  function changed(before: EditorSnapshot, kind: string) {
    history.current = recordEdit(history.current, before, snapshot(), kind)
    beforeInput.current = null
    onChange(input.current!.value)
    select()
  }

  function undo(redo: boolean) {
    const step = stepHistory(history.current, snapshot(), redo)
    if (!step) return
    history.current = step.history
    beforeInput.current = null
    const node = input.current!
    const view = step.snapshot
    node.value = view.value
    node.setSelectionRange(view.start, view.end, view.direction)
    node.scrollTop = view.top
    node.scrollLeft = view.left
    onChange(view.value)
    select()
    scroll()
    setDismissed(true)
    setSuggestion({ value: "", start: 0, suffix: "" })
  }

  useEffect(() => {
    if (!active) return
    const node = input.current!
    // Chromium's undo stack is document-wide, even for mounted textareas.
    // Keep per-editor history, including native menu/IME beforeinput actions.
    const before = (event: InputEvent) => {
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
        event.preventDefault()
        undo(event.inputType === "historyRedo")
      } else beforeInput.current = snapshot()
    }
    node.addEventListener("beforeinput", before)
    return () => node.removeEventListener("beforeinput", before)
  })

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

  useLayoutEffect(() => {
    if (!active) {
      if (document.activeElement === input.current) input.current?.blur()
      setFocused(false)
      setComposing(false)
      return
    }
    scroll()
  }, [active, value, suffix])
  useEffect(() => {
    if (!active) return
    const observer = new ResizeObserver(scroll)
    if (input.current) observer.observe(input.current)
    return () => observer.disconnect()
  }, [active])

  function accept() {
    const node = input.current
    if (!active || !node || !suffix || node.value !== value || node.selectionStart !== selection.start || node.selectionEnd !== selection.end) return
    node.focus()
    const before = snapshot()
    editing.current = true
    // insertText preserves native textarea undo; setRangeText covers browsers without it.
    if (!document.execCommand("insertText", false, suffix)) node.setRangeText(suffix, selection.start, selection.end, "end")
    editing.current = false
    changed(before, "completion")
    setDismissed(true)
    setSuggestion({ value: "", start: 0, suffix: "" })
  }

  return <>
    <div className="completion-controls" style={{ display: active ? undefined : "none" }} inert={!active}>
      <label title={available ? "Sends recent editor text to your configured model provider" : "Configure a model provider in workspace Settings"}>
        <input type="checkbox" checked={available && enabled} disabled={!available} onChange={(event) => onEnabled(event.target.checked)} /> Trailing completions
      </label>
      <span id={active ? "completion-help" : undefined} aria-live="polite">{!available ? "AI not configured: choose a provider in Settings or configure the server environment" : suffix ? "Tab to accept part / Esc to dismiss" : message || "One sentence part at a time"}</span>
      {plain && <span>Large file: plain-text display (highlighting and line numbers off)</span>}
      {/* Reserve space so showing acceptance does not shrink a scrolled editor. */}
      <button style={{ visibility: suffix ? "visible" : "hidden" }} disabled={!suffix} onPointerDown={(event) => event.preventDefault()} onClick={accept} title={suffix}>Accept part</button>
    </div>
    <div className={`editor-input${plain ? " plain-editor" : ""}`} inert={!active} style={{ display: active ? undefined : "none", "--editor-gutter": `${plain ? 0 : Math.max(3, String(lines.length).length)}ch` } as CSSProperties}>
      {!plain && <div ref={syntax} className="code syntax-mirror" aria-hidden="true">
        {lines.map((line, index) => <span key={index} className={`syntax-line${line.kind ? ` syntax-${line.kind}` : ""}`} data-line={index + 1}>{line.tokens.map((token, part) => <span key={part} className={token.kind ? `syntax-${token.kind}` : undefined}>{token.text}</span>)}{index < lines.length - 1 ? "\n" : ""}</span>)}
      </div>}
      <div ref={mirror} className="code completion-mirror" aria-hidden="true">
        {value.slice(0, selection.start)}<span className="completion-anchor"><span className="completion-ghost">{suffix}</span></span>{value.slice(selection.start)}{"\n"}
      </div>
      <textarea ref={input} className="code" aria-label={`Edit ${name}`} aria-describedby="completion-help editor-shortcuts" title="/ toggles completed outside fenced code; Alt+/ types a literal slash" spellCheck={false} value={value} placeholder="What should we build?"
        onChange={(event) => {
          if (!active || editing.current) return
          if (composition.current) { onChange(event.target.value); select() }
          else changed(beforeInput.current ?? { ...snapshot(), value, start: selection.start, end: selection.end }, (event.nativeEvent as InputEvent).inputType ?? "input")
          setDismissed(false)
        }}
        onSelect={select} onScroll={scroll}
        onFocus={(event) => { if (!active) { event.currentTarget.blur(); return }; setFocused(true); select() }} onBlur={() => { setFocused(false); history.current.last = undefined }}
        onCompositionStart={() => { if (!active) return; composition.current = snapshot(); setComposing(true) }} onCompositionEnd={() => {
          if (composition.current) changed(composition.current, "composition")
          composition.current = null
          setComposing(false)
          select()
        }}
        onKeyDown={(event) => {
          if (!active || composing || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) {
            event.preventDefault()
            undo(event.shiftKey || event.key.toLowerCase() === "y")
            return
          }
          const literalSlash = event.altKey && (event.key === "/" || event.code === "Slash")
          if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.getModifierState("AltGraph") && (literalSlash || (!event.altKey && event.key === "/"))) {
            const node = event.currentTarget
            const { selectionStart: start, selectionEnd: end, selectionDirection: direction, scrollTop, scrollLeft } = node
            const edit = literalSlash ? { start, end, text: "/" } : completionMarker(node.value, direction === "backward" ? start : end)
            if (!edit) return
            event.preventDefault()
            const before = snapshot()
            editing.current = true
            node.setSelectionRange(edit.start, edit.end)
            // Like accepting a completion, this is a native, undoable textarea edit.
            if (!document.execCommand(edit.text ? "insertText" : "delete", false, edit.text)) node.setRangeText(edit.text, edit.start, edit.end, "end")
            editing.current = false
            const adjust = (position: number) => position < edit.start ? position : Math.max(edit.start, position + edit.text.length - (edit.end - edit.start))
            if (!literalSlash) node.setSelectionRange(adjust(start), adjust(end), direction)
            node.scrollTop = scrollTop
            node.scrollLeft = scrollLeft
            changed(before, "marker")
            setDismissed(true)
            setSuggestion({ value: "", start: 0, suffix: "" })
            return
          }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); onSave() }
          if (event.key === "Escape") { setDismissed(true); setSuggestion({ value: "", start: 0, suffix: "" }) }
          if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && suffix) { event.preventDefault(); accept() }
        }} />
    </div>
  </>
}
