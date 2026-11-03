import { test, expect } from "@playwright/test"
import type { Page } from "@playwright/test"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

let server: ChildProcess
let directory: string
let url: string

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "spec-active-runs-e2e-"))
  server = spawn(path.resolve("../backend/target/debug/spec"), [], {
    cwd: path.resolve("../backend"),
    env: { ...process.env, SPEC_WORKSPACE: directory, SPEC_PORT: "0", SPEC_UI_DIR: path.resolve("dist"), SPEC_SSH_TARGET: undefined, SPEC_SSH_WORKSPACE: undefined, SPEC_SSH_KEY: undefined, SPEC_SSH_BINARY: undefined, SPEC_AI_ENV_FILE: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Rust server did not start")), 10_000)
    let output = ""
    server.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(/Spec: (http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+)/)
      if (!match) return
      clearTimeout(timeout)
      resolve(match[1])
    })
    server.once("error", (error) => { clearTimeout(timeout); reject(error) })
    server.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Server exited ${code}`)) })
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

const blockers = [
  { id: "unopened-run", name: "unopened.md", status: "unknown", kind: "build" },
  { id: "deleted-run", name: "deleted.md", status: "unavailable: remote metadata missing", kind: "repository-save" },
  { id: "older-optimizer", name: "optimization", status: "unknown", kind: "optimization" },
]
const detail = { ...blockers[0], output: "Cached build output", truncated: false, recoverable: true, continuable: false }
const fileRun = { ...detail, id: "file-run", name: "optimization", status: "completed", recoverable: false, output: "Independent file output", continuable: true }
const optimizer = { ...fileRun, id: "latest-optimizer", output: "Latest optimization metrics", continuable: false }

async function workspace(page: Page, options: { execution?: boolean; file?: typeof fileRun; optimization?: typeof optimizer | null } = {}) {
  const requests: { path: string; method: string }[] = []
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("request", (request) => {
    if (request.url().includes("/api/")) requests.push({ path: new URL(request.url()).pathname, method: request.method() })
  })
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (route.request().method() !== "GET") return route.fulfill({ status: 500, json: { error: "Unexpected write" } })
    if (pathname === "/api/config") return route.fulfill({ json: { execution: options.execution ?? true, completion: false, chat: false, realtime: false, azureRealtime: false } })
    if (pathname === "/api/files") return route.fulfill({ json: ["unopened.md", "optimization"].map((name) => ({ name, modified: 0, bytes: 10 })) })
    if (pathname === "/api/repository") return route.fulfill({ json: { connected: true, dirty: true, directory: "/fixture", model: "fixture-model" } })
    if (pathname === "/api/optimize") return route.fulfill({ json: options.optimization === undefined ? optimizer : options.optimization })
    if (pathname === "/api/files/optimization") return route.fulfill({ json: { name: "optimization", content: "Saved editor text", revision: "r1" } })
    if (pathname === "/api/files/optimization/run") return route.fulfill({ json: options.file ?? fileRun })
    if (pathname === "/api/runs") return route.fulfill({ json: blockers })
    if (pathname === "/api/runs/file-run") return route.fulfill({ json: options.file ?? fileRun })
    if (pathname === "/api/runs/latest-optimizer") return route.fulfill({ json: options.optimization ?? optimizer })
    const run = blockers.find((run) => pathname === `/api/runs/${run.id}`)
    if (run) return route.fulfill({ json: { ...detail, ...run } })
    return route.fulfill({ status: 404, json: { error: `Unexpected request: ${pathname}` } })
  })
  await page.goto(url)
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeVisible()
  return { requests, errors }
}

const inspector = (page: Page) => page.getByRole("region", { name: "Active runs", exact: true })
const load = (page: Page, id = "unopened-run") => inspector(page).getByRole("button", { name: new RegExp(`Load output.*${id}`) }).click()

for (const width of [1440, 390, 320]) {
  test(`lists unopened and deleted-file blockers without tabs or source reads at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const { requests, errors } = await workspace(page)
    expect(requests.filter((request) => request.path.startsWith("/api/runs"))).toEqual([])
    const button = page.getByRole("button", { name: "Active runs", exact: true })
    await button.click()
    await expect(button).toHaveAttribute("aria-expanded", "true")
    await expect(inspector(page).getByRole("listitem")).toHaveCount(3)
    expect(requests.filter((request) => request.path.startsWith("/api/runs/"))).toEqual([])
    await load(page, "deleted-run")
    await expect(page.getByLabel("Active run output", { exact: true })).toHaveText(detail.output)
    await expect(inspector(page)).toContainText("still blocks the repository")
    for (const run of blockers) {
      const row = inspector(page).getByRole("listitem").filter({ hasText: run.id })
      await expect(row).toContainText(run.name)
      await expect(row).toContainText(run.status)
      await expect(row).toContainText(run.kind)
    }
    await expect(page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button")).toHaveCount(0)
    expect(requests.filter((request) => request.path.startsWith("/api/files/"))).toEqual([])
    expect(requests.filter((request) => request.method !== "GET")).toEqual([])
    for (const control of [button, inspector(page).getByRole("button", { name: "Refresh list" }), inspector(page).getByRole("button", { name: "Stop run" })]) {
      await control.scrollIntoViewIfNeeded()
      const bounds = await control.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await inspector(page).getByRole("button", { name: "Close active runs" }).click()
    await expect(button).toBeFocused()
    await expect(button).toHaveAttribute("aria-expanded", "false")
    expect(errors).toEqual([])
  })
}

