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

const pipelineConfig = "Run the built Gemma RL workflow with the existing local data. Do not rebuild or download anything."
const completed = { id: "optimizer", name: "Performance", status: "completed", output: "Gemma RL completed: measured reward 0.92", truncated: false, recoverable: false, continuable: false }
const running = { ...completed, status: "running", output: "Gemma RL: running built workflow", recoverable: true }
const fileOutput = { ...completed, id: "file-run", output: "Independent file logs", continuable: true }

async function workspace(page: Page, options: { latest?: typeof completed | null; fileRun?: typeof completed; execution?: boolean; recoveryError?: number } = {}) {
  const writes: { path: string; method: string; body: unknown }[] = []
  const dialogs: string[] = []
  const errors: string[] = []
  const auth: string[] = []
  const reads: string[] = []
  page.on("request", (request) => {
    if (!request.url().includes("/api/")) return
    auth.push(request.headers().authorization ?? "")
    if (request.method() === "GET") reads.push(new URL(request.url()).pathname)
    if (request.method() !== "GET") writes.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postDataJSON() })
  })
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.accept() })
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    if (pathname === "/api/performance") {
      if (request.method() === "POST") return route.fulfill({ json: { id: running.id } })
      if (options.recoveryError) return route.fulfill({ status: options.recoveryError, json: { error: "Recovery unavailable" } })
      return route.fulfill({ json: options.latest ?? null })
    }
    if (pathname === "/api/performance/runs") return route.fulfill({ json: [] })
    if (request.method() !== "GET") return route.fulfill({ status: 500, json: { error: "Unexpected write" } })
    if (pathname === "/api/config") return route.fulfill({ json: { execution: options.execution ?? true, completion: false, chat: false, realtime: false, azureRealtime: false } })
    if (pathname === "/api/files") return route.fulfill({ json: ["optimization", "objectives.optim", "second.md"].map((name) => ({ name, modified: 0, bytes: 10 })) })
    if (pathname === "/api/repository") return route.fulfill({ json: { connected: true, dirty: true, directory: "/fixture", model: "fixture-model" } })
    for (const name of ["optimization", "objectives.optim", "second.md"]) {
      if (pathname === `/api/files/${name}`) return route.fulfill({ json: { name, content: name === "objectives.optim" ? pipelineConfig : `Saved ${name}`, revision: "revision-1" } })
      if (pathname === `/api/files/${name}/run`) return route.fulfill({ json: { ...(options.fileRun ?? fileOutput), name } })
    }
    if (pathname === `/api/performance/runs/${running.id}`) return route.fulfill({ json: options.latest ?? running })
    if (pathname === `/api/runs/${fileOutput.id}`) return route.fulfill({ json: options.fileRun ?? fileOutput })
    return route.fulfill({ status: 404, json: { error: `Unexpected request: ${pathname}` } })
  })
  await page.goto(url)
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeVisible()
  return { writes, dialogs, errors, auth, reads }
}

async function configurePerformance(page: Page, project = "my-project", useEditor = false) {
  await page.getByRole("button", { name: "Performance", exact: true }).click()
  await page.getByRole("textbox", { name: "Project folder", exact: true }).fill(project)
  await page.getByRole("checkbox", { name: "Use current editor as instructions", exact: true }).setChecked(useEditor)
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
      await expect(page.getByTitle("performance", { exact: true })).toHaveCount(1)
      await expect(button).toHaveAttribute("title", "performance")
      await expect(button).toHaveAttribute("aria-controls", "performance-form")
      await expect(button).toHaveAttribute("aria-expanded", "false")
      await expect(button).toBeEnabled()
      await button.focus()
      await button.press("Enter")
      await expect(button).toHaveAttribute("aria-expanded", "true")
      const form = page.getByRole("form", { name: "Performance builder", exact: true })
      await expect(form).toHaveAttribute("id", "performance-form")
      const project = page.getByRole("textbox", { name: "Project folder", exact: true })
      await expect(project).toBeFocused()
      await expect(form).toContainText("fresh builder session, independent of spec runs")
      await expect(form).toContainText("Relative to the remote workspace, or an absolute remote path")
      await expect(page.getByRole("checkbox", { name: "Use current editor as instructions", exact: true })).not.toBeChecked()
      expect(writes).toEqual([])
      expect(dialogs).toEqual([])
      await project.fill("  team/my project  ")
      for (const control of [project, page.getByRole("button", { name: "Run Gemma RL (built)", exact: true }), page.getByRole("button", { name: "Cancel", exact: true })]) {
        await control.scrollIntoViewIfNeeded()
        const bounds = await control.boundingBox()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.route("**/api/performance/runs/optimizer", (route) => route.fulfill({ json: completed }))
      await project.press("Enter")
      await expect(page.getByLabel("Run output")).toHaveText(completed.output)
      await expect(form).toBeHidden()
      await expect(button).toHaveAttribute("aria-expanded", "false")
      expect(writes).toEqual([{ path: "/api/performance", method: "POST", body: { project: "team/my project", spec: null } }])
      expect(dialogs).toHaveLength(1)
      expect(dialogs[0]).toContain("No editor content is sent; no editor tab is needed")
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
  await expect(page.getByRole("form", { name: "Performance builder" })).toBeHidden()
  await button.click()
  await expect(page.getByRole("checkbox", { name: "Use current editor as instructions", exact: true })).not.toBeChecked()
  expect(writes).toEqual([])
  expect(dialogs).toEqual([])
})

