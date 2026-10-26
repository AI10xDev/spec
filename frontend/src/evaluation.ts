export type Metric = { name: string; samples: { line: number; value: number }[] }
export type Metrics = { metrics: Metric[]; lines: number; errors: number; warnings: number; diagnostics: string[]; incomplete: boolean }
export type Check = { name: string; metric: string; aggregate: "last" | "mean" | "min" | "max" | "sum" | "count"; operator: ">=" | "<=" | ">" | "<" | "=="; threshold: number }
export type Suite = { version: 1; kind: "eval"; spec: string; checks: Check[] }
export type Result = Check & { value: number | null; status: "pass" | "fail" | "inconclusive" }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function parseSuite(content: string, spec: string): Suite {
  if (new TextEncoder().encode(content).length > 64 * 1024) throw new Error("Evaluation spec exceeds 64 KiB.")
  let value: unknown
  try { value = JSON.parse(content) } catch { throw new Error("Not an evaluation spec: expected JSON with kind: eval and version: 1.") }
  if (!object(value) || value.kind !== "eval" || value.version !== 1 || Object.keys(value).some((key) => !["kind", "version", "spec", "checks"].includes(key))) throw new Error("Not a supported evaluation spec: expected only kind, version, spec and checks.")
  if (value.spec !== spec) throw new Error(`Evaluation spec does not pertain to ${spec}. Its spec field must match exactly.`)
  if (!Array.isArray(value.checks) || !value.checks.length || value.checks.length > 64) throw new Error("Evaluation spec must contain 1 to 64 checks.")
  const names = new Set<string>()
  for (const check of value.checks) {
    if (!object(check) || Object.keys(check).some((key) => !["name", "metric", "aggregate", "operator", "threshold"].includes(key)) ||
      typeof check.name !== "string" || !check.name.trim() || check.name.length > 120 || names.has(check.name) ||
      typeof check.metric !== "string" || !check.metric.trim() || check.metric.length > 160 ||
      typeof check.aggregate !== "string" || !["last", "mean", "min", "max", "sum", "count"].includes(check.aggregate) ||
      typeof check.operator !== "string" || ![">=", "<=", ">", "<", "=="].includes(check.operator) || typeof check.threshold !== "number" || !Number.isFinite(check.threshold)) {
      throw new Error("Invalid evaluation check: use unique names, a metric, a supported aggregate/operator and a finite threshold. Commands and expressions are not supported.")
    }
    names.add(check.name)
  }
  return value as unknown as Suite
}

// Report text is evidence, never executable instructions. Only explicit numeric events
// are measurements; ordinary prose and process exit codes do not imply task success.
export function extractMetrics(output: string): Metrics {
  const result: Metrics = { metrics: [], lines: 0, errors: 0, warnings: 0, diagnostics: [], incomplete: false }
  const metrics = new Map<string, Metric>()
  let samples = 0
  let invalid = 0
  let limited = false
  const add = (name: string, value: unknown, line: number) => {
    if (typeof value !== "number" || !Number.isFinite(value) || !name.trim() || name.length > 160) { invalid++; return }
    if (samples >= 100_000 || (!metrics.has(name) && metrics.size >= 32)) { limited = true; return }
    const metric = metrics.get(name) ?? { name, samples: [] }
    metric.samples.push({ line, value })
    metrics.set(name, metric)
    samples++
  }
  for (const raw of output.split("\n")) {
    const line = raw.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "").trim()
    if (!line) continue
    result.lines++
    if (/\b(?:error|failed|failure|fatal)\b/i.test(line)) result.errors++
    if (/\b(?:warn|warning)\b/i.test(line)) result.warnings++
    if (!line.startsWith("{")) continue
    if (line.length > 64 * 1024) { limited = true; continue }
    let event: unknown
    try { event = JSON.parse(line) } catch { invalid++; continue }
    if (!object(event)) continue
    if (event.event === "eval" && object(event.metrics)) {
      for (const [name, value] of Object.entries(event.metrics)) add(name, value, result.lines)
    } else if (typeof event.event === "string" && ["baseline", "iteration", "final"].includes(event.event) && typeof event.objective === "string") {
      for (const field of ["score", "gain", "cumulative_gain", "marginal_difference"]) {
        if (Object.hasOwn(event, field)) add(`${event.objective}.${field}`, event[field], result.lines)
      }
    } else if (event.event === "eval") invalid++
  }
  result.metrics = [...metrics.values()]
  if (invalid) result.diagnostics.push(`${invalid} malformed JSON records or invalid measurements ignored; evaluation is inconclusive.`)
  if (limited) result.diagnostics.push("Metric extraction limit reached (32 metrics, 100,000 samples, 64 KiB per JSON record); evaluation is inconclusive.")
  result.incomplete = invalid > 0 || limited
  return result
}

export function evaluate(suite: Suite, metrics: Metrics, incomplete: boolean): Result[] {
  return suite.checks.map((check) => {
    const samples = metrics.metrics.find((metric) => metric.name === check.metric)?.samples ?? []
    let value: number | null = null
    if (samples.length) {
      switch (check.aggregate) {
        case "last": value = samples.at(-1)!.value; break
        case "count": value = samples.length; break
        case "min": value = samples.reduce((a, b) => Math.min(a, b.value), Infinity); break
        case "max": value = samples.reduce((a, b) => Math.max(a, b.value), -Infinity); break
        case "sum": value = samples.reduce((a, b) => a + b.value, 0); break
        case "mean": value = samples.reduce((a, b) => a + b.value / samples.length, 0); break
      }
    }
    if (value === null || !Number.isFinite(value) || incomplete || metrics.incomplete) return { ...check, value: Number.isFinite(value) ? value : null, status: "inconclusive" }
    const passed = check.operator === ">=" ? value >= check.threshold : check.operator === "<=" ? value <= check.threshold : check.operator === ">" ? value > check.threshold : check.operator === "<" ? value < check.threshold : value === check.threshold
    return { ...check, value, status: passed ? "pass" : "fail" }
  })
}
