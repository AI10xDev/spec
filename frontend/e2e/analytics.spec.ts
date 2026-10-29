import { test, expect } from "@playwright/test"
import type { Page } from "@playwright/test"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

let server: ChildProcess
let directory: string
let url: string
const saved = "Review the measured quality of foo.\n"
const suite = { version: 1, kind: "eval", spec: "foo.md", checks: [{ name: "Quality", metric: "quality", aggregate: "mean", operator: ">=", threshold: 0.9 }] }
const output = [
  { event: "eval", metrics: { quality: 0.8, latency_ms: 20 } },
  { event: "eval", metrics: { quality: 1, latency_ms: 10 } },
].map((event) => JSON.stringify(event)).join("\n") + "\n"
const report = { id: "11111111-1111-4111-8111-111111111111", name: "foo.md", status: "completed", output, truncated: false, recoverable: false, continuable: false }

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "spec-analytics-e2e-"))
  server = spawn(path.resolve("../backend/target/debug/spec"), [], {
    cwd: path.resolve("../backend"),
    env: { ...process.env, SPEC_WORKSPACE: directory, SPEC_PORT: "0", SPEC_UI_DIR: path.resolve("dist"), SPEC_SSH_TARGET: undefined, SPEC_SSH_WORKSPACE: undefined, SPEC_SSH_KEY: undefined, SPEC_SSH_BINARY: undefined, SPEC_AI_ENV_FILE: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Rust server did not start")), 10_000)
    let stdout = ""
    let stderr = ""
    server.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000) })
    server.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
      const match = stdout.match(/Spec: (http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+)/)
      if (!match) return
      clearTimeout(timeout)
      resolve(match[1])
    })
    server.once("error", (error) => { clearTimeout(timeout); reject(error) })
    server.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${stderr}`)) })
  })
})

test.afterAll(async () => {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => server.kill("SIGKILL"), 10_000)
      server.once("exit", () => { clearTimeout(timeout); resolve() })
      server.kill("SIGTERM")
    })
  }
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function workspace(page: Page, options: { evaluation?: string | null; report?: boolean } = {}) {
  await writeFile(path.join(directory, "foo.md"), saved)
  await writeFile(path.join(directory, "never.md"), "This spec has no report.\n")
  if (options.report === false) await rm(path.join(directory, "foo.md.out"), { force: true })
  else await writeFile(path.join(directory, "foo.md.out"), output)
  if (options.evaluation === null) await rm(path.join(directory, "foo.md.eval"), { force: true })
  else await writeFile(path.join(directory, "foo.md.eval"), options.evaluation ?? JSON.stringify(suite))

  const requests: { path: string; method: string; body: unknown }[] = []
  const errors: string[] = []
  const dialogs: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("/api/") && request.method() !== "GET") {
      requests.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postDataJSON() })
    }
  })
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss() })
  // Keep reads real, including /analytics POST, but never allow a regression to run or save.
  await page.route("**/api/**", (route) => {
    const request = route.request()
    if (request.method() === "GET" || (request.method() === "POST" && new URL(request.url()).pathname === "/api/analytics")) return route.continue()
    return route.fulfill({ status: 500, json: { error: "Unexpected mutation from analytics" } })
  })
  await page.goto(url)
  await page.getByRole("tabpanel").getByRole("button", { name: /foo\.md(?:\s|$)/ }).click()
  const editor = page.getByRole("textbox", { name: "Edit foo.md", exact: true })
  await expect(editor).toHaveValue(saved)
  const unsaved = "Unsaved editor changes must not be saved or evaluated.\n"
  await editor.fill(unsaved)
  return {
    requests,
    async unchanged() {
      await expect(editor).toHaveValue(unsaved)
      await expect(page.locator(".editor-pane .badge")).toHaveText("Unsaved")
      expect(await readFile(path.join(directory, "foo.md"), "utf8")).toBe(saved)
      expect(requests.filter((request) => request.path !== "/api/analytics" || request.method !== "POST")).toEqual([])
      expect(errors).toEqual([])
      expect(dialogs).toEqual([])
    },
  }
}

async function chooser(page: Page) {
  await page.getByRole("button", { name: "Analytics", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Which spec would you like to analyse?", exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel("Spec to analyse", { exact: true })).toHaveValue("foo.md")
  await expect(dialog.getByRole("button", { name: "Open analytics", exact: true })).toBeEnabled()
  return dialog
}

async function charts(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Analytics: foo.md", exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("img", { name: "quality: minimum 0.8, maximum 1, latest 1", exact: true })).toBeVisible()
  await expect(dialog.getByRole("img", { name: "latency_ms: minimum 10, maximum 20, latest 10", exact: true })).toBeVisible()
  await expect(dialog.getByRole("img", { name: "2 nonempty lines; 0 error-word lines; 0 warning-word lines", exact: true })).toBeVisible()
  return dialog
}

test("Analytics is immediately left of Performance and its modal closes with Escape and returns focus", async ({ page }) => {
  const state = await workspace(page)
  const button = page.getByRole("button", { name: "Analytics", exact: true })
  const performance = page.getByRole("button", { name: "Performance", exact: true })
  await expect(button).toHaveAttribute("title", "analytics")
  await expect(performance).toHaveAttribute("title", "performance")
  expect(await button.evaluate((element) => element.nextElementSibling?.textContent)).toBe("Performance")
  const left = (await button.boundingBox())!
  const right = (await performance.boundingBox())!
  expect(left.x + left.width).toBeLessThanOrEqual(right.x)
  expect(left.y).toBe(right.y)
  const dialog = await chooser(page)
  expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(true)
  const options = dialog.getByLabel("Spec to analyse", { exact: true }).locator("option")
  await expect(options).toHaveCount(3)
  expect((await options.allTextContents()).sort()).toEqual(["Choose a saved spec", "foo.md", "never.md"])
  await expect(dialog.getByLabel("Evaluation spec (.eval, optional)")).toHaveValue("foo.md.eval")
  await expect(dialog).toContainText("Unsaved editor changes are not included")
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(button).toBeFocused()
  await (await chooser(page)).getByRole("button", { name: "Close analytics", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(button).toBeFocused()
  expect(state.requests).toEqual([])
  await state.unchanged()
})

test("a missing local report warns without executing the spec", async ({ page }) => {
  const state = await workspace(page, { report: false })
  const dialog = await chooser(page)
  await dialog.getByRole("button", { name: "Open analytics", exact: true }).click()
  await expect(dialog.getByRole("alert").filter({ hasText: "No prior output found" })).toBeVisible()
  await expect(dialog.getByRole("alert").filter({ hasText: "No report available" })).toContainText("If this spec has never been run, run it first")
  await expect(dialog.getByRole("button", { name: "Open analytics", exact: true })).toBeEnabled()
  await expect(dialog.getByRole("img")).toHaveCount(0)
  expect(state.requests).toEqual([{ path: "/api/analytics", method: "POST", body: { name: "foo.md" } }])
  await state.unchanged()
})

test("saved local report and eval produce a mean check and responsive charts without saving the editor", async ({ page }) => {
  const state = await workspace(page)
  await (await chooser(page)).getByRole("button", { name: "Open analytics", exact: true }).click()
  const dialog = await charts(page)
  await expect(dialog.getByRole("heading", { name: "Analytics: foo.md", exact: true })).toBeFocused()
  await expect(dialog.getByRole("status")).toContainText("Local workspace .out snapshot")
  await expect(dialog.getByRole("status")).toContainText("not associated with a verified remote session or terminal status")
  await expect(dialog).toContainText("Run: local / snapshot")
  const check = dialog.getByRole("row", { name: /Quality/ })
  await expect(check.getByRole("rowheader")).toHaveText("Qualitymean(quality)")
  await expect(check.getByRole("cell")).toHaveText(["0.9", ">= 0.9", "pass"])
  await expect(dialog.locator(".metric-chart").first()).toContainText("2 samples")
  await dialog.getByText("Evidence and evaluator", { exact: true }).click()
  await expect(dialog.locator("details code").first()).toHaveText(/^[a-f0-9]{64}$/)
  await expect(dialog.locator("details")).toContainText("Saved .eval revision:")
  await expect(dialog.locator("details")).toContainText("Local snapshots have no verified terminal status")
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 })
    for (const chart of await dialog.getByRole("img").all()) {
      await chart.scrollIntoViewIfNeeded()
      await expect(chart).toBeInViewport()
      const bounds = (await chart.boundingBox())!
      expect(bounds.width).toBeGreaterThan(0)
      expect(bounds.height).toBeGreaterThan(0)
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
    }
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  await page.keyboard.press("Escape")
  await expect(page.getByRole("button", { name: "Analytics", exact: true })).toBeFocused()
  for (const name of ["Analytics", "Performance"]) {
    const button = page.getByRole("button", { name, exact: true })
    await button.scrollIntoViewIfNeeded()
    await expect(button).toBeInViewport()
    const bounds = (await button.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320)
  }
  expect(state.requests).toEqual([{ path: "/api/analytics", method: "POST", body: { name: "foo.md" } }])
  await state.unchanged()
})

for (const scenario of [
  { name: "invalid JSON", evaluation: "Run this command instead of evaluating.", warning: "Not an evaluation spec" },
  { name: "non-eval JSON", evaluation: JSON.stringify({ ...suite, kind: "optim" }), warning: "Not a supported evaluation spec" },
  { name: "wrong-spec eval", evaluation: JSON.stringify({ ...suite, spec: "other.md" }), warning: "Evaluation spec does not pertain to foo.md" },
  { name: "array-valued operator", evaluation: JSON.stringify({ ...suite, checks: [{ ...suite.checks[0], operator: [">="] }] }), warning: "Invalid evaluation check" },
  { name: "absent optional eval", evaluation: null, warning: "No .eval selected" },
]) {
  test(`${scenario.name} falls back to report charts with a warning`, async ({ page }) => {
    const state = await workspace(page, { evaluation: scenario.evaluation })
    const chooserDialog = await chooser(page)
    await expect(chooserDialog.getByLabel("Evaluation spec (.eval, optional)")).toHaveValue(scenario.evaluation === null ? "" : "foo.md.eval")
    await chooserDialog.getByRole("button", { name: "Open analytics", exact: true }).click()
    const dialog = await charts(page)
    await expect(dialog.getByRole("status")).toContainText(scenario.warning)
    await expect(dialog.getByRole("status")).toContainText("Showing report analytics without an evaluation sweep")
    await expect(dialog.getByRole("region", { name: "Evaluation results" })).toContainText("No evaluation checks applied")
    await expect(dialog.getByRole("table")).toHaveCount(0)
    await state.unchanged()
  })
}

test("remote retained selection shows loading, preserves selection on error, and retries the chosen report", async ({ page }) => {
  const state = await workspace(page)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let attempts = 0
  await page.route("**/api/analytics", async (route) => {
    const body = route.request().postDataJSON()
    if (!body.runId) return route.fulfill({ json: { report: null, runs: [{ id: report.id, modified: 1_700_000_000 }], warnings: ["No associated run; select a retained run to evaluate its report."] } })
    if (++attempts === 1) {
      await held
      return route.fulfill({ status: 502, json: { error: "Remote report temporarily unavailable" } })
    }
    return route.fulfill({ json: { report, runs: [], warnings: [] } })
  })
  const dialog = await chooser(page)
  await dialog.getByRole("button", { name: "Open analytics", exact: true }).click()
  const select = dialog.getByLabel("Retained run", { exact: true })
  await expect(select).toBeVisible()
  await expect(dialog.getByRole("alert")).toContainText("select a retained run")
  await select.selectOption(report.id)
  await dialog.getByRole("button", { name: "Open analytics", exact: true }).click()
  try {
    await expect(dialog.getByRole("button", { name: "Loading analytics...", exact: true })).toBeDisabled()
    await expect(select).toBeDisabled()
    await expect(dialog.getByLabel("Spec to analyse", { exact: true })).toBeDisabled()
  } finally { release() }
  await expect(dialog.getByRole("alert").filter({ hasText: "Remote report temporarily unavailable" })).toBeVisible()
  await expect(select).toHaveValue(report.id)
  await expect(dialog.getByLabel("Evaluation spec (.eval, optional)")).toHaveValue("foo.md.eval")
  await dialog.getByRole("button", { name: "Open analytics", exact: true }).click()
  const dashboard = await charts(page)
  await expect(dashboard).toContainText(`Run: ${report.id} / completed`)
  await expect(dashboard.getByRole("row", { name: /Quality/ }).getByRole("cell")).toHaveText(["0.9", ">= 0.9", "pass"])
  expect(state.requests.map((request) => request.body)).toEqual([{ name: "foo.md" }, { name: "foo.md", runId: report.id }, { name: "foo.md", runId: report.id }])
  await state.unchanged()
})

test("an eval read failure remains retryable rather than being classified as a non-eval file", async ({ page }) => {
  const state = await workspace(page)
  let reads = 0
  await page.route("**/api/files/foo.md.eval", (route) => ++reads === 1
    ? route.fulfill({ status: 503, json: { error: "Evaluation file temporarily unavailable" } })
    : route.continue())
  const dialog = await chooser(page)
  await dialog.getByRole("button", { name: "Open analytics", exact: true }).click()
  await expect(dialog.getByRole("alert").filter({ hasText: "Evaluation file temporarily unavailable" })).toBeVisible()
  await expect(dialog.getByLabel("Evaluation spec (.eval, optional)")).toHaveValue("foo.md.eval")
  await expect(dialog.getByRole("img")).toHaveCount(0)
  await dialog.getByRole("button", { name: "Open analytics", exact: true }).click()
  await charts(page)
  expect(reads).toBe(2)
  await state.unchanged()
})

for (const missing of [false, true]) {
  test(`explicit retained browsing works with ${missing ? "a missing" : "an available"} associated report without replacing it`, async ({ page }) => {
    const state = await workspace(page)
    const alternative = "22222222-2222-4222-8222-222222222222"
    await page.route("**/api/analytics", (route) => {
      const body = route.request().postDataJSON()
      if (body.browse) return route.fulfill({ json: { report: null, runs: [{ id: alternative, modified: 1_700_000_000 }], warnings: ["Select a retained run; this does not change the associated run."] } })
      if (body.runId === alternative) return route.fulfill({ json: { report: { ...report, id: alternative }, runs: [], warnings: [] } })
      if (missing) return route.fulfill({ status: 502, json: { error: "Associated report missing; retained lookup failed" } })
      return route.fulfill({ json: { report, runs: [], warnings: [] } })
    })
    let dialog = await chooser(page)
    await dialog.getByRole("button", { name: "Open analytics", exact: true }).click()
    if (missing) {
      await expect(dialog.getByRole("alert")).toContainText("Associated report missing")
    } else {
      const dashboard = await charts(page)
      await expect(dashboard).toContainText(`Run: ${report.id} / completed`)
      await dashboard.getByRole("button", { name: "Choose another spec or run" }).click()
      dialog = page.getByRole("dialog", { name: "Which spec would you like to analyse?", exact: true })
    }
    await dialog.getByRole("button", { name: "Browse retained runs", exact: true }).click()
    const select = dialog.getByLabel("Retained run", { exact: true })
    await expect(select).toHaveValue("")
    await expect(select.locator("option")).toHaveCount(2)
    await expect(dialog.getByRole("img")).toHaveCount(0)
    if (missing) await expect(dialog.getByRole("alert").filter({ hasText: "Associated report missing" })).toBeVisible()
    await select.selectOption(alternative)
    await dialog.getByRole("button", { name: "Open analytics", exact: true }).click()
    const dashboard = await charts(page)
    await expect(dashboard).toContainText(`Run: ${alternative} / completed`)
    await dashboard.getByRole("button", { name: "Choose another spec or run" }).click()
    await dialog.getByRole("button", { name: "Open analytics", exact: true }).click()
    if (missing) await expect(dialog.getByRole("alert")).toContainText("Associated report missing")
    else await expect(await charts(page)).toContainText(`Run: ${report.id} / completed`)
    expect(state.requests.map((request) => request.body)).toEqual([
      { name: "foo.md" }, { name: "foo.md", browse: true },
      { name: "foo.md", runId: alternative }, { name: "foo.md" },
    ])
    await state.unchanged()
  })
}

test("retained browsing failures stay visible and retry does not select a report", async ({ page }) => {
  const state = await workspace(page)
  let attempts = 0
  await page.route("**/api/analytics", (route) => ++attempts === 1
    ? route.fulfill({ status: 502, json: { error: "Retained storage is unavailable" } })
    : route.fulfill({ json: { report: null, runs: [], warnings: ["Some retained reports were omitted: ambiguous legacy provenance. Inspect the original retained log manually."] } }))
  const dialog = await chooser(page)
  const browse = dialog.getByRole("button", { name: "Browse retained runs", exact: true })
  await browse.click()
  await expect(dialog.getByRole("alert")).toContainText("Retained storage is unavailable")
  await browse.click()
  await expect(dialog.getByRole("alert").filter({ hasText: "ambiguous legacy provenance" })).toBeVisible()
  await expect(dialog.getByRole("alert").filter({ hasText: "Retained storage is unavailable" })).toHaveCount(0)
  await expect(dialog.getByRole("img")).toHaveCount(0)
  await expect(dialog.getByLabel("Spec to analyse", { exact: true })).toHaveValue("foo.md")
  expect(state.requests.map((request) => request.body)).toEqual([{ name: "foo.md", browse: true }, { name: "foo.md", browse: true }])
  await state.unchanged()
})

for (const variant of [
  { name: "truncated", truncated: true, status: "completed" },
  { name: "active", truncated: false, status: "running" },
  { name: "failed", truncated: false, status: "failed (exit status: 1)" },
  { name: "unknown", truncated: false, status: "unknown (remote status unavailable)" },
]) {
  test(`${variant.name} report keeps charts but marks checks inconclusive`, async ({ page }) => {
    const state = await workspace(page)
    await page.route("**/api/analytics", (route) => route.fulfill({ json: { report: { ...report, truncated: variant.truncated, status: variant.status }, runs: [], warnings: [] } }))
    await (await chooser(page)).getByRole("button", { name: "Open analytics", exact: true }).click()
    const dialog = await charts(page)
    await expect(dialog.getByRole("status")).toContainText("Report is incomplete or not a completed run; checks are inconclusive")
    await expect(dialog.getByRole("row", { name: /Quality/ }).getByRole("cell")).toHaveText(["0.9", ">= 0.9", "inconclusive"])
    await state.unchanged()
  })
}
