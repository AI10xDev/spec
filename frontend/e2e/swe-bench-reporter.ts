import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

export default class SweBenchReporter implements Reporter {
  private rows: Record<string, unknown>[] = []
  private workers = 0
  private scheduled = 0
  private started = new Set<string>()
  private slots = new Set<number>()
  onBegin(config: FullConfig, suite: Suite) { this.workers = config.workers; this.scheduled = suite.allTests().length }
  onTestBegin(test: TestCase, result: TestResult) { this.started.add(`${test.id}:${result.retry}`); this.slots.add(result.parallelIndex) }
  onTestEnd(test: TestCase, result: TestResult) {
    const body = result.attachments.find(item => item.name === "swe-bench-metrics")?.body
    this.rows.push({
      title: test.title, status: result.status, retry: result.retry,
      started: this.started.has(`${test.id}:${result.retry}`), parallel_index: result.parallelIndex,
      duration_ms: result.duration,
      ...(body ? JSON.parse(body.toString()) : { phase: "fixture-or-setup" }),
    })
  }
  onEnd(result: FullResult) {
    const percentile = (values: number[], p: number) => values.length ? values.sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null
    const timings = Object.fromEntries(["duration_ms", "admission_ms", "first_output_ms", "terminal_ms", "cancel_ms"].map(key => {
      const values = this.rows.filter(row => row.status === "passed").map(row => row[key]).filter((value): value is number => typeof value === "number")
      return [key, { samples: values.length, p50: percentile([...values], 0.5), p95: percentile([...values], 0.95), max: values.length ? Math.max(...values) : null }]
    }))
    const counts: Record<string, number> = {}
    const failures: Record<string, number> = {}
    for (const row of this.rows) {
      counts[String(row.status)] = (counts[String(row.status)] ?? 0) + 1
      if (row.status !== "passed") failures[String(row.phase)] = (failures[String(row.phase)] ?? 0) + 1
    }
    const report = {
      scope: "Spec UI + real local backend + fake runner; NOT SWE-bench issue resolution",
      swe_bench_resolved_rate: null, result: result.status, started_at: result.startTime.toISOString(),
      wall_ms: result.duration, configured_workers: this.workers, actual_worker_slots: this.slots.size,
      scheduled: this.scheduled, attempts: this.started.size, counts, failure_categories: failures,
      timing_policy: "Nearest-rank percentiles of passing attempts only; includes browser polling and fixture delays, not model latency",
      timings, rows: this.rows,
    }
    const directory = path.resolve("test-results/swe-bench")
    mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, "metrics.json"), JSON.stringify(report, null, 2) + "\n")
  }
}
