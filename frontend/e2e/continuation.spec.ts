import { test, expect } from "@playwright/test"
import type { Page } from "@playwright/test"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Output } from "../src/tabs"

let server: ChildProcess
let directory: string
let url: string

// Use the existing local-server fixture pattern; all API traffic is mocked.
test.beforeAll(async () => {
  directory = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "spec-continuation-e2e-"))
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

const completed = { id: "prior-harness", name: "first.md", status: "completed", output: "Original logs: use the recommended option?", truncated: false, recoverable: false, continuable: true }
const second = { ...completed, id: "other-harness", name: "second.md", output: "Independent second-file logs" }
const buttonName = "Use recommended & continue"

async function workspace(page: Page, output: (Output & { continuable?: boolean }) | null = completed, execution = true) {
  const writes: { path: string; method: string; body: unknown }[] = []
  const dialogs: string[] = []
  const errors: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("/api/") && request.method() !== "GET") writes.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postDataJSON() })
  })
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss() })
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    if (request.method() !== "GET") return route.fulfill({ status: 500, json: { error: "Unexpected write" } })
    if (pathname === "/api/config") return route.fulfill({ json: { execution, completion: false, chat: false, realtime: false, azureRealtime: false } })
    if (pathname === "/api/files") return route.fulfill({ json: ["first.md", "second.md"].map((name) => ({ name, modified: 0, bytes: 10 })) })
    if (pathname === "/api/repository") return route.fulfill({ json: { connected: true, dirty: true, directory: "/fixture", model: "fixture-model" } })
    for (const name of ["first.md", "second.md"]) {
      if (pathname === `/api/files/${name}`) return route.fulfill({ json: { name, content: `Saved ${name}`, revision: "revision-1" } })
      if (pathname === `/api/files/${name}/run` || pathname === `/api/files/${name}/run/log`) return route.fulfill({ json: name === "first.md" ? output : second })
    }
    if (pathname === `/api/runs/${output?.id}`) return route.fulfill({ json: output })
    return route.fulfill({ status: 404, json: { error: `Unexpected request: ${pathname}` } })
  })
  await page.goto(url)
  await page.getByRole("tabpanel").getByRole("button", { name: /first\.md/ }).click()
  await expect(page.getByRole("textbox", { name: "Edit first.md" })).toHaveValue("Saved first.md")
  if (output) await expect(page.getByLabel("Run output")).toHaveText(output.output)
  return { writes, dialogs, errors }
}

for (const scenario of [
  { name: "active", output: { ...completed, status: "running", recoverable: true } },
  { name: "failed", output: { ...completed, status: "failed (exit status: 7)" } },
  { name: "unconfirmed completion", output: { ...completed, recoverable: true } },
  { name: "repository save", output: { ...completed, continuable: false } },
  { name: "absent continuable flag", output: { ...completed, continuable: undefined } },
  { name: "execution disabled", output: completed, execution: false },
]) {
  test(`continuation stays visible but disabled: ${scenario.name}`, async ({ page }) => {
    const { writes } = await workspace(page, scenario.output, scenario.execution)
    const button = page.getByRole("button", { name: buttonName })
    await expect(button).toBeVisible()
    await expect(button).toBeDisabled()
    const send = page.getByRole("button", { name: "Send & continue" })
    if (scenario.output.continuable === true) await expect(send).toBeDisabled()
    else await expect(send).toBeHidden()
    expect(writes).toEqual([])
  })
}

test("continuation is hidden without output", async ({ page }) => {
  await workspace(page, null)
  await expect(page.getByRole("button", { name: buttonName })).toBeHidden()
})

