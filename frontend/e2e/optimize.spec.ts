import { test, expect } from "@playwright/test"
import type { Page } from "@playwright/test"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProjectSearch } from "../src/project-picker"

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

const pipelineConfig = '{"dataset_pipe":{},"model_pipeline":{}}'
const completed = { id: "optimizer", name: "optimization", status: "completed", output: "model_pipeline completed: accuracy 0.92, latency 12 ms", truncated: false, recoverable: false, continuable: false }
const running = { ...completed, status: "running", output: "dataset_pipe: preparing dataset", recoverable: true }
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
      if (pathname === `/api/files/${name}`) return route.fulfill({ json: { name, content: name === "objectives.optim" ? pipelineConfig : `Saved ${name}`, revision: "revision-1" } })
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

async function configurePerformance(page: Page, project = "my-project", useEditor = false) {
  await page.getByRole("button", { name: "Performance", exact: true }).click()
  await page.getByRole("textbox", { name: "Project folder", exact: true }).fill(project)
  await page.getByRole("checkbox", { name: "Use current editor as spec", exact: true }).setChecked(useEditor)
}

for (const width of [1440, 390, 320]) {
  for (const selectedTab of [false, true]) {
    test(`project-only Performance at ${width}px with ${selectedTab ? "an ignored editor" : "no selected tab"}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      const { writes, dialogs, errors } = await workspace(page)
      if (selectedTab) {
        await page.getByRole("tabpanel").getByRole("button", { name: /second\.md/ }).click()
        await page.getByRole("textbox", { name: "Edit second.md", exact: true }).fill("Unsaved prose, not pipeline config")
      }
      const button = page.getByRole("button", { name: "Performance", exact: true })
      await button.click()
      await expect(button).toHaveAttribute("aria-expanded", "true")
      const form = page.getByRole("form", { name: "Performance pipelines", exact: true })
      const project = page.getByRole("textbox", { name: "Project folder", exact: true })
      await expect(project).toBeFocused()
      await expect(form).toContainText("performance.json")
      await expect(form).toContainText("Relative to the remote workspace, or an absolute remote path")
      await expect(page.getByRole("checkbox", { name: "Use current editor as spec", exact: true })).not.toBeChecked()
      expect(writes).toEqual([])
      expect(dialogs).toEqual([])
      await project.fill("  team/my project  ")
      for (const control of [project, page.getByRole("button", { name: "Run pipelines", exact: true }), page.getByRole("button", { name: "Cancel", exact: true })]) {
        await control.scrollIntoViewIfNeeded()
        const bounds = await control.boundingBox()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.route("**/api/runs/optimizer", (route) => route.fulfill({ json: completed }))
      await project.press("Enter")
      await expect(page.getByLabel("Run output")).toHaveText(completed.output)
      await expect(form).toBeHidden()
      expect(writes).toEqual([{ path: "/api/optimize", method: "POST", body: { project: "team/my project", spec: null } }])
      expect(dialogs).toHaveLength(1)
      expect(dialogs[0]).toContain("performance.json config; no editor content is sent")
      if (selectedTab) {
        await expect(page.getByRole("textbox", { name: "Edit second.md", exact: true })).toHaveValue("Unsaved prose, not pipeline config")
        await expect(page.locator(".editor-pane .badge")).toHaveText("Unsaved")
      } else {
        await expect(page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button")).toHaveCount(0)
      }
      expect(errors).toEqual([])
    })
  }
}

test("cancel closes the form without confirmation or writes and resets editor opt-in when reopened", async ({ page }) => {
  const { writes, dialogs } = await workspace(page)
  await configurePerformance(page, "my-project", true)
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  const button = page.getByRole("button", { name: "Performance", exact: true })
  await expect(button).toBeFocused()
  await expect(button).toHaveAttribute("aria-expanded", "false")
  await expect(page.getByRole("form", { name: "Performance pipelines" })).toBeHidden()
  await button.click()
  await expect(page.getByRole("checkbox", { name: "Use current editor as spec", exact: true })).not.toBeChecked()
  expect(writes).toEqual([])
  expect(dialogs).toEqual([])
})

test("Performance submits optional editor config, confirms risks, prevents same-tick duplicates, and polls reports", async ({ page }) => {
  const { writes, dialogs, errors, auth } = await workspace(page)
  await page.getByRole("tabpanel").getByRole("button", { name: /objectives\.optim/ }).click()
  await expect(page.getByRole("textbox", { name: "Edit objectives.optim", exact: true })).toHaveValue(pipelineConfig)
  await configurePerformance(page, "  /remote/projects/my project  ", true)
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
  const submit = page.getByRole("button", { name: "Run pipelines", exact: true })
  await submit.evaluate((element: HTMLButtonElement) => { element.click(); element.click() })
  await expect(button).toBeEnabled()
  await expect(submit).toBeDisabled()
  await expect(page.locator("#performance-availability")).toContainText("Another request is in progress")
  await button.click()
  await expect(page.getByRole("form", { name: "Performance pipelines" })).toBeHidden()
  await button.click()
  await expect(page.getByRole("form", { name: "Performance pipelines" })).toBeVisible()
  await expect(submit).toBeDisabled()
  await expect(page.getByRole("status")).toHaveText("Starting pipelines...")
  expect(dialogs).toHaveLength(1)
  expect(dialogs[0]).toMatch(/trusted config.*execute pipeline commands.*write artifacts.*costs/)
  expect(dialogs[0]).toContain("current editor JSON pipeline config (objectives.optim)")
  expect(dialogs[0]).toContain("dataset_pipe and model_pipeline for project /remote/projects/my project?")
  expect(dialogs[0]).toContain("Unsaved editor changes are included")
  expect(dialogs[0]).not.toMatch(/convergence|iteration cap|Prose mode/)
  expect(dialogs[0]).toContain("Use Stop run to stop manually")
  expect(dialogs[0]).toContain("does not save the file locally")
  release()
  await expect(page.getByLabel("Run output")).toHaveText(running.output)
  await expect(page.locator(".topbar .badge")).toHaveText("Optimization: running")
  await expect(button).toHaveText("Performance")
  await expect(button).toBeEnabled()
  await expect(page.getByLabel("Follow output")).toBeChecked()
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await expect(button).toBeEnabled()
  await expect(page.getByRole("button", { name: "Use recommended & continue" })).toBeHidden()
  await expect(page.locator(".editor-pane .badge")).toHaveText("Saved")
  expect(writes).toEqual([{ path: "/api/optimize", method: "POST", body: { project: "/remote/projects/my project", spec: { name: "objectives.optim", content: pipelineConfig } } }])
  expect(auth.every((value) => value === `Bearer ${new URL(url).hash.slice(7)}`)).toBe(true)
  expect(errors).toEqual([])
  expect(polls).toBe(2)
})

test("Performance validates project and explicitly opted-in editor content before confirming or writing", async ({ page }) => {
  const { writes, dialogs } = await workspace(page)
  await page.getByRole("button", { name: "Optimization", exact: true }).click()
  await expect(page.getByLabel("Run output")).toContainText("performance.json is used by default; no editor tab is needed")
  await configurePerformance(page, "   ")
  const button = page.getByRole("button", { name: "Run pipelines", exact: true })
  await button.click()
  await expect(page.getByRole("alert")).toContainText("Enter a project folder")
  await page.getByRole("textbox", { name: "Project folder", exact: true }).fill("my-project")
  await page.getByRole("checkbox", { name: "Use current editor as spec", exact: true }).check()
  await button.click()
  await expect(page.getByRole("alert")).toContainText("Select an editor tab")
  await page.getByRole("tabpanel").getByRole("button", { name: /objectives\.optim/ }).click()
  const editor = page.getByRole("textbox", { name: "Edit objectives.optim", exact: true })
  for (const content of ["", " \n\t ", '{"bad":"\0"}', `"${"\u00e9".repeat(512 * 1024)}"`]) {
    await editor.fill(content)
    await button.click()
    await expect(page.getByRole("alert")).toContainText("nonempty JSON, without NUL bytes, and at most 1 MiB")
    await expect(button).toBeEnabled()
  }
  await editor.fill("Not JSON")
  await button.click()
  await expect(page.getByRole("alert")).toContainText("valid JSON pipeline config")
  expect(dialogs).toEqual([])
  expect(writes).toEqual([])
})

for (const name of ["new.optim", "new.opt", "new.md", "config"]) {
  test(`optional unsaved ${name} uploads without creating a local file or revision`, async ({ page }) => {
    if (name === "new.md") await page.setViewportSize({ width: 320, height: 844 })
    const { writes } = await workspace(page)
    const content = `  ${pipelineConfig}\n`
    await page.getByRole("textbox", { name: "New filename" }).fill(name)
    await page.getByRole("button", { name: "Create file", exact: true }).click()
    const editor = page.getByRole("textbox", { name: `Edit ${name}`, exact: true })
    await editor.fill(content)
    await page.route("**/api/runs/optimizer", (route) => route.fulfill({ json: completed }))
    await configurePerformance(page, "my-project", true)
    await page.getByRole("button", { name: "Run pipelines", exact: true }).click()
    await expect(page.getByLabel("Run output")).toHaveText(completed.output)
    await expect(editor).toHaveValue(content)
    await expect(page.locator(".editor-pane .badge")).toHaveText("Unsaved")
    await expect(page.getByRole("tabpanel").getByRole("button", { name: new RegExp(name.replaceAll(".", "\\.")) })).toHaveCount(0)
    expect(writes).toEqual([{ path: "/api/optimize", method: "POST", body: { project: "my-project", spec: { name, content } } }])
    await page.route(`**/api/files/${name}`, (route) => route.fulfill({ json: { name, content, revision: "revision-2" } }))
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await expect(page.locator(".editor-pane .badge")).toHaveText("Saved")
    expect(writes[1]).toEqual({ path: `/api/files/${name}`, method: "PUT", body: { content, revision: null } })
  })
}

test("dismissing confirmation submits nothing", async ({ page }) => {
  const { writes } = await workspace(page)
  await page.getByRole("tabpanel").getByRole("button", { name: /objectives\.optim/ }).click()
  const editor = page.getByRole("textbox", { name: "Edit objectives.optim", exact: true })
  await editor.fill(` ${pipelineConfig}`)
  page.removeAllListeners("dialog")
  let confirmations = 0
  page.on("dialog", (dialog) => { confirmations++; return dialog.dismiss() })
  await configurePerformance(page, "my-project", true)
  await page.getByRole("button", { name: "Run pipelines", exact: true }).click()
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
  await expect(editor).toHaveValue(` ${pipelineConfig}`)
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
  const content = `  ${pipelineConfig}\n`
  await objectives.fill(content)
  await configurePerformance(page, "my-project", true)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/optimize", async (route) => { await held; await route.fulfill({ json: { id: running.id } }) })
  let finish = false
  await page.route("**/api/runs/optimizer", (route) => route.fulfill({ json: finish ? completed : running }))
  await page.getByRole("button", { name: "Run pipelines", exact: true }).click()
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Save repo changes" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Use recommended & continue" })).toBeDisabled()
  await objectives.press("Control+s")
  await objectives.fill("Edited while submitting")
  // Pause focused-window autosave to isolate the pipeline's write behavior.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")))
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
  await objectives.fill(pipelineConfig)
  await expect(page.locator(".editor-pane .badge")).toHaveText("Saved")
  expect(writes).toEqual([{ path: "/api/optimize", method: "POST", body: { project: "my-project", spec: { name: "objectives.optim", content } } }])
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
  await configurePerformance(page)
  await page.route("**/api/optimize", (route) => route.fulfill({ status: 409, json: { error: "No performance.json config found" } }))
  await page.getByRole("button", { name: "Run pipelines", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("No performance.json config found")
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
  await page.route("**/api/optimize", (route) => route.fulfill({ json: { id: running.id } }))
  await page.route("**/api/runs/optimizer", (route) => route.fulfill({ json: running }))
  await expect(page.getByRole("textbox", { name: "Project folder", exact: true })).toHaveValue("my-project")
  await page.getByRole("button", { name: "Run pipelines", exact: true }).click()
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
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
  await configurePerformance(page)
  await expect(page.getByRole("button", { name: "Run pipelines", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Performance", exact: true }).click()
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
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
  await configurePerformance(page)
  await expect(page.getByRole("button", { name: "Run pipelines", exact: true })).toBeDisabled()
  await page.route("**/api/runs/optimizer", (route) => route.fulfill({ json: completed }))
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await expect(page.getByRole("button", { name: "Run pipelines", exact: true })).toBeEnabled()
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
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
  await configurePerformance(page)
  await expect(page.getByRole("button", { name: "Run pipelines", exact: true })).toBeDisabled()
  expect(writes).toEqual([])
})

test("Performance opens with remote execution instructions but cannot submit when execution is off", async ({ page }) => {
  const { writes, dialogs } = await workspace(page, { execution: false, latest: completed })
  const button = page.getByRole("button", { name: "Performance", exact: true })
  await expect(button).toBeEnabled()
  await button.click()
  const form = page.getByRole("form", { name: "Performance pipelines" })
  await expect(form).toBeVisible()
  const availability = form.locator("#performance-availability")
  await expect(availability).toContainText(/remote execution.*disabled/i)
  await expect(availability).toContainText("SPEC_SSH_TARGET")
  await expect(availability).toContainText("SPEC_SSH_WORKSPACE")
  const submit = form.getByRole("button", { name: "Run pipelines", exact: true })
  await expect(submit).toBeDisabled()
  await expect(form.getByRole("button", { name: "Inspect active runs", exact: true })).toHaveCount(0)
  await submit.evaluate((element: HTMLButtonElement) => element.click())
  await form.evaluate((element: HTMLFormElement) => element.requestSubmit())
  await page.getByRole("button", { name: "Optimization", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  expect(dialogs).toEqual([])
  expect(writes).toEqual([])
})

test("any recoverable file run blocks pipeline launch but not the form even after its tab closes", async ({ page }) => {
  const { writes, dialogs } = await workspace(page, { fileRun: { ...fileOutput, recoverable: true } })
  await page.getByRole("tabpanel").getByRole("button", { name: /optimization/ }).click()
  const button = page.getByRole("button", { name: "Performance", exact: true })
  await expect(button).toBeEnabled()
  await configurePerformance(page)
  const submit = page.getByRole("button", { name: "Run pipelines", exact: true })
  await expect(submit).toBeDisabled()
  await button.click()
  await page.getByRole("button", { name: "Close optimization", exact: true }).click()
  await expect(button).toBeEnabled()
  await button.click()
  await expect(submit).toBeDisabled()
  await expect(page.locator("#performance-availability")).toContainText("Pipeline launch is blocked by active or unresolved runs")
  const blockers = page.getByRole("list", { name: "Blocking runs", exact: true })
  await expect(blockers.getByRole("listitem")).toHaveCount(1)
  for (const value of ["optimization", fileOutput.id, fileOutput.status]) await expect(blockers).toContainText(value)
  expect(writes).toEqual([])
  expect(dialogs).toEqual([])
})

test("Performance opens during a held autosave but pipeline submission waits for it to finish", async ({ page }) => {
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  const { writes, dialogs } = await workspace(page)
  await page.getByRole("tabpanel").getByRole("button", { name: /second\.md/ }).click()
  await configurePerformance(page)
  await page.getByRole("button", { name: "Performance", exact: true }).click()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/files/second.md", async (route) => {
    await held
    await route.fulfill({ json: { name: "second.md", content: "Autosaved draft", revision: "revision-2" } })
  })
  await page.getByRole("textbox", { name: "Edit second.md", exact: true }).fill("Autosaved draft")
  await page.clock.runFor(500)
  await expect.poll(() => writes.length).toBe(1)
  const button = page.getByRole("button", { name: "Performance", exact: true })
  await expect(button).toBeEnabled()
  await button.click()
  const form = page.getByRole("form", { name: "Performance pipelines", exact: true })
  await expect(form).toBeVisible()
  await expect(form.locator("#performance-availability")).toContainText("Another request is in progress")
  const submit = form.getByRole("button", { name: "Run pipelines", exact: true })
  await expect(submit).toBeDisabled()
  await expect(form.getByRole("button", { name: "Inspect active runs", exact: true })).toHaveAttribute("type", "button")
  await form.evaluate((element: HTMLFormElement) => element.requestSubmit())
  expect(dialogs).toEqual([])
  expect(writes).toEqual([{ path: "/api/files/second.md", method: "PUT", body: { content: "Autosaved draft", revision: "revision-1" } }])
  release()
  await expect(page.locator(".editor-pane .badge")).toHaveText("Saved")
  await expect(submit).toBeEnabled()
  await expect(form.locator("#performance-availability").filter({ hasText: "Another request is in progress" })).toHaveCount(0)
  expect(writes).toHaveLength(1)
  expect(dialogs).toEqual([])
  await page.getByRole("textbox", { name: "Project folder", exact: true }).fill("my-project")
  await page.route("**/api/runs/optimizer", (route) => route.fulfill({ json: completed }))
  await submit.click()
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  expect(dialogs).toHaveLength(1)
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual({ path: "/api/optimize", method: "POST", body: { project: "my-project", spec: null } })
})

test("Performance header is disabled only in settings and otherwise exposes nonlaunching inspection", async ({ page }) => {
  const { writes, dialogs } = await workspace(page)
  await page.route("**/api/runs", (route) => route.fulfill({ json: [] }))
  await configurePerformance(page)
  const form = page.getByRole("form", { name: "Performance pipelines", exact: true })
  const inspect = form.getByRole("button", { name: "Inspect active runs", exact: true })
  await expect(inspect).toHaveAttribute("type", "button")
  await inspect.click()
  const panel = page.getByRole("region", { name: "Active runs", exact: true })
  await expect(panel).toContainText("No active runs.")
  await expect(form.getByRole("button", { name: "Run pipelines", exact: true })).toBeEnabled()
  await panel.getByRole("button", { name: "Close active runs", exact: true }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const button = page.getByRole("button", { name: "Performance", exact: true })
  await expect(button).toBeDisabled()
  await expect(form).toBeHidden()
  await page.getByRole("button", { name: "Back to workspace", exact: true }).click()
  await expect(button).toBeEnabled()
  expect(writes).toEqual([])
  expect(dialogs).toEqual([])
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

const projectMatches: ProjectSearch = {
  projects: [{ name: "my-project", path: "/remote/workspace/team/my-project" }, { name: "my-project", path: "/remote/workspace/other/my-project" }],
  root: "/remote/workspace",
  truncated: false,
  agent: "explore",
}

for (const width of [1440, 390, 320]) {
  test(`Explore search is explicit and selecting a result only fills the path at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const { writes, dialogs, errors, auth } = await workspace(page)
    await page.route("**/api/projects/search", (route) => route.fulfill({ json: projectMatches }))
    await configurePerformance(page)
    const project = page.getByRole("textbox", { name: "Project folder", exact: true })
    await project.fill("my")
    await project.fill("my-project")
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.getByRole("button", { name: "Performance", exact: true }).click()
    expect(writes).toEqual([])
    await expect(page.getByText("Project names are sent, not file contents.", { exact: false })).toBeVisible()
    await page.getByRole("button", { name: "Search with Explore", exact: true }).click()
    const results = page.getByRole("combobox", { name: "Matching projects", exact: true })
    await expect(results).toBeVisible()
    await expect(results.getByRole("option")).toHaveCount(3)
    await expect(page.getByRole("form", { name: "Performance pipelines" }).getByRole("status")).toContainText("Search root: /remote/workspace")
    await expect(project).toHaveValue("my-project")
    await results.focus()
    await results.press("ArrowDown")
    await expect(project).toHaveValue(projectMatches.projects[0].path)
    await results.selectOption(projectMatches.projects[1].path)
    await expect(project).toHaveValue(projectMatches.projects[1].path)
    expect(writes).toEqual([{ path: "/api/projects/search", method: "POST", body: { query: "my-project" } }])
    expect(dialogs).toEqual([])
    for (const control of [project, results, page.getByRole("button", { name: "Search with Explore", exact: true })]) {
      await control.scrollIntoViewIfNeeded()
      const bounds = await control.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByRole("button", { name: "Run pipelines", exact: true }).click()
    await expect(page.getByLabel("Run output")).toHaveText(running.output)
    expect(writes[1]).toEqual({ path: "/api/optimize", method: "POST", body: { project: projectMatches.projects[1].path, spec: null } })
    expect(auth.every((value) => value === `Bearer ${new URL(url).hash.slice(7)}`)).toBe(true)
    expect(errors).toEqual([])
  })
}

test("Explore prevents duplicate searches and pipeline submission without blocking editing or local save", async ({ page }) => {
  const { writes, dialogs } = await workspace(page)
  await page.getByRole("tabpanel").getByRole("button", { name: /second\.md/ }).click()
  await configurePerformance(page)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/projects/search", async (route) => { await held; await route.fulfill({ json: projectMatches }) })
  const search = page.getByRole("button", { name: "Search with Explore", exact: true })
  await search.evaluate((element: HTMLButtonElement) => { element.click(); element.click() })
  await expect(search).toBeDisabled()
  await expect(page.getByRole("form", { name: "Performance pipelines" }).getByRole("status")).toContainText("This can take up to a minute")
  await expect(page.getByRole("button", { name: "Run pipelines", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
  await expect(page.locator("#performance-availability")).toContainText("Wait for project search to finish")
  await page.getByRole("textbox", { name: "Project folder", exact: true }).press("Enter")
  const editor = page.getByRole("textbox", { name: "Edit second.md", exact: true })
  await editor.fill("Edited during project search")
  await page.route("**/api/files/second.md", (route) => route.fulfill({ json: { name: "second.md", content: "Edited during project search", revision: "revision-2" } }))
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.locator(".editor-pane .badge")).toHaveText("Saved")
  await expect(search).toBeDisabled()
  expect(writes.map((write) => write.path)).toEqual(["/api/projects/search", "/api/files/second.md"])
  expect(dialogs).toEqual([])
  release()
  await expect(page.getByRole("combobox", { name: "Matching projects", exact: true })).toBeVisible()
  await expect(search).toBeEnabled()
  await expect(page.getByRole("button", { name: "Run pipelines", exact: true })).toBeEnabled()
  await expect(page.locator("#performance-availability").filter({ hasText: "Wait for project search to finish" })).toHaveCount(0)
})

test("Explore validates names by UTF-8 bytes without restricting manual paths", async ({ page }) => {
  const { writes } = await workspace(page)
  await configurePerformance(page)
  const project = page.getByRole("textbox", { name: "Project folder", exact: true })
  const search = page.getByRole("button", { name: "Search with Explore", exact: true })
  for (const value of [" ", "a".repeat(101), "\u00e9".repeat(51), "bad\u007fname", "bad\u0085name", "../my-project", "/remote/project", "team\\project", ".", ".."]) {
    await project.fill(value)
    await search.click()
    await expect(page.getByRole("alert")).toContainText("Search by project name")
  }
  expect(writes).toEqual([])
  await page.route("**/api/projects/search", (route) => route.fulfill({ json: projectMatches }))
  for (const value of ["a", "\u00e9".repeat(50)]) {
    await project.fill(` ${value} `)
    await search.click()
    await expect(page.getByRole("combobox", { name: "Matching projects", exact: true })).toBeVisible()
    expect(writes.at(-1)?.body).toEqual({ query: value })
  }
  const manual = `/remote/${"long-project-".repeat(12)}`
  await project.fill(manual)
  await search.click()
  await page.getByRole("button", { name: "Run pipelines", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText(running.output)
  expect(writes.at(-1)?.body).toEqual({ project: manual, spec: null })
})

test("Explore shows empty, error, retry, root and truncated results on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 })
  const { writes, errors } = await workspace(page)
  await configurePerformance(page)
  let searches = 0
  const root = `/remote/${"workspace-".repeat(30)}`
  const projects = Array.from({ length: 20 }, (_, i) => ({ name: `project-${i}`, path: `${root}/project-${i}` }))
  await page.route("**/api/projects/search", (route) => {
    searches++
    if (searches === 1) return route.fulfill({ json: { ...projectMatches, projects: [] } })
    if (searches === 2) return route.fulfill({ status: 503, json: { error: "Explore unavailable" } })
    return route.fulfill({ json: { ...projectMatches, projects, root, truncated: true } })
  })
  const search = page.getByRole("button", { name: "Search with Explore", exact: true })
  await search.click()
  await expect(page.getByRole("form", { name: "Performance pipelines" }).getByRole("status")).toContainText("No matching projects")
  await expect(page.getByRole("combobox", { name: "Matching projects", exact: true })).toBeHidden()
  await search.click()
  await expect(page.getByRole("alert")).toContainText("Explore unavailable")
  await expect(search).toBeEnabled()
  await search.click()
  await expect(page.getByRole("alert")).toBeHidden()
  await expect(page.getByRole("form", { name: "Performance pipelines" }).getByRole("status")).toContainText(root)
  await expect(page.getByText("Results are truncated", { exact: false })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Matching projects", exact: true }).getByRole("option")).toHaveCount(21)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(writes).toHaveLength(3)
  expect(writes.every((write) => write.path === "/api/projects/search")).toBe(true)
  expect(errors).toEqual([])
})

declare global {
  interface Window {
    projectSearchRequests: { signal: AbortSignal; resolve: (response: Response) => void; reject: (error: Error) => void }[]
  }
}

for (const close of ["Cancel", "Performance", "Settings"]) {
  test(`Explore ignores reordered responses after edits and ${close} closes the picker`, async ({ page }) => {
    // Deliberately ignore abort in this transport to exercise the stale-response guard too.
    await page.addInitScript(() => {
      const original = window.fetch.bind(window)
      window.projectSearchRequests = []
      window.fetch = (input, init) => String(input) === "/api/projects/search"
        ? new Promise<Response>((resolve, reject) => window.projectSearchRequests.push({ signal: init!.signal as AbortSignal, resolve, reject }))
        : original(input, init)
    })
    const { writes, dialogs, errors } = await workspace(page)
    await configurePerformance(page, "old")
    const project = page.getByRole("textbox", { name: "Project folder", exact: true })
    const search = page.getByRole("button", { name: "Search with Explore", exact: true })
    await search.click()
    await project.fill("new")
    expect(await page.evaluate(() => window.projectSearchRequests[0].signal.aborted)).toBe(true)
    await search.click()
    await page.evaluate(() => window.projectSearchRequests[0].reject(new Error("Obsolete failure")))
    await expect(search).toBeDisabled()
    await expect(page.getByRole("alert")).toBeHidden()
    await project.fill("newest")
    await search.click()
    await page.evaluate((json) => window.projectSearchRequests[2].resolve(new Response(JSON.stringify(json))), projectMatches)
    await expect(page.getByRole("combobox", { name: "Matching projects", exact: true })).toBeVisible()
    await page.evaluate(() => window.projectSearchRequests[1].resolve(new Response(JSON.stringify({ projects: [], root: "/obsolete", agent: "explore", truncated: false }))))
    await expect(page.getByRole("form", { name: "Performance pipelines" }).getByRole("status")).toContainText(projectMatches.root)
    await expect(project).toHaveValue("newest")
    await search.click()
    await page.getByRole("button", { name: close, exact: true }).click()
    expect(await page.evaluate(() => window.projectSearchRequests[3].signal.aborted)).toBe(true)
    if (close === "Settings") await page.getByRole("button", { name: "Back to workspace", exact: true }).click()
    else await page.getByRole("button", { name: "Performance", exact: true }).click()
    await page.evaluate((json) => window.projectSearchRequests[3].resolve(new Response(JSON.stringify(json))), projectMatches)
    await expect(project).toHaveValue("newest")
    await expect(page.getByRole("combobox", { name: "Matching projects", exact: true })).toBeHidden()
    await expect(search).toBeEnabled()
    await expect(page.getByRole("button", { name: "Run pipelines", exact: true })).toBeEnabled()
    expect(await page.evaluate(() => window.projectSearchRequests.length)).toBe(4)
    expect(writes).toEqual([])
    expect(dialogs).toEqual([])
    expect(errors).toEqual([])
  })
}
