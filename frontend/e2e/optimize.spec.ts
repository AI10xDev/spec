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
  directory = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "spec-optimize-e2e-"))
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

const completed = { id: "optimizer", name: "optimization", status: "completed", output: "Converged: gain 0.0001, marginal difference 0.00001", truncated: false, recoverable: false, continuable: false }
const running = { ...completed, status: "running", output: "Iteration 1: gain 0.12", recoverable: true }
const fileOutput = { ...completed, id: "file-run", output: "Independent file logs", continuable: true }

async function workspace(page: Page, options: { latest?: typeof completed | null; fileRun?: typeof completed; execution?: boolean; recoveryError?: number } = {}) {
  const writes: { path: string; method: string; body: unknown }[] = []
  const dialogs: string[] = []
  const errors: string[] = []
  const auth: string[] = []
  page.on("request", (request) => {
    if (!request.url().includes("/api/")) return
    auth.push(request.headers().authorization ?? "")
    if (request.method() !== "GET") writes.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postDataJSON() })
  })
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.accept() })
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    if (pathname === "/api/optimize") {
      if (request.method() === "POST") return route.fulfill({ json: { id: running.id } })
      if (options.recoveryError) return route.fulfill({ status: options.recoveryError, json: { error: "Recovery unavailable" } })
      return route.fulfill({ json: options.latest ?? null })
    }
    if (request.method() !== "GET") return route.fulfill({ status: 500, json: { error: "Unexpected write" } })
    if (pathname === "/api/config") return route.fulfill({ json: { execution: options.execution ?? true, completion: false, chat: false, realtime: false, azureRealtime: false } })
    if (pathname === "/api/files") return route.fulfill({ json: ["optimization", "objectives.optim", "second.md"].map((name) => ({ name, modified: 0, bytes: 10 })) })
    if (pathname === "/api/repository") return route.fulfill({ json: { connected: true, dirty: true, directory: "/fixture", model: "fixture-model" } })
    for (const name of ["optimization", "objectives.optim", "second.md"]) {
      if (pathname === `/api/files/${name}`) return route.fulfill({ json: { name, content: `Saved ${name}`, revision: "revision-1" } })
      if (pathname === `/api/files/${name}/run`) return route.fulfill({ json: { ...(options.fileRun ?? fileOutput), name } })
    }
    if (pathname === `/api/runs/${running.id}`) return route.fulfill({ json: options.latest ?? running })
    if (pathname === `/api/runs/${fileOutput.id}`) return route.fulfill({ json: options.fileRun ?? fileOutput })
    return route.fulfill({ status: 404, json: { error: `Unexpected request: ${pathname}` } })
  })
  await page.goto(url)
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeVisible()
  return { writes, dialogs, errors, auth }
}

test("Performance uploads the active .optim buffer, confirms risks, prevents same-tick duplicates, and polls reports", async ({ page }) => {
  const { writes, dialogs, errors, auth } = await workspace(page)
  await page.getByRole("tabpanel").getByRole("button", { name: /objectives\.optim/ }).click()
  await expect(page.getByRole("textbox", { name: "Edit objectives.optim", exact: true })).toHaveValue("Saved objectives.optim")
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/optimize", async (route) => {
    await held
    await route.fulfill({ json: { id: running.id } })
  })
  let polls = 0
  await page.route("**/api/runs/optimizer", (route) => route.fulfill({ json: ++polls === 1 ? running : completed }))
  const button = page.getByRole("button", { name: "Performance", exact: true })
  await page.getByLabel("Follow output").uncheck()
  await button.evaluate((element: HTMLButtonElement) => { element.click(); element.click() })
  await expect(button).toBeDisabled()
  await expect(page.getByRole("status")).toHaveText("Starting optimization...")
  expect(dialogs).toHaveLength(1)
  expect(dialogs[0]).toMatch(/trusted \.optim commands.*modify files.*incur provider costs/)
  expect(dialogs[0]).toContain("current .optim editor buffer (objectives.optim) to remote ~/projects")
  expect(dialogs[0]).toContain("absolute remote path")
  expect(dialogs[0]).toContain("Unsaved editor changes are included")
  expect(dialogs[0]).toContain("Prose mode sends project context to model providers")
  expect(dialogs[0]).toContain("loops until convergence, with no automatic time or iteration cap")
  expect(dialogs[0]).toContain("Use Stop run to stop it manually")
  expect(dialogs[0]).toContain("does not save the file locally")
  release()
  await expect(page.getByLabel("Run output")).toHaveText(running.output)
  await expect(page.locator(".topbar .badge")).toHaveText("Optimization: running")
  await expect(button).toHaveText("Performance")
  await expect(button).toBeDisabled()
  await expect(page.getByLabel("Follow output")).toBeChecked()
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await expect(button).toBeEnabled()
  await expect(page.getByRole("button", { name: "Use recommended & continue" })).toBeHidden()
  await expect(page.locator(".editor-pane .badge")).toHaveText("Saved")
  expect(writes).toEqual([{ path: "/api/optimize", method: "POST", body: { name: "objectives.optim", content: "Saved objectives.optim" } }])
  expect(auth.every((value) => value === `Bearer ${new URL(url).hash.slice(7)}`)).toBe(true)
  expect(errors).toEqual([])
  expect(polls).toBe(2)
})