test("Performance submits prose instructions, confirms risks, prevents same-tick duplicates, and polls reports", async ({ page }) => {
  const { writes, dialogs, errors, auth } = await workspace(page)
  await page.getByRole("tabpanel").getByRole("button", { name: /objectives\.optim/ }).click()
  await expect(page.getByRole("textbox", { name: "Edit objectives.optim", exact: true })).toHaveValue(pipelineConfig)
  await configurePerformance(page, "  /remote/projects/my project  ", true)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/performance", async (route) => {
    await held
    await route.fulfill({ json: { id: running.id } })
  })
  let polls = 0
  await page.route("**/api/performance/runs/optimizer", (route) => route.fulfill({ json: ++polls === 1 ? running : completed }))
  const button = page.getByRole("button", { name: "Performance", exact: true })
  await page.getByLabel("Follow output").uncheck()
  const submit = page.getByRole("button", { name: "Run Gemma RL (built)", exact: true })
  await submit.evaluate((element: HTMLButtonElement) => { element.click(); element.click() })
  await expect(button).toBeEnabled()
  await expect(submit).toBeDisabled()
  await expect(page.locator("#performance-availability")).toContainText("A Performance request is in progress")
  await button.click()
  await expect(page.getByRole("form", { name: "Performance builder" })).toBeHidden()
  await button.click()
  await expect(page.getByRole("form", { name: "Performance builder" })).toBeVisible()
  await expect(submit).toBeDisabled()
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled()
  await expect(page.getByRole("button", { name: "Save & run" })).toBeEnabled()
  expect(dialogs).toHaveLength(1)
  expect(dialogs[0]).toMatch(/Authorize tools.*execute the built workflow.*write artifacts.*costs/)
  expect(dialogs[0]).toContain("current editor builder instructions (objectives.optim)")
  expect(dialogs[0]).toContain("Run Gemma RL (built) for project /remote/projects/my project through its own fresh builder session?")
  expect(dialogs[0]).toContain("no automatic rebuild, model or dataset download, or data fabrication")
  expect(dialogs[0]).toContain("Unsaved editor changes are included")
  expect(dialogs[0]).not.toMatch(/convergence|iteration cap|Prose mode/)
  expect(dialogs[0]).toContain("Use Stop run in Performance output to stop this session only")
  expect(dialogs[0]).toContain("does not save the file locally")
  release()
  await expect(page.getByLabel("Run output")).toHaveText(running.output)
  await expect(page.locator(".topbar .badge")).toHaveText("Performance: running")
  await expect(button).toHaveText("Performance")
  await expect(button).toBeEnabled()
  await expect(page.getByLabel("Follow output")).toBeChecked()
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await expect(button).toBeEnabled()
  await expect(page.getByRole("button", { name: "Use recommended & continue" })).toBeHidden()
  await expect(page.locator(".editor-pane .badge")).toHaveText("Saved")
  expect(writes).toEqual([{ path: "/api/performance", method: "POST", body: { project: "/remote/projects/my project", spec: { name: "objectives.optim", content: pipelineConfig } } }])
  expect(auth.every((value) => value === `Bearer ${new URL(url).hash.slice(7)}`)).toBe(true)
  expect(errors).toEqual([])
  expect(polls).toBe(2)
})

test("Performance validates project and explicitly opted-in editor content before confirming or writing", async ({ page }) => {
  const { writes, dialogs } = await workspace(page)
  await page.getByRole("button", { name: "Performance output", exact: true }).click()
  await expect(page.getByLabel("Run output")).toContainText("No editor tab is needed")
  await configurePerformance(page, "   ")
  const button = page.getByRole("button", { name: "Run Gemma RL (built)", exact: true })
  await button.click()
  await expect(page.getByRole("alert")).toContainText("Enter a project folder")
  await page.getByRole("textbox", { name: "Project folder", exact: true }).fill("my-project")
  await page.getByRole("checkbox", { name: "Use current editor as instructions", exact: true }).check()
  await button.click()
  await expect(page.getByRole("alert")).toContainText("Select an editor tab")
  await page.getByRole("tabpanel").getByRole("button", { name: /objectives\.optim/ }).click()
  const editor = page.getByRole("textbox", { name: "Edit objectives.optim", exact: true })
  for (const content of ["", " \n\t ", '{"bad":"\0"}', `"${"\u00e9".repeat(512 * 1024)}"`]) {
    await editor.fill(content)
    await button.click()
    await expect(page.getByRole("alert")).toContainText("nonempty, without NUL bytes, and at most 1 MiB")
    await expect(button).toBeEnabled()
  }
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
    await page.route("**/api/performance/runs/optimizer", (route) => route.fulfill({ json: completed }))
    await configurePerformance(page, "my-project", true)
    await page.getByRole("button", { name: "Run Gemma RL (built)", exact: true }).click()
    await expect(page.getByLabel("Run output")).toHaveText(completed.output)
    await expect(editor).toHaveValue(content)
    await expect(page.locator(".editor-pane .badge")).toHaveText("Unsaved")
    await expect(page.getByRole("tabpanel").getByRole("button", { name: new RegExp(name.replaceAll(".", "\\.")) })).toHaveCount(0)
    expect(writes).toEqual([{ path: "/api/performance", method: "POST", body: { project: "my-project", spec: { name, content } } }])
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
  await page.getByRole("button", { name: "Run Gemma RL (built)", exact: true }).click()
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
  await expect(editor).toHaveValue(` ${pipelineConfig}`)
  await expect(page.locator(".editor-pane .badge")).toHaveText("Unsaved")
  expect(confirmations).toBe(1)
  expect(writes).toEqual([])
})

