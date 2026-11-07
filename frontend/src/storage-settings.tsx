import { useEffect, useRef, useState } from "react"

type View = { accountName: string; containerName: string; hasAccountKey: boolean }
type Counts = { uploaded: number; skipped: number; failed: number }
type Api = <T>(path: string, body?: unknown, method?: string) => Promise<T>

export function StorageSettings({ api }: { api: Api }) {
  const submitting = useRef(false)
  const [saved, setSaved] = useState<View | null>(null)
  const [accountName, setAccountName] = useState("")
  const [containerName, setContainerName] = useState("")
  const [accountKey, setAccountKey] = useState("")
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [attempt, setAttempt] = useState(0)
  const retained = !!saved?.hasAccountKey && accountName.trim() === saved.accountName
  const dirty = accountName.trim() !== saved?.accountName || containerName.trim() !== saved?.containerName || !!accountKey

  function receive(view: View) {
    const { accountName, containerName, hasAccountKey } = view
    setSaved({ accountName, containerName, hasAccountKey })
    setAccountName(accountName)
    setContainerName(containerName)
    setAccountKey("")
  }

  function failure(error: unknown, action: string) {
    // Never display upstream text: proxies can echo submitted credentials.
    const status = (error as { status?: number } | null)?.status
    if (action === "upload specs" && status === 412) {
      return "Storage destination changed. No specs were uploaded by this request. Return to the workspace and reopen Settings to reload the destination, then confirm the upload again."
    }
    const help = status === 401 || status === 403
      ? "Workspace authorization failed. Reconnect and retry."
      : status === 400 || status === 422
        ? "Check the storage account name, container name and account access key."
        : status === 409
          ? "The container must be private and no other storage operation can be in progress."
          : "Check the server connection, Azure credentials and existing private container, then retry."
    return `Could not ${action}. ${help}${action === "upload specs" ? " Some blobs may already have uploaded; retrying overwrites matching names." : ""}`
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError("")
    void api<View>("/settings/storage").then((view) => {
      if (!cancelled) receive(view)
    }).catch((error: unknown) => {
      if (!cancelled) setError(failure(error, "load storage settings"))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [attempt])

  async function act(action: "save" | "remove" | "upload") {
    if (submitting.current || loading || !saved) return
    setError("")
    setNotice("")
    if (action === "save" && !accountKey.trim() && !retained) {
      setError("Enter a storage account access key. A stored key can only be retained for the same account.")
      return
    }
    if (action === "upload" && (dirty || !saved.hasAccountKey)) return
    if (action === "upload" && !window.confirm(`Upload all saved workspace specs to ${saved.accountName}/${saved.containerName}? Matching blob names will be overwritten. Unsaved editor changes are not included.`)) return
    if (action === "remove" && !window.confirm("Remove the saved Azure storage settings and key? Existing Azure blobs will not be deleted.")) return
    submitting.current = true
    setBusy(action)
    try {
      if (action === "upload") {
        const counts = await api<Counts>("/settings/storage/upload", {
          accountName: saved.accountName, containerName: saved.containerName,
        }, "POST")
        setNotice(`Upload finished: ${counts.uploaded} uploaded, ${counts.skipped} skipped, ${counts.failed} failed.`)
        if (counts.failed) setError("Some specs could not be uploaded. Check the Azure connection and retry; matching blob names will be overwritten.")
      } else {
        receive(await api<View>("/settings/storage", action === "remove" ? {} : {
          accountName: accountName.trim(), containerName: containerName.trim(),
          ...(accountKey.trim() ? { accountKey: accountKey.trim() } : {}),
        }, action === "remove" ? "DELETE" : "PUT"))
        setNotice(action === "remove" ? "Storage settings removed. Existing Azure blobs are unchanged." : "Storage settings saved. Choose Upload all specs to check privacy and upload; saving alone sends no specs.")
      }
    } catch (error) {
      setError(failure(error, action === "upload" ? "upload specs" : `${action} storage settings`))
    } finally {
      submitting.current = false
      setBusy("")
    }
  }

  return <section aria-labelledby="storage-heading">
    <h2 id="storage-heading">Azure Blob Storage</h2>
    <p>Upload saved workspace specs as private block blobs to an existing container in Azure public cloud. This is independent of your AI provider.</p>
    <p>Uploads include top-level UTF-8 documents up to 2 MiB, including extensionless specs. Logs (.out), Agent.md, hidden files, folders, symlinks and unsupported files are skipped. Save editor changes before uploading.</p>
    {loading && <p role="status">Loading storage settings...</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="settings-success">{notice}</p>}
    {!loading && !saved && <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry loading storage settings</button>}
    {saved && <form autoComplete="off" aria-label="Azure storage settings" aria-busy={!!busy} onSubmit={(event) => { event.preventDefault(); void act("save") }}>
      <fieldset disabled={!!busy || loading}>
        <legend>Private spec uploads</legend>
        <div className="settings-field"><label htmlFor="storage-account">Storage account name</label><input id="storage-account" value={accountName} onChange={(event) => setAccountName(event.target.value)} required pattern="[a-z0-9]{3,24}" maxLength={24} autoCapitalize="none" spellCheck={false} aria-describedby="storage-account-help" /><small id="storage-account-help">3-24 lowercase letters or digits, not a URL. Changing accounts requires a new key.</small></div>
        <div className="settings-field"><label htmlFor="storage-container">Container name</label><input id="storage-container" value={containerName} onChange={(event) => setContainerName(event.target.value)} required minLength={3} maxLength={63} pattern="[a-z0-9]+(-[a-z0-9]+)*" autoCapitalize="none" spellCheck={false} aria-describedby="storage-container-help" /><small id="storage-container-help">Use an existing private container. Anonymous blob or container access is rejected; the app does not change Azure permissions.</small></div>
        <div className="settings-field"><label htmlFor="storage-key">Storage account key</label><input id="storage-key" type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} value={accountKey} onChange={(event) => setAccountKey(event.target.value)} placeholder={retained ? "Leave blank to retain the configured key" : "Enter either Azure account access key"} aria-describedby="storage-key-help" /><small id="storage-key-help">{retained ? "A key is configured for this account. Leave blank to keep it, or enter a replacement. " : "Use key1 or key2, not an Azure OpenAI key, connection string or SAS token. "}Keys are stored only on the server, never returned by the API or saved in browser storage, and cleared from this form after saving.</small></div>
        <div className="settings-actions">
          <button type="submit" className="primary">{busy === "save" ? "Saving storage settings..." : "Save storage settings"}</button>
          <button type="button" disabled={!saved.hasAccountKey || dirty} onClick={() => void act("upload")}>{busy === "upload" ? "Uploading specs..." : "Upload all specs"}</button>
          <button type="button" disabled={!saved.hasAccountKey} onClick={() => void act("remove")}>Remove storage settings</button>
        </div>
        {dirty && saved.hasAccountKey && <p className="settings-footnote">Save storage changes before uploading.</p>}
      </fieldset>
      <p className="settings-footnote">Uploads overwrite matching blob names, leave local files and other blobs unchanged, and continue if you leave this page. There is no automatic sync. Privacy is checked before each upload; keep anonymous access disabled in Azure afterwards.</p>
    </form>}
  </section>
}
