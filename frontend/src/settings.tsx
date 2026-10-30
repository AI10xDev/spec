import { useEffect, useRef, useState } from "react"

type Provider = "azure" | "openai" | "claude" | "openrouter" | "huggingface"
type Profile = { provider: Provider; model: string; endpoint: string; apiVersion: string }
type SettingsView = Profile & { hasApiKey: boolean; source: "environment" | "settings" | "none" }
type Api = <T>(path: string, body?: unknown, method?: string) => Promise<T>

const providers: Record<Provider, { name: string; model: string; endpoint: string; apiVersion: string }> = {
  azure: { name: "Azure OpenAI", model: "", endpoint: "", apiVersion: "2024-10-21" },
  openai: { name: "Standalone OpenAI", model: "gpt-4.1-mini", endpoint: "https://api.openai.com/v1", apiVersion: "" },
  claude: { name: "Claude API", model: "claude-sonnet-4-5", endpoint: "https://api.anthropic.com", apiVersion: "" },
  openrouter: { name: "OpenRouter", model: "openai/gpt-4.1-mini", endpoint: "https://openrouter.ai/api/v1", apiVersion: "" },
  huggingface: { name: "Local Hugging Face", model: "", endpoint: "http://127.0.0.1:8000/v1", apiVersion: "" },
}