test("Performance preserves independent file logs and unsaved tabs", async ({ page }) => {
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
  await page.route("**/api/performance", async (route) => { await held; await route.fulfill({ json: { id: running.id } }) })
  let finish = false
  await page.route("**/api/performance/runs/optimizer", (route) => route.fulfill({ json: finish ? completed : running }))
  await page.getByRole("button", { name: "Run Gemma RL (built)", exact: true }).click()
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled()
  await expect(page.getByRole("button", { name: "Save & run" })).toBeEnabled()
  await expect(page.getByRole("button", { name: "Save repo changes" })).toBeEnabled()
  await expect(page.getByRole("button", { name: "Use recommended & continue" })).toBeEnabled()
  await objectives.fill("Edited while submitting")
  // Pause focused-window autosave to isolate the pipeline's write behavior.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")))
  release()
  await expect(page.getByLabel("Run output")).toHaveText(running.output)
  await expect(objectives).toHaveValue("Edited while submitting")
  await expect(page.locator(".editor-pane .badge")).toHaveText("Unsaved")
  await page.getByRole("button", { name: "Current file: objectives.optim", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText(fileOutput.output)
  await expect(page.getByRole("button", { name: "Save & run" })).toBeEnabled()
  await expect(page.getByRole("button", { name: "Use recommended & continue" })).toBeEnabled()
  await page.getByRole("tabpanel").getByRole("button", { name: /second\.md/ }).click()
  await page.getByRole("textbox", { name: "Edit second.md" }).fill("Unsaved second tab")
  finish = true
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Performance output", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await expect(page.getByRole("textbox", { name: "Edit second.md" })).toHaveValue("Unsaved second tab")
  await page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button", { name: /^optimization/ }).click()
  await expect(editor).toHaveValue("Unsaved optimization file")
  await page.getByRole("button", { name: "Current file: optimization", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText(fileOutput.output)
  await page.getByRole("button", { name: "Performance output", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button", { name: /^objectives\.optim/ }).click()
  await expect(objectives).toHaveValue("Edited while submitting")
  await expect(page.locator(".editor-pane .badge")).toHaveText("Unsaved")
  await objectives.fill(pipelineConfig)
  await expect(page.locator(".editor-pane .badge")).toHaveText("Saved")
  expect(writes).toEqual([{ path: "/api/performance", method: "POST", body: { project: "my-project", spec: { name: "objectives.optim", content } } }])
  expect(errors).toEqual([])
})

test("Stop run cancels Performance through its own endpoint and polls final status", async ({ page }) => {
  const { writes } = await workspace(page, { latest: running })
  let cancelled = false
  await page.route("**/api/performance/runs/optimizer/cancel", (route) => {
    cancelled = true
    return route.fulfill({ json: {} })
  })
  await page.route("**/api/performance/runs/optimizer", (route) => route.fulfill({ json: cancelled ? { ...completed, status: "cancelled", output: "Stopped manually" } : running }))
  await page.getByRole("button", { name: "Stop run", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText("Stopped manually")
  await expect(page.locator(".output-pane .badge")).toHaveText("cancelled")
  await expect(page.getByRole("button", { name: "Stop run", exact: true })).toBeHidden()
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
  expect(writes).toEqual([{ path: "/api/performance/runs/optimizer/cancel", method: "POST", body: {} }])
})

test("submission errors retain previous logs and allow retry", async ({ page }) => {
  const { writes } = await workspace(page, { latest: completed })
  await page.getByRole("tabpanel").getByRole("button", { name: /objectives\.optim/ }).click()
  await page.getByRole("button", { name: "Performance output", exact: true }).click()
  await configurePerformance(page)
  await page.route("**/api/performance", (route) => route.fulfill({ status: 409, json: { error: "Gemma RL build is unavailable" } }))
  await page.getByRole("button", { name: "Run Gemma RL (built)", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Gemma RL build is unavailable")
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
  await page.route("**/api/performance", (route) => route.fulfill({ json: { id: running.id } }))
  await page.route("**/api/performance/runs/optimizer", (route) => route.fulfill({ json: running }))
  await expect(page.getByRole("textbox", { name: "Project folder", exact: true })).toHaveValue("my-project")
  await page.getByRole("button", { name: "Run Gemma RL (built)", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText(running.output)
  await expect(page.getByRole("alert")).toBeHidden()
  expect(writes).toHaveLength(2)
})

test("poll and cancellation errors leave the optimizer recoverable", async ({ page }) => {
  await workspace(page, { latest: running })
  let polls = 0
  await page.route("**/api/performance/runs/optimizer", (route) => ++polls === 1
    ? route.fulfill({ status: 503, json: { error: "Temporary poll failure" } })
    : route.fulfill({ json: { ...running, output: "Polling recovered" } }))
  await expect(page.getByRole("alert")).toContainText("Temporary poll failure")
  await expect(page.getByLabel("Run output")).toHaveText(running.output)
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
  await configurePerformance(page)
  await expect(page.getByRole("button", { name: "Run Gemma RL (built)", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Performance", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText("Polling recovered")
  await page.route("**/api/performance/runs/optimizer/cancel", (route) => route.fulfill({ status: 500, json: { error: "Cancellation unavailable" } }))
  await page.getByRole("button", { name: "Stop run" }).click()
  await expect(page.getByRole("alert")).toContainText("Cancellation unavailable")
  await expect(page.getByRole("button", { name: "Stop run" })).toBeEnabled()
})

test("reload restores the latest optimizer and resumes polling without opening a file", async ({ page }) => {
  const { writes } = await workspace(page, { latest: running })
  await page.getByRole("button", { name: "Current file output" }).click()
  await page.reload()
  await expect(page.getByRole("button", { name: "Performance output", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByLabel("Run output")).toHaveText(running.output)
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
  await configurePerformance(page)
  await expect(page.getByRole("button", { name: "Run Gemma RL (built)", exact: true })).toBeDisabled()
  await page.route("**/api/performance/runs/optimizer", (route) => route.fulfill({ json: completed }))
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await expect(page.getByRole("button", { name: "Run Gemma RL (built)", exact: true })).toBeEnabled()
  await expect(page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button")).toHaveCount(0)
  expect(writes).toEqual([])
})

for (const recoveryError of [404, 503]) {
  test(`optimization recovery HTTP ${recoveryError} does not prevent connecting`, async ({ page }) => {
    await workspace(page, { recoveryError })
    await expect(page.getByRole("alert")).toContainText("Could not recover Performance output")
    await page.getByRole("tabpanel").getByRole("button", { name: /optimization/ }).click()
    await expect(page.getByRole("textbox", { name: "Edit optimization", exact: true })).toHaveValue("Saved optimization")
  })
}

test("failed initial recovery can be retried to restore polling and cancellation", async ({ page }) => {
  const { writes } = await workspace(page, { recoveryError: 503 })
  await expect(page.getByRole("alert")).toContainText("Select Recover latest Performance to retry")
  await page.route("**/api/performance", (route) => route.fulfill({ json: running }))
  await page.getByRole("button", { name: "Performance output", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText(running.output)
  await expect(page.getByRole("alert")).toBeHidden()
  await expect(page.getByRole("button", { name: "Stop run", exact: true })).toBeEnabled()
  await expect(page.getByRole("button", { name: "Performance", exact: true })).toBeEnabled()
  await configurePerformance(page)
  await expect(page.getByRole("button", { name: "Run Gemma RL (built)", exact: true })).toBeDisabled()
  expect(writes).toEqual([])
})

test("Performance opens with remote execution instructions but cannot submit when execution is off", async ({ page }) => {
  const { writes, dialogs } = await workspace(page, { execution: false, latest: completed })
  const button = page.getByRole("button", { name: "Performance", exact: true })
  await expect(button).toBeEnabled()
  await button.click()
  const form = page.getByRole("form", { name: "Performance builder" })
  await expect(form).toBeVisible()
  const availability = form.locator("#performance-availability")
  await expect(availability).toContainText(/remote execution.*disabled/i)
  await expect(availability).toContainText("SPEC_SSH_TARGET")
  await expect(availability).toContainText("SPEC_SSH_WORKSPACE")
  const submit = form.getByRole("button", { name: "Run Gemma RL (built)", exact: true })
  await expect(submit).toBeDisabled()
  await expect(form.getByRole("button", { name: "Inspect active runs", exact: true })).toHaveCount(0)
  await submit.evaluate((element: HTMLButtonElement) => element.click())
  await form.evaluate((element: HTMLFormElement) => element.requestSubmit())
  await page.getByRole("button", { name: "Performance output", exact: true }).click()
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  expect(dialogs).toEqual([])
  expect(writes).toEqual([])
})

for (const status of ["running", "unknown", "unavailable: missing remote run", "failed (exit 255)"]) {
test(`Performance launches despite a ${status} spec run and a failed spec listing`, async ({ page }) => {
  const { writes, dialogs, reads } = await workspace(page, { fileRun: { ...fileOutput, status, recoverable: true } })
  await page.route("**/api/runs", (route) => route.fulfill({ status: 503, json: { error: "Spec lifecycle unavailable" } }))
  await page.getByRole("tabpanel").getByRole("button", { name: /optimization/ }).click()
  const button = page.getByRole("button", { name: "Performance", exact: true })
  await expect(button).toBeEnabled()
  await configurePerformance(page)
  const submit = page.getByRole("button", { name: "Run Gemma RL (built)", exact: true })
  await expect(submit).toBeEnabled()
  await button.click()
  await page.getByRole("button", { name: "Close optimization", exact: true }).click()
  await expect(button).toBeEnabled()
  await button.click()
  await expect(submit).toBeEnabled()
  await expect(page.getByRole("list", { name: "Performance blockers", exact: true })).toHaveCount(0)
  await submit.click()
  await expect(page.getByLabel("Run output", { exact: true })).toHaveText(running.output)
  expect(writes).toEqual([{ path: "/api/performance", method: "POST", body: { project: "my-project", spec: null } }])
  expect(dialogs).toHaveLength(1)
  expect(reads).not.toContain("/api/runs")
  expect(reads).not.toContain("/api/optimize")
  expect(reads).not.toContain("/api/runs/optimizer")
})
}

test("Performance launches during a held autosave without releasing the spec saving guard", async ({ page }) => {
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
  const form = page.getByRole("form", { name: "Performance builder", exact: true })
  await expect(form).toBeVisible()
  await expect(form.locator("#performance-availability")).toContainText("Ready to run Gemma RL")
  const submit = form.getByRole("button", { name: "Run Gemma RL (built)", exact: true })
  await expect(submit).toBeEnabled()
  expect(writes).toEqual([{ path: "/api/files/second.md", method: "PUT", body: { content: "Autosaved draft", revision: "revision-1" } }])
  await submit.click()
  await expect(page.getByLabel("Run output")).toHaveText(running.output)
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  expect(dialogs).toHaveLength(1)
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual({ path: "/api/performance", method: "POST", body: { project: "my-project", spec: null } })
  release()
  await expect(page.locator(".editor-pane .badge")).toHaveText("Saved")
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled()
})

test("Performance header is disabled only in settings and otherwise exposes nonlaunching inspection", async ({ page }) => {
  const { writes, dialogs } = await workspace(page)
  await page.route("**/api/performance/runs", (route) => route.fulfill({ json: [] }))
  await configurePerformance(page)
  const form = page.getByRole("form", { name: "Performance builder", exact: true })
  const inspect = form.getByRole("button", { name: "Refresh Performance runs", exact: true })
  await expect(inspect).toHaveAttribute("type", "button")
  await inspect.click()
  await expect(page.getByRole("region", { name: "Active runs", exact: true })).toHaveCount(0)
  await expect(form.getByRole("button", { name: "Run Gemma RL (built)", exact: true })).toBeEnabled()
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
    for (const name of ["Performance", "Performance output", "Stop run"]) {
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

for (const target of ["Performance", "spec"]) {
  test(`stopping ${target} leaves the other lifecycle and queued spec feedback alone`, async ({ page }) => {
    const spec = { ...fileOutput, name: "optimization", status: "running", recoverable: true }
    const { writes, reads } = await workspace(page, { latest: running, fileRun: spec })
    await page.getByRole("tabpanel").getByRole("button", { name: /optimization/ }).click()
    await page.getByRole("button", { name: "Current file: optimization", exact: true }).click()
    await page.getByLabel("Feedback to build session").fill("Keep this follow-up")
    await page.getByRole("button", { name: "Queue follow-up", exact: true }).click()
    let stopped = false
    const prefix = target === "Performance" ? "/api/performance/runs/optimizer" : "/api/runs/file-run"
    await page.route(`**${prefix}/cancel`, (route) => { stopped = true; return route.fulfill({ json: {} }) })
    await page.route(`**${prefix}`, (route) => route.fulfill({ json: stopped
      ? { ...(target === "Performance" ? completed : spec), recoverable: false, status: "cancelled", output: `${target} cancelled` }
      : target === "Performance" ? running : spec }))
    if (target === "Performance") await page.getByRole("button", { name: "Performance output", exact: true }).click()
    await page.getByRole("button", { name: "Stop run", exact: true }).click()
    await expect(page.getByLabel("Run output", { exact: true })).toHaveText(`${target} cancelled`)
    await page.getByRole("button", { name: target === "Performance" ? "Current file: optimization" : "Performance output", exact: true }).click()
    await expect(page.getByLabel("Run output", { exact: true })).toHaveText(target === "Performance" ? spec.output : running.output)
    await expect(page.getByRole("button", { name: "Stop run", exact: true })).toBeEnabled()
    const queued = page.getByRole("region", { name: "Queued follow-ups" })
    await expect(queued).toContainText("Keep this follow-up")
    if (target === "Performance") await expect(queued).not.toContainText("Stop requested")
    else await expect(queued).toContainText("Stop requested")
    expect(writes).toEqual([{ path: `${prefix}/cancel`, method: "POST", body: {} }])
    expect(reads).toContain("/api/performance/runs/optimizer")
    expect(reads).toContain("/api/runs/file-run")
  })
}

test("spec launch and stop work while Performance submission is held, without unlocking a duplicate Performance request", async ({ page }) => {
  const { writes } = await workspace(page)
  await page.getByRole("tabpanel").getByRole("button", { name: /second\.md/ }).click()
  await configurePerformance(page)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/performance", async (route) => { await held; await route.fulfill({ json: { id: running.id } }) })
  await page.getByRole("button", { name: "Run Gemma RL (built)", exact: true }).click()
  await expect.poll(() => writes.length).toBe(1)
  await page.route("**/api/files/second.md", (route) => route.fulfill({ json: { name: "second.md", content: "Saved second.md", revision: "revision-2" } }))
  await page.route("**/api/runs", (route) => route.fulfill({ json: { id: "spec-new" } }))
  const spec = { ...fileOutput, id: "spec-new", name: "second.md", status: "running", recoverable: true }
  await page.route("**/api/runs/spec-new", (route) => route.fulfill({ json: spec }))
  await page.route("**/api/runs/spec-new/cancel", (route) => route.fulfill({ json: {} }))
  await page.getByRole("button", { name: "Save & run" }).click()
  await expect(page.getByRole("button", { name: "Stop run", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Stop run", exact: true }).click()
  await expect(page.getByRole("button", { name: "Run Gemma RL (built)", exact: true })).toBeDisabled()
  await page.getByRole("form", { name: "Performance builder" }).evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit() })
  expect(writes.map((write) => `${write.method} ${write.path}`)).toEqual([
    "POST /api/performance", "PUT /api/files/second.md", "POST /api/runs", "POST /api/runs/spec-new/cancel",
  ])
  release()
  await expect(page.getByLabel("Run output", { exact: true })).toHaveText(running.output)
})

test("Performance blockers come only from its own list and unresolved output, not the spec inspector", async ({ page }) => {
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  const { writes, reads } = await workspace(page, { latest: completed })
  const other = { ...running, id: "older-performance", status: "unknown", output: "Earlier Gemma session" }
  await page.route("**/api/performance/runs", (route) => route.fulfill({ json: [other] }))
  await page.route("**/api/performance/runs/older-performance", (route) => route.fulfill({ json: other }))
  await page.route("**/api/runs", (route) => route.fulfill({ json: [{ ...fileOutput, status: "unknown", kind: "build" }] }))
  await configurePerformance(page)
  await page.getByRole("button", { name: "Refresh Performance runs", exact: true }).click()
  const blockers = page.getByRole("list", { name: "Performance blockers", exact: true })
  await expect(blockers).toContainText(other.id)
  await expect(blockers).not.toContainText(fileOutput.id)
  const submit = page.getByRole("button", { name: "Run Gemma RL (built)", exact: true })
  await expect(submit).toBeDisabled()
  await page.getByRole("button", { name: "Active runs", exact: true }).click()
  const inspector = page.getByRole("region", { name: "Active runs", exact: true })
  await expect(inspector).toContainText(fileOutput.id)
  await expect(inspector).not.toContainText(other.id)
  await page.getByRole("button", { name: "Close active runs", exact: true }).click()
  await page.getByRole("button", { name: `Load Performance output for ${other.id}`, exact: true }).click()
  await expect(page.getByLabel("Run output", { exact: true })).toHaveText(other.output)
  await page.route("**/api/performance/runs", (route) => route.fulfill({ json: [] }))
  await page.route("**/api/performance/runs/older-performance", (route) => route.fulfill({ status: 503, json: { error: "Performance status unavailable" } }))
  await page.getByRole("button", { name: "Refresh Performance runs", exact: true }).click()
  await page.clock.runFor(2500)
  await expect(submit).toBeDisabled()
  await expect(blockers).toContainText(other.id)
  await expect(page.getByLabel("Run output", { exact: true })).toHaveText(other.output)
  await page.route("**/api/performance/runs/older-performance", (route) => route.fulfill({ json: { ...other, status: "completed", recoverable: false } }))
  await page.clock.runFor(2500)
  await expect(submit).toBeEnabled()
  expect(writes).toEqual([])
  expect(reads).not.toContain("/api/runs/older-performance")
})

test("unresolved ref_web stays in spec Active runs while Performance launches and blocks only its own duplicates", async ({ page }) => {
  const { writes, dialogs, reads, errors } = await workspace(page)
  const spec = { ...fileOutput, id: "ref-web-run", name: "ref_web", status: "unavailable: remote run directory missing", recoverable: true, kind: "build" }
  const legacy = { ...spec, id: "legacy-optimization", name: "optimization", kind: "optimization", status: "unknown" }
  await page.route("**/api/runs", (route) => route.fulfill({ json: [spec, legacy] }))
  await page.route("**/api/runs/ref-web-run", (route) => route.fulfill({ json: spec }))
  await page.getByRole("button", { name: "Active runs", exact: true }).click()
  const inspector = page.getByRole("region", { name: "Active runs", exact: true })
  await inspector.getByRole("button", { name: /Load output.*ref-web-run/ }).click()
  await expect(inspector).toContainText("still blocks the repository")
  await configurePerformance(page)
  const form = page.getByRole("form", { name: "Performance builder", exact: true })
  const submit = form.getByRole("button", { name: "Run Gemma RL (built)", exact: true })
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(page.getByLabel("Run output", { exact: true })).toHaveText(running.output)
  await page.getByRole("button", { name: "Performance", exact: true }).click()
  await expect(submit).toBeDisabled()
  await form.evaluate((element: HTMLFormElement) => { element.requestSubmit(); element.requestSubmit() })
  await expect(form.getByRole("list", { name: "Performance blockers", exact: true })).toContainText(running.id)
  await expect(form).not.toContainText(spec.id)
  await expect(inspector.getByRole("listitem")).toHaveCount(2)
  await expect(inspector).toContainText("ref_web")
  await expect(inspector).toContainText(legacy.id)
  await expect(inspector).not.toContainText(running.id)
  await expect(inspector.getByLabel("Active run output", { exact: true })).toHaveText(spec.output)
  await expect(inspector).toContainText("still blocks the repository")
  expect(writes).toEqual([{ path: "/api/performance", method: "POST", body: { project: "my-project", spec: null } }])
  expect(dialogs).toHaveLength(1)
  expect(reads).not.toContain("/api/optimize")
  expect(reads).not.toContain(`/api/runs/${running.id}`)
  expect(errors).toEqual([])
})

test("recovering Performance output preserves an unrelated spec save error and draft", async ({ page }) => {
  const { writes } = await workspace(page)
  await page.getByRole("tabpanel").getByRole("button", { name: /second\.md/ }).click()
  await page.evaluate(() => window.dispatchEvent(new Event("blur")))
  const editor = page.getByRole("textbox", { name: "Edit second.md", exact: true })
  await editor.fill("Keep this unsaved draft")
  await page.route("**/api/files/second.md", (route) => route.fulfill({ status: 409, json: { error: "Spec changed on disk" } }))
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Spec changed on disk")
  await page.getByRole("button", { name: "Performance output", exact: true }).click()
  await expect(page.getByLabel("Run output", { exact: true })).toContainText("No Performance output loaded")
  await expect(page.getByRole("alert")).toContainText("Spec changed on disk")
  await expect(editor).toHaveValue("Keep this unsaved draft")
  await expect(page.locator(".editor-pane .badge")).toHaveText("Unsaved")
  expect(writes).toEqual([{ path: "/api/files/second.md", method: "PUT", body: { content: "Keep this unsaved draft", revision: "revision-1" } }])
})

test("fresh Performance admission rejects a newly discovered own run without consulting spec runs", async ({ page }) => {
  const { writes, reads } = await workspace(page)
  await configurePerformance(page)
  await page.route("**/api/performance/runs", (route) => route.fulfill({ json: [running] }))
  await page.getByRole("button", { name: "Run Gemma RL (built)", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("blocked by its own active or unresolved sessions")
  await expect(page.getByRole("list", { name: "Performance blockers", exact: true })).toContainText(running.id)
  expect(writes).toEqual([])
  expect(reads).not.toContain("/api/runs")
})

test("Performance status failures block only Performance and can be refreshed without launching", async ({ page }) => {
  const { writes } = await workspace(page)
  await page.getByRole("tabpanel").getByRole("button", { name: /second\.md/ }).click()
  await configurePerformance(page)
  await page.route("**/api/performance/runs", (route) => route.fulfill({ status: 503, json: { error: "Builder status unavailable" } }))
  await page.getByRole("button", { name: "Refresh Performance runs", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Builder status unavailable")
  await expect(page.getByRole("button", { name: "Run Gemma RL (built)", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Save & run" })).toBeEnabled()
  await expect(page.getByRole("button", { name: "Use recommended & continue" })).toBeEnabled()
  await page.route("**/api/performance/runs", (route) => route.fulfill({ json: [] }))
  await page.getByRole("button", { name: "Refresh Performance runs", exact: true }).click()
  await expect(page.getByRole("button", { name: "Run Gemma RL (built)", exact: true })).toBeEnabled()
  await expect(page.getByRole("alert")).toHaveCount(0)
  expect(writes).toEqual([])
})

test("spec continuation remains available while an independent Performance session is running", async ({ page }) => {
  const { writes } = await workspace(page, { latest: running })
  await page.getByRole("tabpanel").getByRole("button", { name: /second\.md/ }).click()
  await page.getByRole("button", { name: "Current file: second.md", exact: true }).click()
  await page.route("**/api/runs/file-run/continue", (route) => route.fulfill({ json: { id: "spec-child" } }))
  await page.route("**/api/runs/spec-child", (route) => route.fulfill({ json: { ...fileOutput, id: "spec-child", name: "second.md", output: "Spec continued independently" } }))
  await page.getByRole("button", { name: "Use recommended & continue" }).click()
  await expect(page.getByLabel("Run output", { exact: true })).toHaveText("Spec continued independently")
  await page.getByRole("button", { name: "Performance output", exact: true }).click()
  await expect(page.getByLabel("Run output", { exact: true })).toHaveText(running.output)
  expect(writes).toEqual([{ path: "/api/runs/file-run/continue", method: "POST", body: {} }])
})

test("a late latest-recovery response cannot replace a newly submitted Performance session", async ({ page }) => {
  const { writes } = await workspace(page)
  await configurePerformance(page)
  await expect(page.getByRole("button", { name: "Run Gemma RL (built)", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let reading = false
  await page.route("**/api/performance", async (route) => {
    if (route.request().method() === "POST") return route.fulfill({ json: { id: running.id } })
    reading = true
    await held
    await route.fulfill({ json: { ...completed, id: "obsolete", output: "Obsolete recovery" } })
  })
  await page.getByRole("button", { name: "Performance output", exact: true }).click()
  await expect.poll(() => reading).toBe(true)
  await configurePerformance(page)
  await page.getByRole("button", { name: "Run Gemma RL (built)", exact: true }).click()
  await expect(page.getByLabel("Run output", { exact: true })).toHaveText(running.output)
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/performance" && response.request().method() === "GET")
  release()
  await response
  await expect(page.getByLabel("Run output", { exact: true })).toHaveText(running.output)
  expect(writes).toHaveLength(1)
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
    await expect(page.getByRole("form", { name: "Performance builder" }).getByRole("status")).toContainText("Search root: /remote/workspace")
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
    await page.getByRole("button", { name: "Run Gemma RL (built)", exact: true }).click()
    await expect(page.getByLabel("Run output")).toHaveText(running.output)
    expect(writes[1]).toEqual({ path: "/api/performance", method: "POST", body: { project: projectMatches.projects[1].path, spec: null } })
    expect(auth.every((value) => value === `Bearer ${new URL(url).hash.slice(7)}`)).toBe(true)
    expect(errors).toEqual([])
  })
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 600 }, { width: 390, height: 640 }]) {
test(`Explore prevents duplicate searches and pipeline submission without blocking editing or local save at ${viewport.width}x${viewport.height}`, async ({ page }) => {
  await page.setViewportSize(viewport)
  const { writes, dialogs } = await workspace(page)
  await page.getByRole("tabpanel").getByRole("button", { name: /second\.md/ }).click()
  await configurePerformance(page)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/projects/search", async (route) => { await held; await route.fulfill({ json: projectMatches }) })
  const search = page.getByRole("button", { name: "Search with Explore", exact: true })
  await search.evaluate((element: HTMLButtonElement) => { element.click(); element.click() })
  await expect(search).toBeDisabled()
  await expect(page.getByRole("form", { name: "Performance builder" }).getByRole("status")).toContainText("This can take up to a minute")
  await expect(page.getByRole("form", { name: "Performance builder" })).toContainText("Remote project safety checks still apply")
  await expect(page.getByRole("button", { name: "Run Gemma RL (built)", exact: true })).toBeDisabled()
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
  await expect(page.getByRole("button", { name: "Run Gemma RL (built)", exact: true })).toBeEnabled()
  await expect(page.locator("#performance-availability").filter({ hasText: "Wait for project search to finish" })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
}

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
  await page.getByRole("button", { name: "Run Gemma RL (built)", exact: true }).click()
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
  await expect(page.getByRole("form", { name: "Performance builder" }).getByRole("status")).toContainText("No matching projects")
  await expect(page.getByRole("combobox", { name: "Matching projects", exact: true })).toBeHidden()
  await search.click()
  await expect(page.getByRole("alert")).toContainText("Explore unavailable")
  await expect(search).toBeEnabled()
  await search.click()
  await expect(page.getByRole("alert")).toBeHidden()
  await expect(page.getByRole("form", { name: "Performance builder" }).getByRole("status")).toContainText(root)
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
    await expect(page.getByRole("form", { name: "Performance builder" }).getByRole("status")).toContainText(projectMatches.root)
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
    await expect(page.getByRole("button", { name: "Run Gemma RL (built)", exact: true })).toBeEnabled()
    expect(await page.evaluate(() => window.projectSearchRequests.length)).toBe(4)
    expect(writes).toEqual([])
    expect(dialogs).toEqual([])
    expect(errors).toEqual([])
  })
}
