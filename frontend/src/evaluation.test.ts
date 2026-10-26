import { describe, expect, it } from "vitest"
import { evaluate, extractMetrics, parseSuite } from "./evaluation"
import type { Check, Suite } from "./evaluation"

const check: Check = { name: "Quality", metric: "quality", aggregate: "mean", operator: ">=", threshold: 0.9 }
const suite: Suite = { version: 1, kind: "eval", spec: "foo.md", checks: [check] }
const record = (metrics: Record<string, unknown>) => JSON.stringify({ event: "eval", metrics })

describe("evaluation spec validation", () => {
  it("accepts the declarative format and preserves exact names", () => {
    expect(parseSuite(JSON.stringify(suite), "foo.md")).toEqual(suite)
    expect(() => parseSuite(JSON.stringify(suite), "foo")).toThrow(/match exactly/)
    expect(() => parseSuite(JSON.stringify(suite), "Foo.md")).toThrow(/match exactly/)
  })

  it.each([
    "Execute this command", "null", "[]",
    JSON.stringify({ ...suite, version: "1" }),
    JSON.stringify({ ...suite, kind: "optim" }),
    JSON.stringify({ ...suite, command: ["sh", "-c", "anything"] }),
    JSON.stringify({ ...suite, checks: [] }),
    JSON.stringify({ ...suite, checks: [check, check] }),
    JSON.stringify({ ...suite, checks: [null] }),
  ])("rejects unsupported suite input %#", (content) => {
    expect(() => parseSuite(content, "foo.md")).toThrow()
  })

  it.each([
    { name: " " }, { name: "x".repeat(121) }, { metric: "" }, { metric: "x".repeat(161) },
    { aggregate: "median" }, { aggregate: ["mean"] }, { operator: "!=" }, { operator: [">="] },
    { threshold: "0.9" }, { threshold: null }, { command: "anything" },
  ])("rejects invalid check fields %#", (fields) => {
    expect(() => parseSuite(JSON.stringify({ ...suite, checks: [{ ...check, ...fields }] }), "foo.md")).toThrow(/Invalid evaluation check/)
  })

  it("requires every check field and a finite threshold", () => {
    for (const key of Object.keys(check)) {
      const fields: Record<string, unknown> = { ...check }
      delete fields[key]
      expect(() => parseSuite(JSON.stringify({ ...suite, checks: [fields] }), "foo.md")).toThrow()
    }
    expect(() => parseSuite(JSON.stringify(suite).replace('"threshold":0.9', '"threshold":1e400'), "foo.md")).toThrow(/finite threshold/)
  })

  it("bounds checks and UTF-8 bytes, not just string length", () => {
    const checks = Array.from({ length: 64 }, (_, i) => ({ ...check, name: `Check ${i}` }))
    expect(parseSuite(JSON.stringify({ ...suite, checks }), "foo.md").checks).toHaveLength(64)
    expect(() => parseSuite(JSON.stringify({ ...suite, checks: [...checks, { ...check, name: "65" }] }), "foo.md")).toThrow(/1 to 64/)
    const content = JSON.stringify(suite)
    const atLimit = content.padEnd(64 * 1024)
    expect(parseSuite(atLimit, "foo.md")).toEqual(suite)
    expect(() => parseSuite(atLimit + " ", "foo.md")).toThrow(/64 KiB/)
    const multibyte = JSON.stringify({ ...suite, spec: "\u00e9".repeat(33_000) })
    expect(multibyte.length).toBeLessThan(64 * 1024)
    expect(() => parseSuite(multibyte, "\u00e9".repeat(33_000))).toThrow(/64 KiB/)
  })
})