export function Settings({ api, onClose, onChanged }: { api: Api; onClose: () => void; onChanged: () => Promise<void> }) {
  const heading = useRef<HTMLHeadingElement>(null)
  const submitting = useRef(false)
  const [saved, setSaved] = useState<SettingsView | null>(null)
  const [profile, setProfile] = useState<Profile>({ provider: "azure", model: "", endpoint: "", apiVersion: "2024-10-21" })
  const [apiKey, setApiKey] = useState("")
  const [removeKey, setRemoveKey] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [attempt, setAttempt] = useState(0)
  const retained = !!saved?.hasApiKey && profile.provider === saved.provider && profile.endpoint.trim() === saved.endpoint
  const local = profile.provider === "huggingface"
  let versionRequired = profile.provider === "azure"
  if (versionRequired) {
    try { versionRequired = !/^\/openai\/v1(?:\/responses)?\/*$/.test(new URL(profile.endpoint.trim()).pathname) } catch { /* Invalid endpoints still require a version. */ }
  }

  function receive(view: SettingsView) {
    // Copy only redacted contract fields, never an unexpected credential field.
    const { provider, model, endpoint, apiVersion, hasApiKey, source } = view
    setSaved({ provider, model, endpoint, apiVersion, hasApiKey, source })
    setProfile({ provider, model, endpoint, apiVersion })
    setApiKey("")
    setRemoveKey(false)
  }

  function failure(error: unknown, action: string) {
    // Raw server/proxy errors could echo the submitted key or request body.
    const status = (error as { status?: number } | null)?.status
    return status === 401 || status === 403
      ? `Could not ${action}: server authorization failed. Check your workspace connection and retry.`
      : status === 400 || status === 422
        ? `Could not ${action}: check the provider, model, endpoint, API version and key, then retry.`
        : `Could not ${action}. Check the server connection and retry. Existing settings have not been confirmed changed.`
  }

  useEffect(() => {
    const opener = document.activeElement
    heading.current?.focus()
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus() }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError("")
    void api<SettingsView>("/settings").then((view) => {
      if (!cancelled) receive(view)
    }).catch((error: unknown) => {
      if (!cancelled) setError(failure(error, "load settings"))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [attempt])

  async function update(reset = false) {
    if (submitting.current || loading || !saved) return
    setError("")
    setNotice("")
    if (!reset && !local && !apiKey.trim() && !retained) {
      setError("Enter an API key. A stored key can only be retained for the same provider and endpoint.")
      return
    }
    if (reset && !window.confirm("Remove the saved AI profile and use the server environment configuration? This affects future requests and builds, not running sessions.")) return
    submitting.current = true
    setBusy(true)
    try {
      const view = reset
        ? await api<SettingsView>("/settings", {}, "DELETE")
        : await api<SettingsView>("/settings", {
          provider: profile.provider, model: profile.model.trim(), endpoint: profile.endpoint.trim(),
          apiVersion: profile.provider === "azure" || profile.provider === "claude" ? profile.apiVersion.trim() : "",
          ...(local && retained && removeKey ? { apiKey: "" } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }, "PUT")
      receive(view)
      setNotice(reset
        ? view.source === "environment" ? "Saved profile removed. Server environment configuration is now active." : "Saved profile removed. No environment AI configuration is available."
        : "Settings saved. Future requests and builds will use this profile; running sessions are unchanged.")
      try { await onChanged() } catch {
        setError("Settings changed, but capability refresh failed. Return to the workspace and focus the window to retry.")
      }
    } catch (error) { setError(failure(error, reset ? "reset settings" : "save settings")) } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return <main className="settings-page" aria-labelledby="settings-heading">
    <div className="settings-content">
      <button type="button" disabled={busy} onClick={onClose}>Back to workspace</button>
      <div className="settings-heading"><span className="eyebrow">WORKSPACE / CONFIGURATION</span><h1 id="settings-heading" ref={heading} tabIndex={-1}>AI settings</h1><p>Choose the model behind your next request.</p></div>
      <p>One active saved profile is shared by this server. Saving replaces it for future AI requests and builds, not running sessions. Realtime voice is configured separately.</p>
      <div className="settings-source">Active configuration: <strong>{!saved ? "Not loaded" : saved.source === "settings" ? "Saved settings" : saved.source === "environment" ? "Server environment" : "None"}</strong>{saved && <span>{providers[saved.provider].name} / {saved.hasApiKey ? "Key configured on server" : "No key configured"}</span>}</div>
      {loading && <p role="status">Loading settings...</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {!loading && !saved && <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry loading settings</button>}
      {notice && <p role="status" className="settings-success">{notice}</p>}
      {saved && <form autoComplete="off" aria-label="AI settings" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void update() }}>
        <fieldset disabled={busy || loading}>
          <legend>Model provider</legend>
          <div className="settings-field"><label htmlFor="ai-provider">Provider</label><select id="ai-provider" value={profile.provider} onChange={(event) => {
            const provider = event.target.value as Provider
            const { model, endpoint, apiVersion } = providers[provider]
            setProfile({ provider, model, endpoint, apiVersion })
            setApiKey("")
            setRemoveKey(false)
            setError("")
            setNotice("")
          }}>{Object.entries(providers).map(([value, provider]) => <option key={value} value={value}>{provider.name}</option>)}</select></div>
          {local && <div className="settings-local" id="local-model-help"><h2>Bring a running local server</h2><p>The Hugging Face model must already be served by a running OpenAI-compatible server on your local hardware, such as vLLM or llama.cpp. There is no automatic model download or server startup.</p><p>Use its served model ID and API base URL. A loopback endpoint (localhost or 127.0.0.1) refers to each execution host: the web server for chat and completions, and the remote build host for builds, not your browser. The server must be reachable from each host that uses it.</p></div>}
          <div className="settings-field"><label htmlFor="ai-model">{profile.provider === "azure" ? "Deployment name" : "Model ID"}</label><input id="ai-model" value={profile.model} onChange={(event) => setProfile({ ...profile, model: event.target.value })} required pattern=".*\S.*" placeholder={profile.provider === "azure" ? "Your Azure deployment name" : local ? "Model ID served by your local server" : providers[profile.provider].model} aria-describedby="model-help" /><small id="model-help">{profile.provider === "azure" ? "Use the deployment name from your Azure resource, not the underlying model name." : "Defaults are examples. Choose a model available on your provider or server."}</small></div>
          <div className="settings-field"><label htmlFor="ai-endpoint">{profile.provider === "azure" ? "Azure resource endpoint" : "API base URL"}</label><input id="ai-endpoint" type="url" value={profile.endpoint} onChange={(event) => { setProfile({ ...profile, endpoint: event.target.value }); setRemoveKey(false) }} required placeholder={profile.provider === "azure" ? "https://your-resource.openai.azure.com" : providers[profile.provider].endpoint} aria-describedby="endpoint-help" /><small id="endpoint-help">Use a trusted {local ? "local server" : "provider"} endpoint without credentials, query parameters, or a chat/completions suffix. API keys are sent to this endpoint.</small></div>
          {(profile.provider === "azure" || profile.provider === "claude") && <div className="settings-field"><label htmlFor="ai-version">API version{versionRequired ? "" : " (optional)"}</label><input id="ai-version" value={profile.apiVersion} onChange={(event) => setProfile({ ...profile, apiVersion: event.target.value })} required={versionRequired} pattern=".*\S.*" placeholder={profile.provider === "claude" ? "2023-06-01" : "2024-10-21"} aria-describedby="version-help" /><small id="version-help">{profile.provider === "claude" ? "Leave blank to use the default Anthropic API version (2023-06-01)." : "Required for legacy Azure resource roots. Optional for /openai/v1 and /openai/v1/responses endpoints."}</small></div>}
          <div className="settings-field"><label htmlFor="ai-key">API key{local ? " (optional)" : ""}</label><input id="ai-key" type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" disabled={local && retained && removeKey} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={retained ? "Leave blank to retain the configured key" : local ? "Only if your local server requires one" : "Enter a key for this provider and endpoint"} aria-describedby="key-help key-storage" /><small id="key-help">{retained ? "A key is configured for this provider and endpoint. Leave blank to keep it, or enter a replacement." : local ? "No key is required for an unauthenticated local server." : "A key is required. Changing provider or endpoint requires a new key."}</small><small id="key-storage">Keys are stored only on the server and are never returned by the settings API. This page does not persist them in browser storage or log them. Entered keys are cleared after a successful save or when leaving this page.</small></div>
          {local && retained && <p><label><input type="checkbox" checked={removeKey} onChange={(event) => { setRemoveKey(event.target.checked); setApiKey("") }} /> Remove configured API key on save</label></p>}
          <div className="settings-actions"><button className="primary" type="submit">{busy ? "Applying..." : "Save settings"}</button><button type="button" disabled={saved.source !== "settings"} onClick={() => void update(true)}>Reset to environment</button></div>
        </fieldset>
        <p className="settings-footnote">Reset removes the saved profile and restores server environment defaults, if available. Saving does not test connectivity or download a model.</p>
      </form>}
    </div>
  </main>
}
