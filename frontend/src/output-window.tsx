import { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { createPortal } from "react-dom"

export function OutputWindow({ children }: { children: (control: ReactNode, detached: boolean) => ReactNode }) {
  const host = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const popup = useRef<Window | null>(null)
  const [container] = useState(() => {
    const element = document.createElement("div")
    element.className = "output-window-content"
    return element
  })
  const [detached, setDetached] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    host.current?.append(container)
    const close = () => popup.current?.close()
    window.addEventListener("pagehide", close)
    return () => {
      window.removeEventListener("pagehide", close)
      close()
      container.remove()
    }
  }, [container])

  useEffect(() => {
    if (!detached) return
    const child = popup.current!
    const restore = () => {
      // Move the same portal target: drafts, selection and queued actions stay owned by the workspace.
      host.current?.append(container)
      popup.current = null
      setDetached(false)
    }
    child.addEventListener("pagehide", restore)
    const timer = window.setInterval(() => { if (child.closed) restore() }, 300)
    button.current?.focus()
    return () => {
      clearInterval(timer)
      child.removeEventListener("pagehide", restore)
      child.close()
      button.current?.focus()
    }
  }, [detached, container])

  function restore() {
    host.current?.append(container)
    setDetached(false)
    popup.current = null
    window.focus()
  }

  function maximize() {
    setError("")
    if (popup.current && !popup.current.closed) { popup.current.focus(); return }
    const child = window.open("/output-window.html", "_blank", `popup,width=${screen.availWidth},height=${screen.availHeight},left=0,top=0`)
    if (!child) {
      setError("Allow popups for this site to maximize output in a separate window.")
      return
    }
    popup.current = child
    child.addEventListener("load", () => {
      if (child.closed || popup.current !== child) return
      if (!child.document.getElementById("output-window")) {
        setError("Could not load the output window. Restore the workspace and try again.")
        child.close()
        popup.current = null
        return
      }
      for (const style of document.querySelectorAll('link[rel="stylesheet"], style')) {
        const copy = style.cloneNode(true) as HTMLElement
        if (style instanceof HTMLLinkElement) copy.setAttribute("href", style.href)
        child.document.head.append(copy)
      }
      child.document.body.append(container)
      setDetached(true)
    }, { once: true })
    child.focus()
  }

  return <div className="output-window-host" ref={host}>
    {detached && <div className="output-window-placeholder">
      <h2>Output is in a separate window</h2>
      <p>Keep this workspace open for live output and queued follow-ups. The window follows your selected file.</p>
      <button onClick={() => popup.current?.focus()}>Focus output window</button>
      <button onClick={restore}>Restore output here</button>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
    {createPortal(children(<button ref={button} title={detached ? "Return output to the workspace" : "Open the full output panel in a separate window"} onClick={detached ? restore : maximize}>{detached ? "Restore output" : "Maximize output"}</button>, detached), container)}
  </div>
}
