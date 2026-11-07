import { useEffect, useRef, useState } from "react"
import "./marketplace.css"

type Api = <T>(path: string, body?: unknown, method?: string, signal?: AbortSignal) => Promise<T>
type Order = { id: string; approvalUrl: string }
type Skill = { id: string; name: string; path: string; description: string; price: string; currency: string; purchased: boolean; order?: Order }
type Catalog = { mode: "demo" | "sandbox" | "live"; repository: string; skills: Skill[]; warning?: string }
type Purchase = { id: string; approvalUrl: string | null; purchased: boolean }

function approvalLink(order: Order, mode: Catalog["mode"]) {
  try {
    const url = new URL(order.approvalUrl)
    const host = mode === "live" ? "www.paypal.com" : "www.sandbox.paypal.com"
    return mode !== "demo" && url.protocol === "https:" && url.hostname === host && !url.port
      && !url.username && !url.password && !url.hash && url.pathname === "/checkoutnow"
      && url.searchParams.get("token") === order.id ? url.href : null
  } catch { return null }
}

export function Marketplace({ api, onClose }: { api: Api; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const request = useRef<AbortController | null>(null)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [selected, setSelected] = useState("")
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [content, setContent] = useState<string | null>(null)
  const skill = catalog?.skills.find((item) => item.id === selected)
  const approval = skill?.order && catalog ? approvalLink(skill.order, catalog.mode) : null

  useEffect(() => {
    const element = dialog.current!
    const opener = document.activeElement
    element.showModal()
    void load()
    return () => {
      request.current?.abort()
      request.current = null
      element.close()
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])

  async function perform(label: string, action: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    setBusy(label); setError(""); setNotice("")
    try { await action(controller.signal) }
    catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (request.current === controller) {
        request.current = null
        setBusy("")
      }
    }
  }

  async function load() {
    await perform("Loading skills...", async (signal) => {
      const result = await api<Catalog>("/marketplace", undefined, "GET", signal)
      if (signal.aborted) return
      setCatalog(result)
      setSelected((id) => result.skills.some((item) => item.id === id) ? id : "")
      setContent(null)
    })
  }

  async function buy(replace = false) {
    if (!skill || !catalog || (replace && !skill.order)) return
    await perform(catalog.mode === "demo" ? "Simulating purchase..." : "Preparing PayPal order...", async (signal) => {
      const result = await api<Purchase>(replace ? `/marketplace/orders/${encodeURIComponent(skill.order!.id)}/replace` : "/marketplace/orders", replace ? {} : { skillId: skill.id }, "POST", signal)
      if (signal.aborted) return
      const order = result.approvalUrl ? { id: result.id, approvalUrl: result.approvalUrl } : undefined
      if (!result.purchased && (!order || !approvalLink(order, catalog.mode))) throw new Error("No valid PayPal approval link was returned. Refresh the catalog to recover your order; do not start a separate purchase.")
      setCatalog((previous) => previous && { ...previous, skills: previous.skills.map((item) => item.id === skill.id ? { ...item, purchased: result.purchased, order: result.purchased ? undefined : order } : item) })
      setNotice(result.purchased
        ? catalog.mode === "demo" ? "Example unlocked. This was a simulation; no payment was made." : "This workspace already owns this skill. No new payment was made."
        : "Order ready. Continue to PayPal, then return here and check payment. Closing this window does not cancel the order.")
    })
  }

  async function capture() {
    if (!skill?.order) return
    await perform("Checking and capturing payment...", async (signal) => {
      const result = await api<{ purchased: boolean }>(`/marketplace/orders/${encodeURIComponent(skill.order!.id)}/capture`, {}, "POST", signal)
      if (signal.aborted) return
      if (!result.purchased) throw new Error("Payment is not complete. Full contents remain locked. You can check this same order again.")
      setCatalog((previous) => previous && { ...previous, skills: previous.skills.map((item) => item.id === skill.id ? { ...item, purchased: true, order: undefined } : item) })
      setNotice("Payment verified. You can now display the full file.")
    })
  }

  async function reveal() {
    if (!skill?.purchased) return
    await perform("Loading full contents...", async (signal) => {
      const result = await api<{ content: string }>(`/marketplace/skills/${encodeURIComponent(skill.id)}/content`, undefined, "GET", signal)
      if (!signal.aborted) setContent(result.content)
    })
  }

  return <dialog ref={dialog} className="skills-dialog" aria-labelledby="skills-title" onCancel={(event) => { event.preventDefault(); onClose() }} onKeyDown={(event) => {
    if (event.key !== "Tab") return
    // Native modal inertness blocks the workspace; wrap boundaries instead of visiting browser chrome.
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary, [tabindex="0"]')].filter((element) => element.checkVisibility())
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }}>
    <header className="skills-heading">
      <div><span className="eyebrow">SPEC / SKILL LIBRARY</span><h2 id="skills-title">Skills marketplace</h2></div>
      <button onClick={onClose} aria-label="Close skills marketplace">Close</button>
    </header>
    <div className="skills-intro">
      <p>Choose a skill. Preview its description. Unlock the instructions.</p>
      {catalog && <div className="skills-source"><span className={`skills-mode skills-mode-${catalog.mode}`}>{catalog.mode === "demo" ? "EXAMPLES / NO CHARGE" : catalog.mode === "sandbox" ? "PAYPAL SANDBOX / TEST PAYMENTS" : "PAYPAL LIVE / REAL PAYMENTS"}</span><code>{catalog.repository}</code></div>}
      <p className="skills-note">{catalog?.mode === "demo" ? "Example catalog, not a connected private repository. Simulated purchases never contact PayPal." : "Descriptions only until purchase. GitHub access and payment verification happen on your Spec server."} Access is shared by everyone with this workspace's token.</p>
    </div>
    <div className="skills-toolbar"><span>{catalog ? `${catalog.skills.length} skill${catalog.skills.length === 1 ? "" : "s"}` : "Private repository catalog"}</span><button disabled={!!busy} onClick={() => void load()}>{catalog ? "Refresh catalog" : "Retry catalog"}</button></div>
    <div className="skills-feedback" aria-live="polite">{busy && <p role="status">{busy}</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert" className="error">{error}</p>}</div>
    {catalog?.warning && <p className="skills-warning" role="status">{catalog.warning}</p>}
    {catalog && <div className="skills-layout" aria-busy={!!busy}>
      <nav className="skills-list" aria-label="Available skills">
        {catalog.skills.map((item) => <button key={item.id} className="skills-item" aria-pressed={item.id === selected} disabled={!!busy} onClick={() => { setSelected(item.id); setContent(null); setError(""); setNotice("") }}>
          <span className="skills-item-title">{item.name}<span className="skills-file-type">MD</span></span>
          <code>{item.path}</code>
          <span className="skills-item-price">{item.purchased ? "Unlocked" : item.order ? "Payment in progress" : `${item.currency} ${item.price}`}</span>
        </button>)}
        {!catalog.skills.length && <p className="skills-note">No skills are listed in this repository yet. Refresh after the catalog is populated.</p>}
      </nav>
      <section className="skills-preview" aria-label="Skill preview">
        {!skill ? <div className="skills-empty"><span className="eyebrow">01 / SELECT A FILE</span><h3>Instructions for your next build.</h3><p>Select a skills.md file to read its description before you buy. Nothing is added to your spec or executed automatically.</p></div> : <>
          <span className="eyebrow">{skill.purchased ? "03 / UNLOCKED" : "02 / DESCRIPTION PREVIEW"}</span>
          <h3>{skill.name}</h3><code className="skills-path">{skill.path}</code>
          <p className="skills-description">{skill.description}</p>
          <div className="skills-purchase">
            {skill.purchased ? <>
              <p>{catalog.mode === "demo" ? "Example access unlocked. No payment was made." : "Purchased for this workspace."} Full contents are available on request.</p>
              <button className="primary" disabled={!!busy} onClick={() => content === null ? void reveal() : setContent(null)} aria-expanded={content !== null} aria-controls="skills-full-content">{content === null ? "Display full contents" : "Hide full contents"}</button>
            </> : skill.order ? <>
              <p>Approve this order in the PayPal tab, then return here. <strong>Check payment captures the approved payment</strong> and unlocks this file only after server verification.</p>
              <div className="skills-purchase-actions">{approval ? <a className="skills-paypal" href={approval} target="_blank" rel="noopener noreferrer">Continue to PayPal <span className="skills-new-tab">(new tab)</span></a> : <p role="alert">Invalid approval link. Refresh the catalog to recover this order.</p>}<button disabled={!!busy} onClick={() => void capture()}>Check payment</button></div>
              <p className="skills-note">Order: <code>{skill.order.id}</code>. If you cancel or close PayPal, the file stays locked. Reopening this marketplace restores the same order; checking it again will not double-charge.</p>
              <details className="skills-recovery"><summary>Expired order?</summary><p className="skills-note">You can request a replacement only if PayPal confirms this order is voided and unpaid. An approved, pending, or unknown payment cannot be replaced. The original file and price are preserved.</p><button disabled={!!busy} onClick={() => void buy(true)}>Start a new order</button></details>
            </> : <>
              <div className="skills-price"><strong>{skill.currency} {skill.price}</strong><span>{catalog.mode === "demo" ? "Example price" : "One-time purchase"}</span></div>
              <button className={catalog.mode === "demo" ? "primary" : "skills-paypal"} disabled={!!busy} onClick={() => void buy()}>{catalog.mode === "demo" ? "Simulate purchase (no charge)" : catalog.mode === "sandbox" ? "Buy with PayPal (sandbox)" : "Buy with PayPal"}</button>
              <p className="skills-note">{catalog.mode === "demo" ? "Try the purchase and reveal workflow using this example. No PayPal account needed." : "Confirm this selection to prepare an order, then continue to PayPal in a separate tab. Review the total there before approving. No payment is captured until you return and check payment."}</p>
            </>}
          </div>
          <div id="skills-full-content" hidden={content === null}>{content !== null && <><h4>Full file contents</h4><p className="skills-note">Read-only Markdown. These instructions have not been run or added to your spec.</p><pre tabIndex={0} aria-label={`Full contents of ${skill.path}`}>{content}</pre></>}</div>
        </>}
      </section>
    </div>}
    <footer className="skills-footer">Browse, purchase, and read without changing your editor or running a build. Closing this dialog does not cancel an in-progress payment.</footer>
  </dialog>
}
