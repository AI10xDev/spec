import { useEffect, useRef, useState } from "react"
import { loadCoreSdkScript, type SdkInstance } from "@paypal/paypal-js/sdk-v6"
import "./marketplace.css"

type Api = <T>(path: string, body?: unknown, method?: string, signal?: AbortSignal) => Promise<T>
type Order = { id: string; approvalUrl: string }
type Skill = { id: string; name: string; path: string; description: string; price: string; currency: string; purchased: boolean; order?: Order }
type Catalog = { mode: "demo" | "sandbox" | "live"; repository: string; skills: Skill[]; warning?: string }
type Purchase = { id: string; approvalUrl: string | null; purchased: boolean }
let documentPayPalEnvironment: "sandbox" | "production" | undefined

function approvalLink(order: Order, mode: Catalog["mode"]) {
  try {
    const url = new URL(order.approvalUrl)
    const host = mode === "live" ? "www.paypal.com" : "www.sandbox.paypal.com"
    return mode !== "demo" && url.protocol === "https:" && url.hostname === host && !url.port
      && !url.username && !url.password && !url.hash && url.pathname === "/checkoutnow"
      && url.searchParams.get("token") === order.id ? url.href : null
  } catch { return null }
}

export function Marketplace({ api, onClose, onEdit }: { api: Api; onClose: () => void; onEdit: (id: string, content: string, signal: AbortSignal) => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const request = useRef<AbortController | null>(null)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [selected, setSelected] = useState("")
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [content, setContent] = useState<string | null>(null)
  const [sdk, setSdk] = useState<{ key: string; instance: SdkInstance<["paypal-payments"]> } | null>(null)
  const [sdkError, setSdkError] = useState("")
  const [sdkRetry, setSdkRetry] = useState(0)
  const skill = catalog?.skills.find((item) => item.id === selected)
  const approval = skill?.order && catalog ? approvalLink(skill.order, catalog.mode) : null
  const sdkKey = catalog && catalog.mode !== "demo" && skill && !skill.purchased ? `${catalog.mode}:${skill.currency}` : ""

  useEffect(() => {
    setSdk(null); setSdkError("")
    if (!sdkKey) return
    const controller = new AbortController()
    const [mode, currencyCode] = sdkKey.split(":")
    const timeout = window.setTimeout(() => {
      controller.abort()
      setSdkError("PayPal took too long to load. Retry checkout; existing orders remain recoverable.")
    }, 25_000)
    void (async () => {
      try {
        const config = await api<{ clientId: string; environment: "sandbox" | "production" }>("/marketplace/paypal-sdk", undefined, "GET", controller.signal)
        if (controller.signal.aborted) return
        if (!config.clientId || config.environment !== (mode === "live" ? "production" : "sandbox")) throw new Error("Invalid SDK configuration")
        if (documentPayPalEnvironment && documentPayPalEnvironment !== config.environment) {
          setSdkError("PayPal mode changed. Save your editor work and reload this page before purchasing.")
          return
        }
        // The loader reuses window.paypal; a different mode also requires fresh document CSP.
        documentPayPalEnvironment = config.environment
        const paypal = await loadCoreSdkScript({ environment: config.environment })
        if (controller.signal.aborted) return
        if (!paypal) throw new Error("PayPal failed to load")
        const instance = await paypal.createInstance({ clientId: config.clientId, components: ["paypal-payments"], pageType: "checkout" })
        if (controller.signal.aborted) return
        const methods = await instance.findEligibleMethods({ currencyCode })
        if (controller.signal.aborted) return
        if (!methods.isEligible("paypal")) throw new Error("PayPal unavailable")
        setSdk({ key: sdkKey, instance })
      } catch {
        if (!controller.signal.aborted) setSdkError("PayPal checkout is unavailable. Retry, or use the saved order's approval link and Check payment.")
      } finally { window.clearTimeout(timeout) }
    })()
    return () => { controller.abort(); window.clearTimeout(timeout) }
  }, [sdkKey, sdkRetry])

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

  async function checkout() {
    if (!skill || !catalog || !sdk || sdk.key !== sdkKey) return
    await perform("Opening PayPal checkout...", async (signal) => {
      let expectedOrder = skill.order?.id
      let active = true
      let cleanup = () => { active = false }
      let approvalPromise: Promise<void> | undefined
      let failure: unknown
      // Keep the session tied to this selection. SDK approval is not proof of payment.
      await new Promise<void>((resolve, reject) => {
        const session = sdk.instance.createPayPalOneTimePaymentSession({
          onApprove(data) {
            if (signal.aborted || !active) return Promise.reject(new Error("Checkout closed"))
            // Some SDK paths can repeat approval. Share one verification attempt.
            approvalPromise ??= (async () => {
              try {
                if (!expectedOrder || data.orderId !== expectedOrder) throw new Error("PayPal returned a different order. Refresh to recover your original purchase.")
                setBusy("Checking and capturing payment...")
                const result = await api<{ purchased: boolean }>(`/marketplace/orders/${encodeURIComponent(expectedOrder)}/capture`, {}, "POST", signal)
                if (signal.aborted || !active) throw new Error("Checkout closed")
                if (!result.purchased) throw new Error("Payment is not complete. Full contents remain locked. You can check this same order again.")
                setCatalog((previous) => previous && { ...previous, skills: previous.skills.map((item) => item.id === skill.id ? { ...item, purchased: true, order: undefined } : item) })
                setNotice("Payment verified. You can now display the full file.")
              } catch (error) {
                if (active) failure = error
                throw error
              }
            })()
            return approvalPromise
          },
          onCancel() {
            if (!signal.aborted && active) setNotice("PayPal checkout cancelled. No file was unlocked. Your saved order can be resumed or checked safely.")
            active = false
          },
          onError() {
            if (active) failure ??= new Error("PayPal checkout failed. Refresh to recover your saved order; do not start a separate purchase.")
            active = false
          },
          onComplete() {
            // Let PayPal finish its approval/rejection handshake before destroying the session.
            active = false
            if (failure) reject(failure)
            else resolve()
          },
        })
        const abort = () => { active = false; resolve() }
        signal.addEventListener("abort", abort, { once: true })
        cleanup = () => { active = false; signal.removeEventListener("abort", abort); session.destroy() }
        const createOrder = async () => {
          if (skill.order) return { orderId: skill.order.id }
          const result = await api<Purchase>("/marketplace/orders", { skillId: skill.id }, "POST", signal)
          if (signal.aborted || !active) throw new Error("Checkout closed")
          const order = result.approvalUrl ? { id: result.id, approvalUrl: result.approvalUrl } : undefined
          if (!result.purchased && (!order || !approvalLink(order, catalog.mode))) throw new Error("No valid PayPal order was returned. Refresh the catalog to recover your purchase.")
          expectedOrder = result.id
          setCatalog((previous) => previous && { ...previous, skills: previous.skills.map((item) => item.id === skill.id ? { ...item, purchased: result.purchased, order: result.purchased ? undefined : order } : item) })
          if (result.purchased) {
            setNotice("This workspace already owns this skill. No new payment was made.")
            active = false
            resolve()
            throw new Error("Already purchased")
          }
          return { orderId: result.id }
        }
        // Start synchronously in the click gesture, passing the promise without awaiting it.
        // Popup mode avoids redirecting away from unsaved editor work or overlaying a native dialog.
        const orderPromise = createOrder()
        void orderPromise.catch((error) => { active = false; reject(error) })
        void session.start({ presentationMode: "popup", fullPageOverlay: { enabled: false } }, orderPromise)
          .catch(() => { active = false; reject(new Error("Could not open PayPal. Allow popups, or refresh to recover the saved order's approval link and Check payment.")) })
      }).finally(() => cleanup())
    })
  }

  async function reveal() {
    if (!skill?.purchased) return
    await perform("Loading full contents...", async (signal) => {
      const result = await api<{ content: string }>(`/marketplace/skills/${encodeURIComponent(skill.id)}/content`, undefined, "GET", signal)
      if (!signal.aborted) setContent(result.content)
    })
  }

  async function edit() {
    if (!skill?.purchased) return
    await perform("Opening editable copy...", async (signal) => {
      const text = content ?? (await api<{ content: string }>(`/marketplace/skills/${encodeURIComponent(skill.id)}/content`, undefined, "GET", signal)).content
      if (!signal.aborted) await onEdit(skill.id, text, signal)
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
      {catalog?.mode === "demo" && <p className="skills-note">To connect PayPal, run <code>python3 scripts/setup_marketplace.py</code> in a private terminal on the server. Credentials are prompted without echo, never in this browser or chat. See <code>docs/SKILLS_MARKETPLACE.md</code> for setup and restart instructions.</p>}
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
            {sdkKey && <div className="skills-note" aria-live="polite">{sdkError ? <><p>{sdkError}</p><button disabled={!!busy} onClick={() => setSdkRetry((value) => value + 1)}>Retry PayPal</button></> : sdk?.key !== sdkKey ? <p>Loading secure PayPal checkout...</p> : null}</div>}
            {skill.purchased ? <>
              <p>{catalog.mode === "demo" ? "Example access unlocked. No payment was made." : "Purchased for this workspace."} Full contents are available on request.</p>
              <div className="skills-purchase-actions">
                <button className="primary" disabled={!!busy} onClick={() => content === null ? void reveal() : setContent(null)} aria-expanded={content !== null} aria-controls="skills-full-content">{content === null ? "Display full contents" : "Hide full contents"}</button>
                <button disabled={!!busy} onClick={() => void edit()} aria-describedby="skills-edit-note">Enable editing</button>
              </div>
              <p id="skills-edit-note" className="skills-note">Creates a new editable workspace copy without replacing existing files. The purchased original and GitHub file stay unchanged. Normal editor saving and autosave apply; no build is started.</p>
            </> : skill.order ? <>
              <p>Resume secure PayPal checkout. Approval triggers server-verified capture. If checkout was interrupted, <strong>Check payment captures the approved payment</strong> and unlocks this file only after verification.</p>
              <div className="skills-purchase-actions">{approval ? <><button className="skills-paypal" disabled={!!busy || sdk?.key !== sdkKey} onClick={() => void checkout()}>Purchase Skills</button><a href={approval} target="_blank" rel="noopener noreferrer">Continue to PayPal <span className="skills-new-tab">(new tab fallback)</span></a></> : <p role="alert">Invalid approval link. Refresh the catalog to recover this order.</p>}<button disabled={!!busy} onClick={() => void capture()}>Check payment</button></div>
              <p className="skills-note">Order: <code>{skill.order.id}</code>. If you cancel or close PayPal, the file stays locked. Reopening this marketplace restores the same order; checking it again will not double-charge.</p>
              <details className="skills-recovery"><summary>Expired order?</summary><p className="skills-note">You can request a replacement only if PayPal confirms this order is voided and unpaid. An approved, pending, or unknown payment cannot be replaced. The original file and price are preserved.</p><button disabled={!!busy} onClick={() => void buy(true)}>Start a new order</button></details>
            </> : <>
              <div className="skills-price"><strong>{skill.currency} {skill.price}</strong><span>{catalog.mode === "demo" ? "Example price" : "One-time purchase"}</span></div>
              <button className="skills-paypal" aria-describedby="skills-payment-note" disabled={!!busy || (catalog.mode !== "demo" && sdk?.key !== sdkKey)} onClick={() => catalog.mode === "demo" ? void buy() : void checkout()}>Purchase Skills</button>
              <p id="skills-payment-note" className="skills-note">{catalog.mode === "demo" ? "Simulated purchase (no charge). Try this example without a PayPal account; no payment is made." : `${catalog.mode === "sandbox" ? "Sandbox test payment, not a real charge. " : "Live payment, real money. "}Pay with PayPal in a secure popup. Review the total before approving; approval authorizes server-side capture. If popups are blocked, your order can be recovered here.`}</p>
            </>}
          </div>
          <div id="skills-full-content" hidden={content === null}>{content !== null && <><h4>Full file contents</h4><p className="skills-note">Read-only Markdown. These instructions have not been run or added to your spec.</p><pre tabIndex={0} aria-label={`Full contents of ${skill.path}`}>{content}</pre></>}</div>
        </>}
      </section>
    </div>}
    <footer className="skills-footer">Browse, purchase, and read without changing your editor. Enable editing explicitly opens a new workspace copy; it never starts a build. Closing this dialog does not cancel an in-progress payment.</footer>
  </dialog>
}