test("continuation submits only the prior ID, locks competing writes, and polls without touching unsaved edits", async ({ page }) => {
  const { writes, dialogs, errors } = await workspace(page)
  const editor = page.getByRole("textbox", { name: "Edit first.md" })
  await editor.fill("Unsaved buffer, never upload this")
  await page.getByLabel("Follow output").uncheck()
  const button = page.getByRole("button", { name: buttonName })
  await expect(button).toBeEnabled()
  await expect(button).toHaveAttribute("title", /same build session.*automatic tool approval.*provider costs.*Does not save or upload/)
  await expect(page.getByRole("button", { name: "Save repo changes" })).toBeEnabled()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/runs/prior-harness/continue", async (route) => {
    await held
    await route.fulfill({ json: { id: "continued-harness" } })
  })
  let releasePoll!: () => void
  const heldPoll = new Promise<void>((resolve) => { releasePoll = resolve })
  let polls = 0
  await page.route("**/api/runs/continued-harness", async (route) => {
    await heldPoll
    await route.fulfill({ json: { ...completed, id: "continued-harness", ...(++polls === 1 ? { status: "running", recoverable: true, output: "Continuing the original session" } : { output: "Recommendation completed" }) } })
  })
  // Same-tick clicks exercise the synchronous guard, not just disabled rendering.
  await button.evaluate((element: HTMLButtonElement) => { element.click(); element.click() })
  await expect(button).toBeDisabled()
  await expect(page.getByRole("status")).toContainText("Submitting recommendation for first.md")
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Save repo changes" })).toBeDisabled()
  await editor.press("Control+s")
  await editor.fill("Edited again while submitting")
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  const polled = page.waitForRequest("**/api/runs/continued-harness")
  release()
  await polled
  await expect(page.getByLabel("Run output")).toHaveText("Starting...")
  await expect(page.getByLabel("Follow output")).toBeChecked()
  await expect(button).toBeDisabled()
  releasePoll()
  await expect(page.getByLabel("Run output")).toHaveText("Continuing the original session")
  await expect(page.getByLabel("Run output")).toHaveText("Recommendation completed")
  await expect(button).toBeEnabled()
  await expect(editor).toHaveValue("Edited again while submitting")
  await expect(page.getByRole("region", { name: "Spec editing pane" }).getByText("Unsaved", { exact: true })).toBeVisible()
  await expect(page.getByRole("status")).toContainText("Recommended choice submitted to the same session for first.md")
  expect(writes).toEqual([{ path: "/api/runs/prior-harness/continue", method: "POST", body: {} }])
  expect(dialogs).toEqual([])
  expect(errors).toEqual([])
  expect(polls).toBe(2)
})

test("legacy metadata errors retain logs and edits and allow retry", async ({ page }) => {
  const { writes, dialogs } = await workspace(page)
  const editor = page.getByRole("textbox", { name: "Edit first.md" })
  await editor.fill("Unsaved legacy buffer")
  await page.getByLabel("Follow output").uncheck()
  await page.route("**/api/runs/prior-harness/continue", (route) => route.fulfill({ status: 409, json: { error: "Legacy build session metadata is missing; cannot continue the prior session." } }))
  const button = page.getByRole("button", { name: buttonName })
  await button.click()
  await expect(page.getByRole("alert")).toContainText("Legacy build session metadata is missing")
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await expect(editor).toHaveValue("Unsaved legacy buffer")
  await expect(page.getByLabel("Follow output")).not.toBeChecked()
  await expect(button).toBeEnabled()
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled()
  await expect(page.getByRole("button", { name: "Save & run" })).toBeEnabled()
  await expect(page.getByRole("button", { name: "Save repo changes" })).toBeEnabled()
  expect(writes).toEqual([{ path: "/api/runs/prior-harness/continue", method: "POST", body: {} }])
  expect(dialogs).toEqual([])
})