for (const width of [1440, 320]) {
  test(`Performance preserves the three-run missing-directory conflict without retrying or cancelling at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.clock.install()
    await page.clock.pauseAt(new Date(Date.now() + 1000))
    const { requests, errors } = await workspace(page)
    const id = "c1b51fb1-23af-4cde-a227-b13db85a448d"
    await page.getByRole("button", { name: "Optimization", exact: true }).click()
    await expect(page.getByLabel("Run output", { exact: true })).toHaveText(optimizer.output)
    const status = `unavailable (remote recovery exit status: 125: remote run directory missing: .spec-runs/run-${id} (run ${id}); it may never have started or may have been removed; verify the configured remote workspace)`
    const missing = { ...detail, id, name: "ref_web", status, kind: "build" }
    const conflict = `This repository has 3 active or unresolved conflicting run(s). Blocking run: "ref_web" (run ${id}, status: ${status}). Open Active runs and load its output to check remote status before retrying. Unavailable status does not prove completion.`
    await page.route("**/api/optimize", (route) => route.fulfill({ status: 409, json: { error: conflict } }))
    await page.route("**/api/runs", (route) => route.fulfill({ json: [missing, ...blockers.slice(1)] }))
    await page.route(`**/api/runs/${id}`, (route) => route.fulfill({ json: missing }))
    const dialogs: string[] = []
    page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.accept() })
    const header = page.getByTitle("performance", { exact: true })
    await header.click()
    const form = page.getByRole("form", { name: "Performance pipelines", exact: true })
    const project = form.getByRole("textbox", { name: "Project folder", exact: true })
    await project.fill("team/project")
    await form.getByRole("button", { name: "Run pipelines", exact: true }).click()
    await expect(form.getByRole("alert")).toHaveText(conflict)
    await expect(project).toHaveValue("team/project")
    await expect(header).toBeEnabled()
    await expect(header).toHaveAttribute("aria-expanded", "true")
    await expect(page.getByLabel("Run output", { exact: true })).toHaveText(optimizer.output)
    await form.getByRole("button", { name: "Inspect active runs", exact: true }).click()
    await expect(inspector(page).getByRole("listitem")).toHaveCount(3)
    await load(page, id)
    await expect(inspector(page).getByLabel("Selected active run")).toContainText("still blocks the repository")
    await expect(inspector(page)).toContainText("Remote output is unavailable")
    await expect(page.getByLabel("Active run output", { exact: true })).toHaveText(missing.output)
    await inspector(page).getByRole("button", { name: "Check status", exact: true }).click()
    await expect.poll(() => requests.filter((request) => request.path === `/api/runs/${id}`).length).toBe(2)
    await expect(inspector(page).getByText("Checking remote status...", { exact: true })).toHaveCount(0)
    await expect(inspector(page).getByRole("listitem")).toHaveCount(3)
    await expect(inspector(page)).not.toContainText("terminal and no longer blocks")
    await expect(inspector(page).getByRole("button", { name: "Stop run", exact: true })).toBeEnabled()
    await inspector(page).getByRole("button", { name: "Close active runs", exact: true }).click()
    await expect(project).toHaveValue("team/project")
    await expect(form.getByRole("alert")).toHaveText(conflict)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(requests.filter((request) => request.method !== "GET")).toEqual([{ path: "/api/optimize", method: "POST" }])
    expect(dialogs).toHaveLength(1)
    expect(errors).toEqual([])
  })
}

test("listing errors, explicit refresh, and an empty list never trigger remote reads", async ({ page }) => {
  const { requests } = await workspace(page)
  await page.route("**/api/runs", (route) => route.fulfill({ status: 503, json: { error: "Listing unavailable" } }))
  await page.getByRole("button", { name: "Active runs", exact: true }).click()
  await expect(inspector(page).getByRole("alert")).toContainText("Listing unavailable")
  await expect(inspector(page)).not.toContainText("No active runs.")
  await page.route("**/api/runs", (route) => route.fulfill({ json: [] }))
  await inspector(page).getByRole("button", { name: "Refresh list" }).click()
  await expect(inspector(page)).toContainText("No active runs.")
  await expect(inspector(page).getByRole("alert")).toHaveCount(0)
  expect(requests.filter((request) => request.path.startsWith("/api/runs/"))).toEqual([])
})

test("failed and missing remote status keep cached output and confirmed stopping available", async ({ page }) => {
  const { requests } = await workspace(page)
  await page.getByRole("button", { name: "Active runs", exact: true }).click()
  await load(page)
  await expect(page.getByLabel("Active run output", { exact: true })).toHaveText(detail.output)
  await page.route("**/api/runs/unopened-run", (route) => route.fulfill({ status: 502, json: { error: "SSH unavailable" } }))
  await inspector(page).getByRole("button", { name: "Check status" }).click()
  await expect(inspector(page).getByRole("alert")).toContainText("SSH unavailable")
  await expect(page.getByLabel("Active run output", { exact: true })).toHaveText(detail.output)
  const stop = inspector(page).getByRole("button", { name: "Stop run", exact: true })
  page.once("dialog", (dialog) => dialog.dismiss())
  await stop.click()
  expect(requests.filter((request) => request.method !== "GET")).toEqual([])
  await page.route("**/api/runs/unopened-run", (route) => route.fulfill({ json: { ...detail, status: "unavailable: remote metadata missing", output: "older server cache" } }))
  await inspector(page).getByRole("button", { name: "Check status" }).click()
  await expect(inspector(page)).toContainText("Remote output is unavailable")
  await expect(page.getByLabel("Active run output", { exact: true })).toHaveText(detail.output)
  await expect(stop).toBeEnabled()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/runs/unopened-run/cancel", async (route) => { await held; await route.fulfill({ json: { ok: true } }) })
  const dialogs: string[] = []
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.accept() })
  await stop.evaluate((button: HTMLButtonElement) => { button.click(); button.click() })
  await expect(inspector(page).getByRole("button", { name: "Stopping run..." })).toBeDisabled()
  await expect.poll(() => requests.filter((request) => request.method === "POST").length).toBe(1)
  expect(dialogs).toHaveLength(1)
  expect(dialogs[0]).toContain("unopened.md (unopened-run)")
  await page.route("**/api/runs/unopened-run", (route) => route.fulfill({ json: { ...detail, status: "stopped", recoverable: false } }))
  await page.route("**/api/runs", (route) => route.fulfill({ json: blockers.slice(1) }))
  release()
  await expect(inspector(page)).toContainText("terminal and no longer blocks")
  await expect(inspector(page).getByRole("listitem")).toHaveCount(2)
  await expect(stop).toHaveCount(0)
  await load(page, "deleted-run")
  await expect(inspector(page).getByLabel("Selected active run")).toContainText("still blocks the repository")
})

test("polls only the selected recoverable run and refreshes the list when terminal", async ({ page }) => {
  const { requests } = await workspace(page)
  let reads = 0
  await page.route("**/api/runs/unopened-run", (route) => route.fulfill({ json: ++reads === 1 ? { ...detail, status: "running" } : { ...detail, status: "completed", recoverable: false, output: "Harness finished" } }))
  await page.getByRole("button", { name: "Active runs", exact: true }).click()
  await load(page)
  await expect(page.getByLabel("Active run output", { exact: true })).toHaveText("Harness finished")
  await expect.poll(() => requests.filter((request) => request.path === "/api/runs").length).toBe(2)
  expect(reads).toBe(2)
  expect(requests.filter((request) => request.path === "/api/runs/deleted-run")).toEqual([])
})

test("an inspector-only terminal cache cannot regress or resume polling on an older response", async ({ page }) => {
  await workspace(page)
  let reads = 0
  await page.route("**/api/runs/unopened-run", (route) => route.fulfill({ json: ++reads === 1
    ? { ...detail, status: "completed", recoverable: false, output: "Terminal cached output" }
    : detail }))
  await page.getByRole("button", { name: "Active runs", exact: true }).click()
  await load(page)
  await expect(page.getByLabel("Active run output", { exact: true })).toHaveText("Terminal cached output")
  await inspector(page).getByRole("button", { name: "Check status" }).click()
  await expect.poll(() => reads).toBe(2)
  await expect(inspector(page).getByText("Checking remote status...", { exact: true })).toHaveCount(0)
  await page.waitForTimeout(2800)
  expect(reads).toBe(2)
  await expect(page.getByLabel("Active run output", { exact: true })).toHaveText("Terminal cached output")
  await expect(inspector(page)).toContainText("terminal and no longer blocks")
  await expect(inspector(page).getByRole("button", { name: "Stop run", exact: true })).toHaveCount(0)
})

test("a failed first detail read still allows explicit stop, and stop failure does not resolve the run", async ({ page }) => {
  const { requests } = await workspace(page)
  await page.route("**/api/runs/deleted-run", (route) => route.fulfill({ status: 404, json: { error: "Remote run unavailable" } }))
  await page.route("**/api/runs/deleted-run/cancel", (route) => route.fulfill({ status: 502, json: { error: "Cancellation unavailable" } }))
  await page.getByRole("button", { name: "Active runs", exact: true }).click()
  await load(page, "deleted-run")
  await expect(inspector(page).getByRole("alert")).toContainText("Remote run unavailable")
  await expect(page.getByLabel("Active run output", { exact: true })).toHaveText("No output loaded yet.")
  page.once("dialog", (dialog) => dialog.accept())
  await inspector(page).getByRole("button", { name: "Stop run", exact: true }).click()
  await expect(inspector(page).getByRole("alert").filter({ hasText: "Cancellation unavailable" })).toBeVisible()
  await expect(inspector(page).getByRole("button", { name: "Stop run", exact: true })).toBeEnabled()
  await expect(inspector(page)).toContainText("still blocks the repository")
  expect(requests.filter((request) => request.method !== "GET")).toEqual([{ path: "/api/runs/deleted-run/cancel", method: "POST" }])
})

test("reopening retains cached output through list and remote failures without automatic cancellation", async ({ page }) => {
  const { requests } = await workspace(page)
  const button = page.getByRole("button", { name: "Active runs", exact: true })
  await button.click()
  await load(page)
  await expect(page.getByLabel("Active run output", { exact: true })).toHaveText(detail.output)
  await button.click()
  await page.route("**/api/runs", (route) => route.fulfill({ status: 503, json: { error: "List failed" } }))
  await page.route("**/api/runs/unopened-run", (route) => route.fulfill({ status: 503, json: { error: "Details failed" } }))
  await button.click()
  await expect(inspector(page).getByRole("alert").filter({ hasText: "List failed" })).toContainText("Showing the last available list")
  await expect(inspector(page).getByRole("alert").filter({ hasText: "Details failed" })).toBeVisible()
  await expect(inspector(page).getByRole("listitem")).toHaveCount(3)
  await expect(page.getByLabel("Active run output", { exact: true })).toHaveText(detail.output)
  await expect(inspector(page).getByRole("button", { name: "Stop run", exact: true })).toBeEnabled()
  expect(requests.filter((request) => request.method !== "GET")).toEqual([])
})

test("refresh preserves selection and ignores reordered list and detail responses", async ({ page }) => {
  await workspace(page)
  await page.getByRole("button", { name: "Active runs", exact: true }).click()
  await load(page)
  await expect(page.getByLabel("Active run output", { exact: true })).toHaveText(detail.output)
  let releaseList!: () => void
  const heldList = new Promise<void>((resolve) => { releaseList = resolve })
  let lists = 0
  await page.route("**/api/runs", async (route) => {
    if (++lists === 1) { await heldList; await route.fulfill({ json: [] }) }
    else await route.fulfill({ json: [...blockers].reverse() })
  })
  const refresh = inspector(page).getByRole("button", { name: "Refresh list" })
  await refresh.click()
  await expect.poll(() => lists).toBe(1)
  await refresh.click()
  await expect(inspector(page).getByRole("listitem").first()).toContainText("older-optimizer")
  releaseList()
  await expect(inspector(page).getByRole("button", { name: /Load output.*unopened-run/ })).toHaveAttribute("aria-pressed", "true")
  let releaseDetail!: () => void
  const heldDetail = new Promise<void>((resolve) => { releaseDetail = resolve })
  let started = false
  await page.route("**/api/runs/unopened-run", async (route) => { started = true; await heldDetail; await route.fulfill({ json: { ...detail, output: "Obsolete output" } }) })
  await inspector(page).getByRole("button", { name: "Check status" }).click()
  await expect.poll(() => started).toBe(true)
  await load(page, "deleted-run")
  await expect(inspector(page).getByLabel("Selected active run")).toContainText("deleted-run")
  releaseDetail()
  await expect(page.getByLabel("Active run output", { exact: true })).toHaveText(detail.output)
  await expect(inspector(page).getByRole("listitem")).toHaveCount(3)
})

test("inspection preserves editor, feedback, Performance inputs, and unrelated optimization associations", async ({ page }) => {
  const { requests, errors } = await workspace(page)
  // Keep this inspection test independent of the focused-sheet autosave timer.
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  await page.getByRole("tabpanel").getByRole("button", { name: /optimization/ }).click()
  const editor = page.getByRole("textbox", { name: "Edit optimization", exact: true })
  await editor.fill("Unsaved editor text")
  await page.getByLabel("Feedback to build session").fill("Keep this feedback")
  await page.getByLabel("Follow output", { exact: true }).uncheck()
  await page.getByRole("button", { name: "Performance", exact: true }).click()
  await page.getByRole("textbox", { name: "Project folder", exact: true }).fill("team/project")
  await page.getByLabel("Use current editor as spec", { exact: true }).check()
  await page.getByRole("button", { name: "Active runs", exact: true }).click()
  await load(page, "older-optimizer")
  await expect(page.getByLabel("Active run output", { exact: true })).toHaveText(detail.output)
  await inspector(page).getByRole("button", { name: "Close active runs" }).click()
  await expect(editor).toHaveValue("Unsaved editor text")
  await expect(page.getByLabel("Run output", { exact: true })).toHaveText(fileRun.output)
  await expect(page.getByLabel("Feedback to build session")).toHaveValue("Keep this feedback")
  await expect(page.getByLabel("Follow output", { exact: true })).not.toBeChecked()
  await expect(page.getByRole("textbox", { name: "Project folder", exact: true })).toHaveValue("team/project")
  await expect(page.getByLabel("Use current editor as spec", { exact: true })).toBeChecked()
  await page.getByRole("button", { name: "Optimization", exact: true }).click()
  await expect(page.getByLabel("Run output", { exact: true })).toHaveText(optimizer.output)
  expect(requests.filter((request) => request.method !== "GET")).toEqual([])
  expect(errors).toEqual([])
})

for (const kind of ["file", "optimization"] as const) {
  test(`Performance opens for an unresolved exit 255 ${kind} run and launches only after verified completion`, async ({ page }) => {
    const width = kind === "file" ? 320 : 1440
    await page.setViewportSize({ width, height: 900 })
    await page.clock.install()
    await page.clock.pauseAt(new Date(Date.now() + 1000))
    const known = { ...(kind === "file" ? fileRun : optimizer), status: "failed (exit 255)", recoverable: true }
    const { requests, errors } = await workspace(page, { [kind]: known })
    const dialogs: string[] = []
    page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.accept() })
    await page.route("**/api/runs", (route) => route.fulfill({ json: [{ ...known, kind: kind === "file" ? "build" : "optimization" }] }))
    if (kind === "file") await page.getByRole("tabpanel").getByRole("button", { name: /optimization/ }).click()
    await expect(page.getByLabel("Run output", { exact: true })).toHaveText(known.output)
    const header = page.getByRole("button", { name: "Performance", exact: true })
    await expect(header).toBeEnabled()
    await header.click()
    const form = page.getByRole("form", { name: "Performance pipelines", exact: true })
    await expect(form).toBeVisible()
    await form.getByRole("textbox", { name: "Project folder", exact: true }).fill("team/project")
    const availability = form.locator("#performance-availability")
    await expect(availability).toContainText("Pipeline launch is blocked by active or unresolved runs")
    const blocking = form.getByRole("list", { name: "Blocking runs", exact: true })
    await expect(blocking.getByRole("listitem")).toHaveCount(1)
    for (const value of [known.name, known.id, known.status]) await expect(blocking).toContainText(value)
    const submit = form.getByRole("button", { name: "Run pipelines", exact: true })
    await expect(submit).toBeDisabled()
    await form.getByRole("textbox", { name: "Project folder", exact: true }).press("Enter")
    await form.evaluate((element: HTMLFormElement) => element.requestSubmit())
    const inspect = form.getByRole("button", { name: "Inspect active runs", exact: true })
    await expect(inspect).toHaveAttribute("type", "button")
    for (const control of [availability, blocking, submit, inspect]) {
      await control.scrollIntoViewIfNeeded()
      const bounds = await control.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(requests.filter((request) => request.method !== "GET")).toEqual([])
    expect(dialogs).toEqual([])
    await inspect.click()
    await expect(inspector(page)).toBeVisible()
    await expect(page.getByRole("button", { name: "Active runs", exact: true })).toHaveAttribute("aria-expanded", "true")
    await load(page, known.id)
    await expect(page.getByLabel("Active run output", { exact: true })).toHaveText(known.output)
    await expect(inspector(page)).toContainText("still blocks the repository")
    await expect(submit).toBeDisabled()
    await page.route(`**/api/runs/${known.id}`, (route) => route.fulfill({ status: 502, json: { error: "SSH unavailable" } }))
    await inspector(page).getByRole("button", { name: "Check status", exact: true }).click()
    await expect(inspector(page).getByRole("alert")).toContainText("SSH unavailable")
    await expect(submit).toBeDisabled()
    // An empty listing is not verified completion of the cached known run.
    await page.route("**/api/runs", (route) => route.fulfill({ json: [] }))
    await inspector(page).getByRole("button", { name: "Refresh list", exact: true }).click()
    await expect(inspector(page)).toContainText("No active runs.")
    await expect(blocking).toContainText(known.id)
    await expect(submit).toBeDisabled()
    const terminal = { ...known, status: "completed", recoverable: false, output: "Verified completion" }
    await page.route(`**/api/runs/${known.id}`, (route) => route.fulfill({ json: terminal }))
    await inspector(page).getByRole("button", { name: "Check status", exact: true }).click()
    await expect(page.getByLabel("Active run output", { exact: true })).toHaveText(terminal.output)
    await expect(inspector(page)).toContainText("terminal and no longer blocks")
    await expect(submit).toBeEnabled()
    await expect(blocking.getByRole("listitem")).toHaveCount(0)
    await expect(availability.filter({ hasText: "Pipeline launch is blocked by active or unresolved runs" })).toHaveCount(0)
    await inspector(page).getByRole("button", { name: "Close active runs", exact: true }).click()
    await expect(form.getByRole("textbox", { name: "Project folder", exact: true })).toHaveValue("team/project")
    expect(requests.filter((request) => request.method !== "GET")).toEqual([])
    expect(dialogs).toEqual([])
    await page.route("**/api/optimize", (route) => route.fulfill({ json: { id: optimizer.id } }))
    await submit.click()
    await expect.poll(() => requests.filter((request) => request.method !== "GET")).toEqual([{ path: "/api/optimize", method: "POST" }])
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]).toContain("Run dataset_pipe and model_pipeline for project team/project?")
    expect(errors).toEqual([])
  })

  test(`terminal workspace polling survives a delayed recoverable ${kind} inspector response`, async ({ page }) => {
    const known = { ...(kind === "file" ? fileRun : optimizer), status: "unknown", recoverable: true }
    const terminal = { ...known, status: "completed", recoverable: false, output: "Terminal workspace output" }
    const { errors } = await workspace(page, { [kind]: known })
    let releaseNormal!: () => void
    let releaseInspector!: () => void
    const normal = new Promise<void>((resolve) => { releaseNormal = resolve })
    const inspecting = new Promise<void>((resolve) => { releaseInspector = resolve })
    let reads = 0
    await page.route(`**/api/runs/${known.id}`, async (route) => {
      if (++reads === 1) { await normal; await route.fulfill({ json: terminal }) }
      else { await inspecting; await route.fulfill({ json: known }) }
    })
    await page.getByRole("tabpanel").getByRole("button", { name: /optimization/ }).click()
    await expect.poll(() => reads).toBe(1)
    await page.getByRole("button", { name: kind === "file" ? /Current file:/ : "Optimization", exact: true }).click()
    await page.route("**/api/runs", (route) => route.fulfill({ json: [{ ...known, kind: kind === "file" ? "build" : "optimization" }] }))
    await page.getByRole("button", { name: "Active runs", exact: true }).click()
    await load(page, known.id)
    await expect.poll(() => reads).toBe(2)
    await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
    await page.getByRole("button", { name: "Performance", exact: true }).click()
    await expect(page.getByRole("button", { name: "Run pipelines", exact: true })).toBeDisabled()
    releaseNormal()
    await expect(page.getByLabel("Run output", { exact: true })).toHaveText(terminal.output)
    await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
    await expect(page.getByRole("button", { name: "Run pipelines", exact: true })).toBeEnabled()
    // The inspector must reflect normal polling even while its own request is held.
    await expect(page.getByLabel("Active run output", { exact: true })).toHaveText(terminal.output)
    await expect(inspector(page)).toContainText("terminal and no longer blocks")
    const response = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/runs/${known.id}`)
    releaseInspector()
    await response
    await expect(inspector(page).getByText("Checking remote status...", { exact: true })).toHaveCount(0)
    await page.waitForTimeout(2800)
    expect(reads).toBe(2)
    await expect(page.getByLabel("Run output", { exact: true })).toHaveText(terminal.output)
    await expect(page.getByLabel("Active run output", { exact: true })).toHaveText(terminal.output)
    await expect(inspector(page)).toContainText("terminal and no longer blocks")
    await expect(inspector(page).getByRole("button", { name: "Stop run", exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
    await expect(page.getByRole("button", { name: "Run pipelines", exact: true })).toBeEnabled()
    await expect(page.getByRole("button", { name: "Save repo changes", exact: true })).toBeEnabled()
    expect(errors).toEqual([])
  })

  test(`terminal inspection clears only the matching known ${kind} pending flag`, async ({ page }) => {
    const known = { ...(kind === "file" ? fileRun : optimizer), status: "unknown", recoverable: true }
    await workspace(page, { [kind]: known })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let started = false
    await page.route(`**/api/runs/${known.id}`, async (route) => { started = true; await held; await route.fulfill({ json: known }) })
    await page.getByRole("tabpanel").getByRole("button", { name: /optimization/ }).click()
    await expect.poll(() => started).toBe(true)
    const editor = page.getByRole("textbox", { name: "Edit optimization", exact: true })
    await editor.fill("Still unsaved")
    await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
    await page.getByRole("button", { name: "Performance", exact: true }).click()
    await expect(page.getByRole("button", { name: "Run pipelines", exact: true })).toBeDisabled()
    await page.route("**/api/runs", (route) => route.fulfill({ json: [{ ...known, kind: kind === "file" ? "build" : "optimization" }] }))
    await page.route(`**/api/runs/${known.id}`, (route) => route.fulfill({ json: { ...known, status: "completed", recoverable: false, output: "Terminal inspected output" } }))
    await page.getByRole("button", { name: "Active runs", exact: true }).click()
    await load(page, known.id)
    await expect(inspector(page)).toContainText("terminal and no longer blocks")
    await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
    await expect(page.getByRole("button", { name: "Run pipelines", exact: true })).toBeEnabled()
    await expect(page.getByRole("button", { name: "Save repo changes", exact: true })).toBeEnabled()
    release()
    await inspector(page).getByRole("button", { name: "Close active runs" }).click()
    await page.getByRole("button", { name: kind === "file" ? /Current file:/ : "Optimization", exact: true }).click()
    await expect(page.getByLabel("Run output", { exact: true })).toHaveText("Terminal inspected output")
    await page.getByRole("button", { name: kind === "file" ? "Optimization" : /Current file:/, exact: true }).click()
    await expect(page.getByLabel("Run output", { exact: true })).toHaveText(kind === "file" ? optimizer.output : fileRun.output)
    await expect(editor).toHaveValue("Still unsaved")
  })
}

test("closing aborts list and selected requests, preserves the normal output, and stops polling", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch
    const aborted: string[] = []
    Object.assign(window, { activeRunAborts: aborted })
    window.fetch = (input, init) => {
      init?.signal?.addEventListener("abort", () => aborted.push(String(input)))
      return original(input, init)
    }
  })
  const { requests } = await workspace(page)
  await page.getByRole("button", { name: "Optimization", exact: true }).click()
  await page.getByRole("button", { name: "Active runs", exact: true }).click()
  await load(page)
  await expect(page.getByLabel("Active run output", { exact: true })).toHaveText(detail.output)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const started = new Set<string>()
  await page.route("**/api/runs{,/unopened-run}", async (route) => {
    const pathname = new URL(route.request().url()).pathname
    started.add(pathname)
    await held
    await route.fulfill({ json: pathname.endsWith("unopened-run") ? { ...detail, output: "Late output" } : [] })
  })
  await inspector(page).getByRole("button", { name: "Refresh list" }).click()
  await inspector(page).getByRole("button", { name: "Check status" }).click()
  await expect.poll(() => started.size).toBe(2)
  await inspector(page).getByRole("button", { name: "Close active runs" }).click()
  const aborted = await page.evaluate(() => (window as unknown as { activeRunAborts: string[] }).activeRunAborts)
  expect(aborted).toContain("/api/runs")
  expect(aborted).toContain("/api/runs/unopened-run")
  release()
  const count = requests.filter((request) => request.path.startsWith("/api/runs")).length
  await page.waitForTimeout(2800)
  expect(requests.filter((request) => request.path.startsWith("/api/runs"))).toHaveLength(count)
  await expect(inspector(page)).toHaveCount(0)
  await expect(page.getByLabel("Run output", { exact: true })).toHaveText(optimizer.output)
})

test("execution-disabled workspaces do not expose or fetch active runs", async ({ page }) => {
  const { requests } = await workspace(page, { execution: false })
  await expect(page.getByRole("button", { name: "Active runs", exact: true })).toHaveCount(0)
  expect(requests.filter((request) => request.path.startsWith("/api/runs"))).toEqual([])
})