test("Performance requires a selected nonempty .optim tab without confirming or writing", async ({ page }) => {
  const { writes, dialogs } = await workspace(page)
  const button = page.getByRole("button", { name: "Performance", exact: true })
  await page.getByRole("button", { name: "Optimization", exact: true }).click()
  await expect(page.getByLabel("Run output")).toContainText("current editor buffer, including unsaved changes, is uploaded to remote ~/projects")
  await expect(page.getByLabel("Run output")).toContainText("No local save is performed")
  await button.click()
  await expect(page.getByRole("alert")).toContainText("Open or create a file with a name ending in .optim")
  await page.getByRole("tabpanel").getByRole("button", { name: /objectives\.optim/ }).click()
  const editor = page.getByRole("textbox", { name: "Edit objectives.optim", exact: true })
  for (const content of ["", " \n\t "]) {
    await editor.fill(content)
    await button.click()
    await expect(page.getByRole("alert")).toContainText("enter your optimization instructions")
    await expect(button).toBeEnabled()
  }
  await editor.fill("Valid instructions in an inactive tab")
  for (const name of ["second.md", "objectives.optim.txt", "objectives.OPTIM"]) {
    await page.getByRole("textbox", { name: "New filename" }).fill(name)
    await page.getByRole("button", { name: "Create file", exact: true }).click()
    await page.getByRole("textbox", { name: `Edit ${name}`, exact: true }).fill("Not an .optim file")
    await button.click()
    await expect(page.getByRole("alert")).toContainText("select that tab before clicking Performance")
    await expect(button).toBeEnabled()
  }
  expect(dialogs).toEqual([])
  expect(writes).toEqual([])
})