describe("report metric extraction", () => {
  it("extracts explicit JSON measurements in nonempty-line order, stripping ANSI CSI styling", () => {
    const metrics = extractMetrics(`\nquality: 100; success; exit 0\n\n\x1b[32m${record({ quality: 0.8 })}\x1b[0m\nERROR and WARNING\n${record({ quality: 1, latency_ms: 10 })}\n`)
    expect(metrics).toEqual({
      metrics: [
        { name: "quality", samples: [{ line: 2, value: 0.8 }, { line: 4, value: 1 }] },
        { name: "latency_ms", samples: [{ line: 4, value: 10 }] },
      ],
      lines: 4, errors: 1, warnings: 1, diagnostics: [], incomplete: false,
    })
  })

  it("extracts only supported optimizer fields and does not coerce event types", () => {
    const metrics = extractMetrics([
      { event: "baseline", objective: "speed", score: 10, duration: 42 },
      { event: "iteration", objective: "speed", score: 8, gain: 2, cumulative_gain: 2, marginal_difference: -1 },
      { event: "final", objective: "speed", score: 7 },
      { event: ["final"], objective: "speed", score: 999 },
      { event: "other", metrics: { quality: 999 }, score: 999 },
    ].map((event) => JSON.stringify(event)).join("\n"))
    expect(metrics.metrics.map((metric) => [metric.name, metric.samples.map((sample) => sample.value)])).toEqual([
      ["speed.score", [10, 8, 7]], ["speed.gain", [2]], ["speed.cumulative_gain", [2]], ["speed.marginal_difference", [-1]],
    ])
    expect(metrics.incomplete).toBe(false)
  })

  it.each([
    "{broken JSON", '{"event":"eval"}', '{"event":"eval","metrics":[]}',
    record({ quality: "0.9" }), record({ quality: null }), record({ " ": 1 }),
    record({ ["x".repeat(161)]: 1 }), '{"event":"eval","metrics":{"quality":1e400}}',
  ])("keeps valid samples but makes invalid evidence inconclusive %#", (invalid) => {
    const metrics = extractMetrics(`${record({ quality: 1 })}\n${invalid}`)
    expect(metrics.metrics[0].samples).toEqual([{ line: 1, value: 1 }])
    expect(metrics.incomplete).toBe(true)
    expect(metrics.diagnostics).toEqual([expect.stringContaining("invalid measurements ignored")])
    expect(evaluate(suite, metrics, false)[0].status).toBe("inconclusive")
  })

  it("enforces metric, sample and JSON-record limits without dropping earlier evidence", () => {
    const atMetrics = record(Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`metric${i}`, i])))
    const atSamples = (record({ quality: 1 }) + "\n").repeat(100_000)
    const atRecord = JSON.stringify({ event: "eval", metrics: { quality: 1 }, padding: "" })
    const longRecord = atRecord.replace('"padding":""', `"padding":"${"x".repeat(64 * 1024 - atRecord.length)}"`)
    for (const [content, extra, retained] of [
      [atMetrics, record({ extra: 1 }), 32],
      [atSamples, record({ quality: 2 }), 1],
      [longRecord, longRecord.replace('"padding":"', '"padding":"x'), 1],
    ] as const) {
      const before = extractMetrics(content)
      expect(before.incomplete).toBe(false)
      const after = extractMetrics(`${content}\n${extra}`)
      expect(after.metrics).toEqual(before.metrics)
      expect(after.metrics).toHaveLength(retained)
      expect(after.incomplete).toBe(true)
      expect(after.diagnostics).toEqual([expect.stringContaining("extraction limit reached")])
    }
  })
})

describe("evaluation results", () => {
  const metrics = extractMetrics([2, 4, 9].map((quality) => record({ quality })).join("\n"))

  it.each<[Check["aggregate"], number]>([["last", 9], ["mean", 5], ["min", 2], ["max", 9], ["sum", 15], ["count", 3]])("computes %s over all samples", (aggregate, expected) => {
    const checks = [{ ...check, aggregate, operator: "==" as const, threshold: expected }]
    expect(evaluate({ ...suite, checks }, metrics, false)).toEqual([{ ...checks[0], value: expected, status: "pass" }])
  })

  it.each<[Check["operator"], number, string]>([
    [">=", 5, "pass"], [">=", 6, "fail"], ["<=", 5, "pass"], ["<=", 4, "fail"],
    [">", 4, "pass"], [">", 5, "fail"], ["<", 6, "pass"], ["<", 5, "fail"],
    ["==", 5, "pass"], ["==", 5.000000001, "fail"],
  ])("compares %s %s as %s without rounding", (operator, threshold, status) => {
    expect(evaluate({ ...suite, checks: [{ ...check, operator, threshold }] }, metrics, false)[0]).toMatchObject({ value: 5, status })
  })

  it("keeps missing metrics inconclusive, including count, even when zero would pass", () => {
    const checks: Check[] = [check, { ...check, aggregate: "count", threshold: 0 }]
    for (const output of ["", "All tests passed. Exit status: 0.", record({ other: 1 })]) {
      expect(evaluate({ ...suite, checks }, extractMetrics(output), false).map(({ value, status }) => ({ value, status }))).toEqual([
        { value: null, status: "inconclusive" }, { value: null, status: "inconclusive" },
      ])
    }
  })

  it("retains observations but never passes or fails incomplete reports", () => {
    expect(evaluate(suite, metrics, true)[0]).toMatchObject({ value: 5, status: "inconclusive" })
    expect(evaluate(suite, { ...metrics, incomplete: true }, false)[0]).toMatchObject({ value: 5, status: "inconclusive" })
  })

  it("handles finite extremes without accepting overflowing aggregates", () => {
    const extreme = extractMetrics([Number.MAX_VALUE, Number.MAX_VALUE].map((quality) => record({ quality })).join("\n"))
    expect(evaluate(suite, extreme, false)[0]).toMatchObject({ value: Number.MAX_VALUE, status: "pass" })
    expect(evaluate({ ...suite, checks: [{ ...check, aggregate: "sum" }] }, extreme, false)[0]).toMatchObject({ value: null, status: "inconclusive" })
  })
})