test("switching tabs during submission keeps the continuation attached to its original file", async ({ page }) => {
  const { writes, errors } = await workspace(page)
  await page.getByRole("textbox", { name: "Edit first.md" }).fill("Unsaved first tab")
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/runs/prior-harness/continue", async (route) => {
    await held
    await route.fulfill({ json: { id: "background-harness" } })
  })
  await page.route("**/api/runs/background-harness", (route) => route.fulfill({ json: { ...completed, id: "background-harness", output: "First tab continued in background" } }))
  await page.getByRole("button", { name: buttonName }).click()
  await page.getByRole("tabpanel").getByRole("button", { name: /second\.md/ }).click()
  await page.getByRole("textbox", { name: "Edit second.md" }).fill("Unsaved second tab")
  await expect(page.getByLabel("Run output")).toHaveText(second.output)
  await expect(page.getByRole("button", { name: buttonName })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
  const polled = page.waitForResponse("**/api/runs/background-harness")
  release()
  await polled
  await expect(page.getByRole("status")).toContainText("same session for first.md")
  await expect(page.getByLabel("Run output")).toHaveText(second.output)
  await expect(page.getByRole("textbox", { name: "Edit second.md" })).toHaveValue("Unsaved second tab")
  await page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button", { name: /^first\.md/ }).click()
  await expect(page.getByLabel("Run output")).toHaveText("First tab continued in background")
  await expect(page.getByRole("textbox", { name: "Edit first.md" })).toHaveValue("Unsaved first tab")
  expect(writes).toEqual([{ path: "/api/runs/prior-harness/continue", method: "POST", body: {} }])
  expect(errors).toEqual([])
})

test("output controls wrap without horizontal scrolling on mobile", async ({ page }) => {
  await workspace(page, { ...completed, status: "running", recoverable: true })
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    const button = page.getByRole("button", { name: buttonName })
    await button.scrollIntoViewIfNeeded()
    await expect(button).toBeVisible()
    await expect(page.getByRole("button", { name: "Stop run" })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const bounds = await button.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
    await feedback.scrollIntoViewIfNeeded()
    await expect(feedback).toBeVisible()
    const feedbackBounds = await feedback.boundingBox()
    expect(feedbackBounds!.x + feedbackBounds!.width).toBeLessThanOrEqual(width)
  }
})

test("feedback stays scoped to its run, locks duplicate submissions, and never saves editor changes", async ({ page }) => {
  const { writes, dialogs, errors } = await workspace(page)
  await page.getByRole("textbox", { name: "Edit first.md" }).fill("Unsaved spec")
  const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
  const send = page.getByRole("button", { name: "Send & continue" })
  await expect(send).toBeDisabled()
  const message = "  Use the smaller option.\nKeep the existing API.\n"
  await feedback.fill(message)
  await feedback.press("Control+Enter")
  expect(dialogs).toEqual([])
  expect(writes).toEqual([])
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/runs/prior-harness/continue", async (route) => {
    await held
    await route.fulfill({ json: { id: "feedback-harness" } })
  })
  await page.route("**/api/runs/feedback-harness", (route) => route.fulfill({ json: { ...completed, id: "feedback-harness", output: "Feedback applied" } }))
  await send.evaluate((element: HTMLButtonElement) => { element.click(); element.click() })
  await expect(send).toBeDisabled()
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await page.getByRole("tabpanel").getByRole("button", { name: /second\.md/ }).click()
  await expect(feedback).toHaveValue("")
  const polled = page.waitForResponse("**/api/runs/feedback-harness")
  release()
  await polled
  await expect(page.getByLabel("Run output")).toHaveText(second.output)
  await feedback.fill("Second session draft")
  await page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button", { name: /^first\.md/ }).click()
  await expect(page.getByLabel("Run output")).toHaveText("Feedback applied")
  await expect(feedback).toHaveValue("")
  await expect(page.getByRole("textbox", { name: "Edit first.md" })).toHaveValue("Unsaved spec")
  expect(writes).toEqual([{ path: "/api/runs/prior-harness/continue", method: "POST", body: { message } }])
  expect(errors).toEqual([])
})

test("feedback validation and failed requests retain the draft and original logs", async ({ page }) => {
  const { writes } = await workspace(page)
  const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
  const send = page.getByRole("button", { name: "Send & continue" })
  await feedback.fill(" \n ")
  await expect(send).toBeDisabled()
  await feedback.fill("a".repeat(16 * 1024 + 1))
  await expect(send).toBeDisabled()
  await feedback.fill("Please use option two")
  await page.route("**/api/runs/prior-harness/continue", (route) => route.fulfill({ status: 409, json: { error: "Missing session metadata" } }))
  await send.click()
  await expect(page.getByRole("alert")).toContainText("Missing session metadata")
  await expect(feedback).toHaveValue("Please use option two")
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await expect(send).toBeEnabled()
  expect(writes).toHaveLength(1)
})

