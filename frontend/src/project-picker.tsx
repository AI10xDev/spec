import { useEffect, useRef, useState } from "react"

export type ProjectSearch = {
  projects: { name: string; path: string }[]
  truncated: boolean
  agent: "explore"
  root: string
}

type Props = {
  value: string
  onChange: (value: string) => void
  search: (query: string, signal: AbortSignal) => Promise<ProjectSearch>
  onSearchingChange: (searching: boolean) => void
  disabled: boolean
}

export function ProjectPicker({ value, onChange, search, onSearchingChange, disabled }: Props) {
  const request = useRef<AbortController | null>(null)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ProjectSearch | null>(null)
  const [error, setError] = useState("")

  useEffect(() => () => {
    request.current?.abort()
    request.current = null
    onSearchingChange(false)
  }, [onSearchingChange])

  async function explore() {
    if (disabled || request.current) return
    const query = value.trim()
    setResult(null)
    setError("")
    if (!query || new TextEncoder().encode(query).length > 100 || /[\p{C}\p{Zl}\p{Zp}/\\]/u.test(query) || query === "." || query === "..") {
      setError("Search by project name: 1 to 100 UTF-8 bytes of printable text, not a path. You can still enter a path manually and run pipelines.")
      return
    }
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    onSearchingChange(true)
    try {
      const found = await search(query, controller.signal)
      if (request.current === controller && !controller.signal.aborted) setResult(found)
    } catch (error) {
      if (request.current === controller && !controller.signal.aborted) {
        setError(`Project search failed: ${error instanceof Error ? error.message : String(error)}. Try Search with Explore again, or enter a path manually.`)
      }
    } finally {
      // An obsolete request must not clear a newer request's loading state.
      if (request.current === controller) {
        request.current = null
        setLoading(false)
        onSearchingChange(false)
      }
    }
  }

  return <div className="project-picker">
    <label htmlFor="performance-project">Project folder</label>
    <div className="project-search-controls">
      <input id="performance-project" autoFocus aria-describedby="performance-path project-search-note" placeholder="my-project or /remote/path/to/project" value={value} disabled={disabled} onChange={(event) => {
        request.current?.abort()
        request.current = null
        setLoading(false)
        onSearchingChange(false)
        setResult(null)
        setError("")
        onChange(event.target.value)
      }} />
      <button type="button" disabled={disabled || loading} onClick={() => void explore()}>Search with Explore</button>
    </div>
    <p id="performance-path">Relative to the remote workspace, or an absolute remote path. To search, enter a project name instead.</p>
    <p id="project-search-note">Only Search with Explore calls the configured remote model and may incur costs. Project names are sent, not file contents.</p>
    {loading && <p role="status">Searching with Explore... This can take up to a minute. Edit the folder or close Performance to dismiss; a submitted model request may still finish.</p>}
    {error && <div role="alert" className="error">{error}</div>}
    {result && <>
      <p role="status">{result.projects.length ? `${result.projects.length} matching projects.` : "No matching projects. Try another name or enter a path manually."} Search root: <code>{result.root}</code></p>
      {result.truncated && <p>Results are truncated (at most 20 shown). Refine the project name to narrow your search.</p>}
      {!!result.projects.length && <>
        <label htmlFor="matching-projects">Matching projects</label>
        <select id="matching-projects" value={result.projects.some((project) => project.path === value) ? value : ""} disabled={disabled} onChange={(event) => { if (event.target.value) onChange(event.target.value) }}>
          <option value="">Choose a project</option>
          {result.projects.map((project) => <option key={project.path} value={project.path}>{project.name} - {project.path}</option>)}
        </select>
      </>}
    </>}
  </div>
}