test("a newly created unsaved .optim uploads without creating a local file or revision", async ({ page }) => {
  const { writes } = await workspace(page)
  const name = "new.optim"
  const content = "Measure throughput and improve it.\n"
  await page.getByRole("textbox", { name: "New filename" }).fill(name)
  await page.getByRole("button", { name: "Create file", exact: true }).click()
  const editor = page.getByRole("textbox", { name: `Edit ${name}`, exact: true })
  await editor.fill(content)
  await page.route("**/api/runs/optimizer", (route) => route.fulfill({ json: completed }))
  await page.getByRole("button", { name: "Performance", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await expect(editor).toHaveValue(content)
  await expect(page.locator(".editor-pane .badge")).toHaveText("Unsaved")
  await expect(page.getByRole("tabpanel").getByRole("button", { name: /new\.optim/ })).toHaveCount(0)
  expect(writes).toEqual([{ path: "/api/optimize", method: "POST", body: { name, content } }])
  await page.route("**/api/files/new.optim", (route) => route.fulfill({ json: { name, content, revision: "revision-2" } }))
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.locator(".editor-pane .badge")).toHaveText("Saved")
  expect(writes[1]).toEqual({ path: "/api/files/new.optim", method: "PUT", body: { content, revision: null } })
})

test("dismissing confirmation submits nothing", async ({ page }) => {
  const { writes } = await workspace(page)
  await page.getByRole("tabpanel").getByRole("button", { name: /objectives\.optim/ }).click()
  const editor = page.getByRole("textbox", { name: "Edit objectives.optim", exact: true })
  await editor.fill("Unsaved instructions")
  page.removeAllListeners("dialog")
  let confirmations = 0
  page.on("dialog", (dialog) => { confirmations++; return dialog.dismiss() })
  await page.getByRole("button", { name: "Performance", exact: true }).click()
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
  await expect(editor).toHaveValue("Unsaved instructions")
  await expect(page.locator(".editor-pane .badge")).toHaveText("Unsaved")
  expect(confirmations).toBe(1)
  expect(writes).toEqual([])
})

test("optimization is separate from a same-named file and preserves unsaved tabs and prior logs", async ({ page }) => {
  const { writes, errors } = await workspace(page)
  await page.getByRole("tabpanel").getByRole("button", { name: /optimization/ }).click()
  const editor = page.getByRole("textbox", { name: "Edit optimization", exact: true })
  await editor.fill("Unsaved optimization file")
  await expect(page.getByLabel("Run output")).toHaveText(fileOutput.output)
  await page.getByRole("tabpanel").getByRole("button", { name: /objectives\.optim/ }).click()
  const objectives = page.getByRole("textbox", { name: "Edit objectives.optim", exact: true })
  const content = "  Optimize latency using measurements.\nPreserve behavior.\n"
  await objectives.fill(content)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/optimize", async (route) => { await held; await route.fulfill({ json: { id: running.id } }) })
  let finish = false
  await page.route("**/api/runs/optimizer", (route) => route.fulfill({ json: finish ? completed : running }))
  await page.getByRole("button", { name: "Performance", exact: true }).click()
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Save repo changes" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Use recommended & continue" })).toBeDisabled()
  await objectives.press("Control+s")
  await objectives.fill("Edited while submitting")
  release()
  await expect(page.getByLabel("Run output")).toHaveText(running.output)
  await expect(objectives).toHaveValue("Edited while submitting")
  await expect(page.locator(".editor-pane .badge")).toHaveText("Unsaved")
  await page.getByRole("button", { name: "Current file: objectives.optim", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText(fileOutput.output)
  await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Use recommended & continue" })).toBeDisabled()
  await page.getByRole("tabpanel").getByRole("button", { name: /second\.md/ }).click()
  await page.getByRole("textbox", { name: "Edit second.md" }).fill("Unsaved second tab")
  finish = true
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Optimization", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await expect(page.getByRole("textbox", { name: "Edit second.md" })).toHaveValue("Unsaved second tab")
  await page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button", { name: /^optimization/ }).click()
  await expect(editor).toHaveValue("Unsaved optimization file")
  await page.getByRole("button", { name: "Current file: optimization", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText(fileOutput.output)
  await page.getByRole("button", { name: "Optimization", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button", { name: /^objectives\.optim/ }).click()
  await expect(objectives).toHaveValue("Edited while submitting")
  await expect(page.locator(".editor-pane .badge")).toHaveText("Unsaved")
  await objectives.fill("Saved objectives.optim")
  await expect(page.locator(".editor-pane .badge")).toHaveText("Saved")
  expect(writes).toEqual([{ path: "/api/optimize", method: "POST", body: { name: "objectives.optim", content } }])
  expect(errors).toEqual([])
})

test("Stop run cancels optimization through the shared endpoint and polls final status", async ({ page }) => {
  const { writes } = await workspace(page, { latest: running })
  let cancelled = false
  await page.route("**/api/runs/optimizer/cancel", (route) => {
    cancelled = true
    return route.fulfill({ json: {} })
  })
  await page.route("**/api/runs/optimizer", (route) => route.fulfill({ json: cancelled ? { ...completed, status: "cancelled", output: "Stopped manually" } : running }))
  await page.getByRole("button", { name: "Stop run", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText("Stopped manually")
  await expect(page.locator(".output-pane .badge")).toHaveText("cancelled")
  await expect(page.getByRole("button", { name: "Stop run", exact: true })).toBeHidden()
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
  expect(writes).toEqual([{ path: "/api/runs/optimizer/cancel", method: "POST", body: {} }])
})

test("submission errors retain previous logs and allow retry", async ({ page }) => {
  const { writes } = await workspace(page, { latest: completed })
  await page.getByRole("tabpanel").getByRole("button", { name: /objectives\.optim/ }).click()
  await page.getByRole("button", { name: "Optimization", exact: true }).click()
  await page.route("**/api/optimize", (route) => route.fulfill({ status: 409, json: { error: "No trusted .optim file found" } }))
  await page.getByRole("button", { name: "Performance", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("No trusted .optim file found")
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
  await page.route("**/api/optimize", (route) => route.fulfill({ json: { id: running.id } }))
  await page.route("**/api/runs/optimizer", (route) => route.fulfill({ json: running }))
  await page.getByRole("button", { name: "Performance", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText(running.output)
  await expect(page.getByRole("alert")).toBeHidden()
  expect(writes).toHaveLength(2)
})

test("poll and cancellation errors leave the optimizer recoverable", async ({ page }) => {
  await workspace(page, { latest: running })
  let polls = 0
  await page.route("**/api/runs/optimizer", (route) => ++polls === 1
    ? route.fulfill({ status: 503, json: { error: "Temporary poll failure" } })
    : route.fulfill({ json: { ...running, output: "Polling recovered" } }))
  await expect(page.getByRole("alert")).toContainText("Temporary poll failure")
  await expect(page.getByLabel("Run output")).toHaveText(running.output)
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeDisabled()
  await expect(page.getByLabel("Run output")).toHaveText("Polling recovered")
  await page.route("**/api/runs/optimizer/cancel", (route) => route.fulfill({ status: 500, json: { error: "Cancellation unavailable" } }))
  await page.getByRole("button", { name: "Stop run" }).click()
  await expect(page.getByRole("alert")).toContainText("Cancellation unavailable")
  await expect(page.getByRole("button", { name: "Stop run" })).toBeEnabled()
})

test("reload restores the latest optimizer and resumes polling without opening a file", async ({ page }) => {
  const { writes } = await workspace(page, { latest: running })
  await page.getByRole("button", { name: "Current file output" }).click()
  await page.reload()
  await expect(page.getByRole("button", { name: "Optimization", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByLabel("Run output")).toHaveText(running.output)
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeDisabled()
  await page.route("**/api/runs/optimizer", (route) => route.fulfill({ json: completed }))
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await expect(page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button")).toHaveCount(0)
  expect(writes).toEqual([])
})

for (const recoveryError of [404, 503]) {
  test(`optimization recovery HTTP ${recoveryError} does not prevent connecting`, async ({ page }) => {
    await workspace(page, { recoveryError })
    await expect(page.getByRole("alert")).toContainText("Could not recover optimization output")
    await page.getByRole("tabpanel").getByRole("button", { name: /optimization/ }).click()
    await expect(page.getByRole("textbox", { name: "Edit optimization", exact: true })).toHaveValue("Saved optimization")
  })
}

test("failed initial recovery can be retried to restore polling and cancellation", async ({ page }) => {
  const { writes } = await workspace(page, { recoveryError: 503 })
  await expect(page.getByRole("alert")).toContainText("Select Optimization to retry")
  await page.route("**/api/optimize", (route) => route.fulfill({ json: running }))
  await page.getByRole("button", { name: "Optimization", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText(running.output)
  await expect(page.getByRole("alert")).toBeHidden()
  await expect(page.getByRole("button", { name: "Stop run", exact: true })).toBeEnabled()
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeDisabled()
  expect(writes).toEqual([])
})

test("Performance is disabled when execution is off", async ({ page }) => {
  const { writes } = await workspace(page, { execution: false, latest: completed })
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Optimization", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  expect(writes).toEqual([])
})

test("any recoverable file run blocks Performance even after its tab closes", async ({ page }) => {
  await workspace(page, { fileRun: { ...fileOutput, recoverable: true } })
  await page.getByRole("tabpanel").getByRole("button", { name: /optimization/ }).click()
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Close optimization", exact: true }).click()
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeDisabled()
})

test("header and output controls fit narrow mobile screens", async ({ page }) => {
  await workspace(page, { latest: running })
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    for (const name of ["Performance", "Optimization", "Stop run"]) {
      const button = page.getByRole("button", { name, exact: true })
      await button.scrollIntoViewIfNeeded()
      await expect(button).toBeVisible()
      const bounds = await button.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
})