test("Save & run hotkey shares confirmation and guards with the button", async ({ page }) => {
  const { writes, dialogs } = await workspace(page)
  const editor = page.getByRole("textbox", { name: "Edit first.md" })
  await editor.fill("Snapshot from shortcut")
  await editor.press("Control+Enter")
  expect(dialogs).toHaveLength(1)
  expect(writes).toEqual([])
  await editor.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, repeat: true, bubbles: true }))
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true, bubbles: true }))
  })
  await page.getByRole("textbox", { name: "Filter files" }).press("Control+Enter")
  expect(dialogs).toHaveLength(1)
  page.removeAllListeners("dialog")
  page.on("dialog", (dialog) => dialog.accept())
  await page.route("**/api/files/first.md", (route) => route.fulfill({ json: { name: "first.md", content: "Snapshot from shortcut", revision: "saved-shortcut" } }))
  await page.route("**/api/runs", (route) => route.fulfill({ json: { id: "shortcut-harness" } }))
  await page.route("**/api/runs/shortcut-harness", (route) => route.fulfill({ json: { ...completed, id: "shortcut-harness", status: "running", recoverable: true, output: "Running shortcut" } }))
  await editor.press("Meta+Enter")
  await expect(page.getByLabel("Run output")).toHaveText("Running shortcut")
  await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
  await editor.press("Control+Enter")
  expect(writes).toEqual([
    { path: "/api/files/first.md", method: "PUT", body: { content: "Snapshot from shortcut", revision: "revision-1" } },
    { path: "/api/runs", method: "POST", body: { name: "first.md", revision: "saved-shortcut" } },
  ])
})

test("syntax lines and log colors are display-only and safely render HTML as text", async ({ page }) => {
  await workspace(page)
  const source = "## Heading\n# Completed\n- Pending `code`\n```js\n# not completed\n```\n"
  await page.getByRole("textbox", { name: "Edit first.md" }).fill(source)
  const mirror = page.locator(".syntax-mirror")
  await expect(mirror).toHaveText(source)
  await expect(mirror.locator(".syntax-line")).toHaveCount(7)
  await expect(mirror.locator(".syntax-completed")).toHaveText("# Completed\n")
  await expect(mirror.locator(".syntax-line").last()).toHaveAttribute("data-line", "7")
  const logText = "\u001b[31mERROR <img src=x onerror=alert(1)>\u001b[0m\nWARNING retry\nSUCCESS done"
  await page.route("**/api/files/first.md/run/log", (route) => route.fulfill({ json: { ...completed, output: logText } }))
  await page.getByRole("button", { name: "Load nohup output" }).click()
  const output = page.getByLabel("Run output")
  await expect(output).toHaveText("ERROR <img src=x onerror=alert(1)>\nWARNING retry\nSUCCESS done")
  await expect(output.locator("img")).toHaveCount(0)
  await expect(output.locator(".log-error")).toContainText("ERROR")
  await expect(output.locator(".log-warning")).toContainText("WARNING")
  await expect(output.locator(".log-success")).toContainText("SUCCESS")
})

test("large files fall back to editable plain text without a huge syntax tree", async ({ page }) => {
  await workspace(page)
  const source = "a\n".repeat(6000)
  const editor = page.getByRole("textbox", { name: "Edit first.md" })
  // Avoid Chromium's slow native multiline insertion while exercising React's input path.
  await editor.evaluate((node: HTMLTextAreaElement, text) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(node, text)
    node.dispatchEvent(new Event("input", { bubbles: true }))
  }, source)
  await expect(editor).toHaveValue(source)
  await expect(page.getByText("Large file: plain-text display", { exact: false })).toBeVisible()
  await expect(page.locator(".syntax-line")).toHaveCount(0)
  expect(await editor.evaluate((node) => getComputedStyle(node).color)).not.toBe("rgba(0, 0, 0, 0)")
  await editor.fill("## Back to highlighting")
  await expect(page.locator(".syntax-heading")).toHaveText("## Back to highlighting")
})
