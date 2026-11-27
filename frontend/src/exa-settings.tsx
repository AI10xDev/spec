import { useEffect, useRef, useState } from "react"

export type ExaPreferences = { enabled: boolean; numResults: number; domainMode: "any" | "include" | "exclude"; domains: string[] }
type View = { preferences: ExaPreferences; hasApiKey: boolean; hasSavedKey: boolean; keySource: "settings" | "environment" | "none"; preferenceSource: "settings" | "defaults" }
type Api = <T>(path: string, body?: unknown, method?: string) => Promise<T>
const defaults: ExaPreferences = { enabled: true, numResults: 10, domainMode: "any", domains: [] }

export function exaDomains(raw: string, mode: ExaPreferences["domainMode"]): string[] | null {
  if (mode === "any") return []
  const domains = [...new Set(raw.split(/[\s,]+/).filter(Boolean).map((s) => s.toLowerCase()))]
  if (!domains.length || domains.length > 20 || domains.some((domain) => domain.length > 253 || !domain.includes(".")
    || !/[a-z]/.test(domain.split(".").at(-1)!)
    || domain.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) return null
  return domains
}

export function ExaSettings({ api, onBusy }: { api: Api; onBusy: (busy: boolean) => void }) {
  const mounted = useRef(false)
  const submitting = useRef(false)
  const [saved, setSaved] = useState<View | null>(null)
  const [preferences, setPreferences] = useState<ExaPreferences>(defaults)
  const [pages, setPages] = useState("10")
  const [domains, setDomains] = useState("")
  const [key, setKey] = useState("")
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  function receive(view: View) {
    // Retain only the redacted contract; never copy unexpected credential fields.
    const { enabled, numResults, domainMode, domains } = view.preferences
    const preferences = { enabled, numResults, domainMode, domains: [...domains] }
    setSaved({ preferences, hasApiKey: view.hasApiKey, hasSavedKey: view.hasSavedKey, keySource: view.keySource, preferenceSource: view.preferenceSource })
    setPreferences(preferences); setPages(String(numResults)); setDomains(domains.join("\n")); setKey("")
  }
  function failure(error: unknown) {
    const status = (error as { status?: number } | null)?.status
    return status === 401 || status === 403
      ? "Exa settings authorization failed. Check your workspace connection and retry."
      : status === 400 || status === 422
        ? "Could not save Exa settings. Check the key, returned pages and plain domain names."
        : "Could not confirm Exa settings. Check the server connection; unsafe or malformed private storage requires operator repair and restart. Reload settings before retrying an uncertain save."
  }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError("")
    void api<View>("/settings/research").then((view) => {
      if (!cancelled) receive(view)
    }).catch((error: unknown) => { if (!cancelled) setError(failure(error)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [attempt])
  useEffect(() => {
    if (!busy) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [busy])

  async function update(action: "save" | "remove" | "reset") {
    if (submitting.current || loading || !saved) return
    setError(""); setNotice("")
    const normalized = exaDomains(domains, preferences.domainMode)
    if (action === "save" && (!/^([1-9]|10)$/.test(pages) || normalized === null || key.length > 4096 || (key !== "" && !/^[\x21-\x7e]+$/.test(key)))) {
      setError("Use 1–10 returned pages, at most 20 plain domain names, and an ASCII key without spaces or control characters.")
      return
    }
    if (action !== "save" && !window.confirm(action === "reset"
      ? "Reset all saved Exa settings and remove the saved key? Defaults and the server environment key (if present) will become active. Unsaved Exa edits are discarded; model and storage settings are unchanged."
      : "Remove only the saved Exa key? The server environment key (if present) will become active. Saved Exa preferences are retained; unsaved Exa edits are discarded.")) return
    submitting.current = true; setBusy(true); onBusy(true)
    try {
      const view = await api<View>("/settings/research", action === "reset" ? {} : action === "remove"
        ? { preferences: saved.preferences, apiKey: "" }
        : { preferences: { ...preferences, numResults: Number(pages), domains: normalized }, ...(key ? { apiKey: key } : {}) }, action === "reset" ? "DELETE" : "PUT")
      if (!mounted.current) return
      receive(view)
      setNotice(`Exa settings ${action === "reset" ? "reset" : action === "remove" ? "updated; saved key removed" : "saved"}. ${view.hasApiKey ? `Key source: ${view.keySource === "environment" ? "server environment" : "saved settings"}.` : "No key is configured."} ${view.preferences.enabled ? "Future research uses these settings." : "New research is disabled."} No connectivity check or paid query was made; already-submitted work is unchanged.`)
    } catch (error) {
      if (mounted.current) setError(failure(error))
    } finally {
      submitting.current = false
      if (mounted.current) { setBusy(false); onBusy(false) }
    }
  }

  return <section aria-labelledby="exa-heading">
    <h2 id="exa-heading">Exa Deep Search</h2>
    <p>Exa Deep Search researches a question through multiple web searches and returns a synthesized answer with source citations. Your submitted question and search filters are sent to Exa; usage may incur charges. Research is read-only and never edits your spec or starts a build.</p>
    <p>Independent of model profiles and build approvals. <a href="https://exa.ai/docs/search/deep-search" target="_blank" rel="noopener noreferrer">Exa Deep Search documentation</a> · <a href="https://dashboard.exa.ai/api-keys" target="_blank" rel="noopener noreferrer">Get an Exa API key</a></p>
    {loading && <p role="status">Loading Exa settings...</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="settings-success">{notice}</p>}
    {!loading && !busy && <button type="button" onClick={() => { setSaved(null); setKey(""); setNotice(""); setAttempt((n) => n + 1) }}>{saved ? "Reload Exa settings" : "Retry loading Exa settings"}</button>}
    {saved && <form autoComplete="off" aria-label="Exa settings" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void update("save") }}>
      <p>Key: <strong>{saved.hasApiKey ? "Configured on server (not connectivity verified)" : "Not configured"}</strong>. Active key source: {saved.keySource}. Saved key override: {saved.hasSavedKey ? "yes" : "no"}. Preferences: {saved.preferenceSource}.</p>
      <fieldset disabled={busy || loading}>
        <legend>Server-wide research settings</legend>
        <p><label><input type="checkbox" checked={preferences.enabled} onChange={(event) => setPreferences({ ...preferences, enabled: event.target.checked })} /> Enable Deep Search</label></p>
        <p>Disabling blocks new submissions, even with an environment key. It does not revoke keys or cancel provider work already submitted.</p>
        <div className="settings-field"><label htmlFor="exa-key">Exa API key</label><input id="exa-key" type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={4096} value={key} onChange={(event) => setKey(event.target.value)} placeholder="Leave blank to keep the current key source" aria-describedby="exa-key-help" /><small id="exa-key-help">A saved key overrides EXA_API_KEY. Blank retains the saved override; Remove saved key returns to the environment fallback. Keys stay in a restricted server file (not encrypted), never returned by this API or saved in browser storage. Entered keys are cleared on successful save or leaving Settings.</small></div>
        <div className="settings-field"><label htmlFor="exa-pages">Returned pages</label><input id="exa-pages" type="number" min={1} max={10} step={1} required value={pages} onChange={(event) => setPages(event.target.value)} aria-describedby="exa-pages-help" /><small id="exa-pages-help">1–10 is this app’s limit. Exa may return fewer pages. This is not an internal-search count or a spending cap.</small></div>
        <div className="settings-field"><label htmlFor="exa-filter">Source filter</label><select id="exa-filter" value={preferences.domainMode} onChange={(event) => setPreferences({ ...preferences, domainMode: event.target.value as ExaPreferences["domainMode"] })}><option value="any">Any domain</option><option value="include">Include domains</option><option value="exclude">Exclude domains</option></select></div>
        {preferences.domainMode !== "any" && <div className="settings-field"><label htmlFor="exa-domains">Domain names</label><textarea id="exa-domains" rows={3} maxLength={6000} value={domains} onChange={(event) => setDomains(event.target.value)} aria-describedby="exa-domains-help" /><small id="exa-domains-help">Up to 20 plain dotted DNS names, separated by commas or whitespace (example.org, docs.example.com). ASCII/punycode only; no URLs, IP addresses, ports, paths or wildcards. Filters may reduce available evidence. Include and exclude cannot be combined.</small></div>}
        <div className="settings-actions"><button type="submit" className="primary">{busy ? "Applying Exa settings..." : "Save Exa settings"}</button><button type="button" disabled={!saved.hasSavedKey} onClick={() => void update("remove")}>Remove saved key</button><button type="button" disabled={saved.preferenceSource !== "settings"} onClick={() => void update("reset")}>Reset Exa settings</button></div>
      </fieldset>
      <p className="settings-footnote">Shared by all authorized browsers on this server; the last successful save wins. Future submissions capture current server settings, which another browser may change. Saving/resetting makes no Exa request. Environment changes require restart. While saving, wait before navigating away; closing the browser does not cancel a server-side save.</p>
    </form>}
  </section>
}
