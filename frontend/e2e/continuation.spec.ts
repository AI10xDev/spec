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
const running = { ...completed, status: "running", recoverable: true }
const second = { ...completed, id: "other-harness", name: "second.md", output: "Independent second-file logs" }
const buttonName = "Use recommended & continue"
const savedBuild = { parent_id: running.id, name: "first.md", revision: "acknowledged-snapshot", status: "waiting" }

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
    if (pathname === "/api/performance") return route.fulfill({ json: null })
    if (pathname === "/api/performance/runs") return route.fulfill({ json: [] })
    if (pathname === "/api/queued-builds") return route.fulfill({ json: [] })
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

for (const width of [1440, 390]) {
  test(`standalone output keeps live feedback, recall and controls at ${width}px`, async ({ page }) => {
    const { writes, errors } = await workspace(page, running)
    let current = running
    await page.route("**/api/runs/prior-harness", (route) => route.fulfill({ json: current }))
    await page.route("**/api/runs/prior-harness/continue", (route) => route.fulfill({ json: { id: "window-child" } }))
    await page.route("**/api/runs/window-child", (route) => route.fulfill({ json: { ...completed, id: "window-child", output: "Follow-up finished in standalone window" } }))
    const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
    const message = "  Keep the exact draft.\nAnd this line."
    await feedback.fill(message)
    await page.getByLabel("Follow output").uncheck()
    const opened = page.waitForEvent("popup")
    await page.getByRole("button", { name: "Maximize output", exact: true }).click()
    const popup = await opened
    popup.on("pageerror", (error) => errors.push(error.message))
    await popup.setViewportSize({ width, height: 900 })
    await expect(popup).toHaveTitle("Output & logs | Spec")
    await expect(page.getByLabel("Run output")).toHaveCount(0)
    await expect(popup.getByLabel("Run output")).toHaveText(running.output)
    await expect(popup.getByRole("region", { name: "Spec editing pane" })).toHaveCount(0)
    await expect(popup.getByRole("button", { name: "Stop run", exact: true })).toBeVisible()
    await expect(popup.getByLabel("Follow output")).not.toBeChecked()
    const remoteFeedback = popup.getByRole("textbox", { name: "Feedback to build session" })
    await expect(remoteFeedback).toHaveValue(message)
    await expect(popup.locator(".output-window-content")).toHaveCSS("height", "900px")
    expect(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await remoteFeedback.press("Enter")
    await expect(popup.getByRole("region", { name: "Queued follow-ups" })).toContainText(message)
    expect(writes).toEqual([])
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    current = { ...completed, output: "Parent successfully finalized" }
    await expect(popup.getByLabel("Run output")).toHaveText(current.output)
    await expect(popup.getByRole("region", { name: "Queued follow-ups" })).toContainText("Delivery is paused")
    expect(writes).toEqual([])
    await page.getByRole("button", { name: "Back to workspace" }).click()
    await expect(popup.getByLabel("Run output")).toHaveText("Follow-up finished in standalone window")
    await remoteFeedback.press("ArrowUp")
    await expect(remoteFeedback).toHaveValue(message)
    await popup.getByRole("button", { name: "Feature review", exact: true }).click()
    await expect(page.getByRole("dialog", { name: "Feature review", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Close feature review" }).click()
    await expect(popup.getByRole("button", { name: "Feature review", exact: true })).toBeFocused()
    await popup.getByRole("button", { name: "Restore output", exact: true }).click().catch((error) => {
      // Restoring intentionally closes this page before the click can finish reporting.
      if (!popup.isClosed()) throw error
    })
    await expect.poll(() => popup.isClosed()).toBe(true)
    await expect(feedback).toHaveValue(message)
    await expect(page.getByLabel("Run output")).toHaveText("Follow-up finished in standalone window")
    await expect(page.getByRole("button", { name: "Maximize output", exact: true })).toBeFocused()
    expect(writes).toEqual([{ path: "/api/runs/prior-harness/continue", method: "POST", body: { message } }])
    expect(errors).toEqual([])
  })
}

test("closing or reloading standalone output restores the same draft and current file", async ({ page }) => {
  const { writes, errors } = await workspace(page)
  for (const reload of [false, true]) {
    const opened = page.waitForEvent("popup")
    await page.getByRole("button", { name: "Maximize output", exact: true }).click()
    const popup = await opened
    await expect(popup.getByRole("button", { name: "Restore output", exact: true })).toBeVisible()
    await page.getByRole("tabpanel").getByRole("button", { name: /second\.md/ }).click()
    await expect(popup.getByLabel("Run output")).toHaveText(second.output)
    await popup.getByRole("textbox", { name: "Feedback to build session" }).fill("Still an unsent draft")
    if (reload) {
      // The window contains a live portal, not another workspace; reload restores it to its owner.
      await popup.reload().catch(() => { /* Restoration can close the page during navigation. */ })
    } else await popup.close()
    await expect.poll(() => popup.isClosed()).toBe(true)
    await expect(page.getByRole("textbox", { name: "Feedback to build session" })).toHaveValue("Still an unsent draft")
    await expect(page.getByLabel("Run output")).toHaveText(second.output)
  }
  expect(writes).toEqual([])
  expect(errors).toEqual([])
})

test("blocked output popup leaves the inline panel and draft usable", async ({ page }) => {
  const { writes, errors } = await workspace(page)
  const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
  await feedback.fill("Do not lose this")
  await page.evaluate(() => { window.open = () => null })
  await page.getByRole("button", { name: "Maximize output", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Allow popups")
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await expect(feedback).toHaveValue("Do not lose this")
  expect(writes).toEqual([])
  expect(errors).toEqual([])
})

test("standalone errors retain drafts, parent restore works, and workspace reload closes the child", async ({ page }) => {
  const { writes, errors } = await workspace(page)
  await page.route("**/api/runs/prior-harness/continue", (route) => route.fulfill({ status: 409, json: { error: "Continuation unavailable" } }))
  const opened = page.waitForEvent("popup")
  await page.getByRole("button", { name: "Maximize output", exact: true }).click()
  const popup = await opened
  const feedback = popup.getByRole("textbox", { name: "Feedback to build session" })
  await feedback.fill("Keep after failure")
  await feedback.press("Enter")
  await expect(popup.getByRole("alert")).toContainText("Continuation unavailable")
  await expect(feedback).toHaveValue("Keep after failure")
  await page.getByRole("button", { name: "Restore output here", exact: true }).click()
  await expect.poll(() => popup.isClosed()).toBe(true)
  await expect(page.getByRole("textbox", { name: "Feedback to build session" })).toHaveValue("Keep after failure")
  const reopened = page.waitForEvent("popup")
  await page.getByRole("button", { name: "Maximize output", exact: true }).click()
  const child = await reopened
  await expect(child.getByLabel("Run output")).toHaveText(completed.output)
  await page.reload()
  await expect.poll(() => child.isClosed()).toBe(true)
  expect(writes).toEqual([{ path: "/api/runs/prior-harness/continue", method: "POST", body: { message: "Keep after failure" } }])
  expect(errors).toEqual([])
})

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
    const send = page.getByRole("button", { name: scenario.output.status === "running" ? "Queue follow-up" : "Send & continue" })
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
  // Isolate continuation writes while the focused-window autosave is paused.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")))
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
  await feedback.press("ArrowUp")
  await expect(feedback).toHaveValue(message)
  await page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button", { name: /^second\.md/ }).click()
  await expect(feedback).toHaveValue("Second session draft")
  await feedback.fill("")
  await feedback.press("ArrowUp")
  await expect(feedback).toHaveValue("")
  expect(writes).toEqual([{ path: "/api/runs/prior-harness/continue", method: "POST", body: { message } }])
  expect(errors).toEqual([])
})

test("autosaving the sheet does not interrupt typing a follow-up", async ({ page }) => {
  const { writes } = await workspace(page)
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/files/first.md", async (route) => {
    await held
    await route.fulfill({ json: { name: "first.md", content: "Autosaved spec", revision: "revision-2" } })
  })
  await page.route("**/api/runs/prior-harness/continue", (route) => route.fulfill({ json: { id: "after-autosave" } }))
  await page.route("**/api/runs/after-autosave", (route) => route.fulfill({ json: { ...completed, id: "after-autosave", output: "Follow-up applied" } }))
  await page.getByRole("textbox", { name: "Edit first.md" }).fill("Autosaved spec")
  const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
  await feedback.fill("Please ")
  await page.clock.runFor(500)
  try {
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
    await expect(feedback).toBeEnabled()
    await expect(feedback).toBeFocused()
    await page.keyboard.type("continue")
    await expect(feedback).toHaveValue("Please continue")
  } finally { release() }
  await expect(page.getByRole("button", { name: "Send & continue" })).toBeEnabled()
  await feedback.press("Enter")
  await expect(page.getByLabel("Run output")).toHaveText("Follow-up applied")
  expect(writes).toEqual([
    { path: "/api/files/first.md", method: "PUT", body: { content: "Autosaved spec", revision: "revision-1" } },
    { path: "/api/runs/prior-harness/continue", method: "POST", body: { message: "Please continue" } },
  ])
})

test("queued Enter guards duplicates, dispatches the original background run, and preserves an identical new draft on its child", async ({ page }) => {
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  const { writes, dialogs, errors } = await workspace(page, running)
  const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
  const queue = page.getByRole("region", { name: "Queued follow-ups" })
  const message = "  Apply the smaller change.\nKeep the API unchanged.\n"
  await feedback.fill(message)
  await expect(page.getByRole("button", { name: "Queue follow-up", exact: true })).toBeEnabled()
  await feedback.evaluate((element) => {
    for (let index = 0; index < 2; index++) element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }))
  })
  await expect(queue.locator("pre")).toHaveCount(1)
  await expect(queue.locator("pre")).toHaveJSProperty("textContent", message)
  await expect(feedback).toHaveValue("")
  // Recalling queued feedback creates a new draft without submitting it.
  await feedback.press("ArrowUp")
  await expect(feedback).toHaveValue(message)
  await feedback.press("Enter")
  await expect(feedback).toHaveValue(message)
  await expect(page.getByRole("button", { name: "Queue follow-up", exact: true })).toBeDisabled()
  await expect(queue.locator("pre")).toHaveJSProperty("textContent", message)
  expect(writes).toEqual([])

  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/runs/prior-harness/continue", async (route) => {
    await held
    await route.fulfill({ json: { id: "queued-child" } })
  })
  await page.route("**/api/runs/queued-child", (route) => route.fulfill({ json: { ...completed, id: "queued-child", output: "Background follow-up completed" } }))
  await page.route("**/api/runs/queued-child/continue", (route) => route.fulfill({ json: { id: "queued-grandchild" } }))
  await page.route("**/api/runs/queued-grandchild", (route) => route.fulfill({ json: { ...completed, id: "queued-grandchild", output: "Preserved draft applied" } }))
  await page.getByRole("tabpanel").getByRole("button", { name: /second\.md/ }).click()
  await expect(page.getByLabel("Run output")).toHaveText(second.output)
  await feedback.fill("Independent second-file draft")
  await page.route("**/api/runs/prior-harness", (route) => route.fulfill({ json: completed }))
  const submitted = page.waitForRequest("**/api/runs/prior-harness/continue")
  try {
    await page.clock.runFor(650)
    await submitted
    await expect(page.getByRole("status")).toContainText("Submitting feedback for first.md")
    await expect(page.getByLabel("Run output")).toHaveText(second.output)
    expect(writes).toEqual([{ path: "/api/runs/prior-harness/continue", method: "POST", body: { message } }])
  } finally { release() }
  await expect(page.getByRole("status")).toContainText("Feedback submitted to the same session for first.md")
  await expect(queue).toBeHidden()
  await expect(page.getByLabel("Run output")).toHaveText(second.output)
  await expect(feedback).toHaveValue("Independent second-file draft")
  await page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button", { name: /^first\.md/ }).click()
  await expect(page.getByLabel("Run output")).toHaveText("Background follow-up completed")
  await expect(feedback).toHaveValue(message)
  await feedback.press("Enter")
  await expect(page.getByLabel("Run output")).toHaveText("Preserved draft applied")
  expect(writes).toEqual([
    { path: "/api/runs/prior-harness/continue", method: "POST", body: { message } },
    { path: "/api/runs/queued-child/continue", method: "POST", body: { message } },
  ])
  expect(dialogs).toEqual([])
  expect(errors).toEqual([])
})

test("queued feedback waits through unavailable transport and recoverable completion until completion is confirmed", async ({ page }) => {
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  const { writes } = await workspace(page, running)
  const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
  const queue = page.getByRole("region", { name: "Queued follow-ups" })
  await feedback.fill("Send only after confirmation")
  await feedback.press("Enter")
  let current: Output | null = null
  await page.route("**/api/runs/prior-harness", (route) => current
    ? route.fulfill({ json: current })
    : route.fulfill({ status: 503, json: { error: "Status probe unavailable" } }))
  await page.route("**/api/runs/prior-harness/continue", (route) => route.fulfill({ json: { id: "confirmed-child" } }))
  await page.route("**/api/runs/confirmed-child", (route) => route.fulfill({ json: { ...completed, id: "confirmed-child", output: "Confirmed follow-up completed" } }))
  await page.clock.runFor(650)
  await expect(page.getByRole("alert")).toContainText("Status probe unavailable")
  await expect(page.getByRole("region", { name: "Output and logs pane" }).locator(".badge")).toHaveText("running (connection unavailable)")
  expect(writes).toEqual([])

  for (const state of [
    { ...running, status: "unavailable (remote disconnected)", output: "Do not replace cached logs" },
    { ...completed, recoverable: true, output: "Process exited, completion not confirmed" },
    { ...completed, transportUnavailable: true, output: "Cached completion with unavailable transport" },
  ]) {
    current = state
    await page.clock.runFor(2500)
    await expect(page.getByRole("region", { name: "Output and logs pane" }).locator(".badge")).toHaveText("transportUnavailable" in state && state.transportUnavailable ? "completed (connection unavailable)" : state.status)
    await expect(queue).toContainText("Waiting to send to the same session")
    await expect(page.getByLabel("Run output")).toHaveText(state.status.startsWith("unavailable") ? running.output : state.output)
    expect(writes).toEqual([])
  }

  await page.route("**/api/files/first.md/run/log", (route) => route.fulfill({ json: completed }))
  await page.getByRole("button", { name: "Load nohup output" }).click()
  await expect(page.getByLabel("Run output")).toHaveText("Confirmed follow-up completed")
  await expect(queue).toBeHidden()
  expect(writes).toEqual([{ path: "/api/runs/prior-harness/continue", method: "POST", body: { message: "Send only after confirmation" } }])
})

for (const scenario of [
  { name: "failed", output: { ...completed, status: "failed (exit status: 7)" } },
  { name: "stopped", output: { ...completed, status: "stopped" } },
  { name: "replaced", output: { ...completed, id: "replacement-harness" } },
]) {
  test(`queued feedback stays paused after its parent is ${scenario.name}`, async ({ page }) => {
    await page.clock.install()
    await page.clock.pauseAt(new Date(Date.now() + 1000))
    const { writes } = await workspace(page, running)
    const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
    const queue = page.getByRole("region", { name: "Queued follow-ups" })
    await feedback.fill("Never resume this parent automatically")
    await feedback.press("Enter")
    let current = scenario.output
    await page.route("**/api/files/first.md/run/log", (route) => route.fulfill({ json: current }))
    await page.getByRole("button", { name: "Load nohup output" }).click()
    await expect(queue).toContainText("The original run changed or did not complete successfully. Feedback was not sent.")
    await expect(queue.locator("pre")).toHaveText("Never resume this parent automatically")
    expect(writes).toEqual([])

    // Even a later successful read of the original parent must not unpause delivery.
    current = completed
    await page.getByRole("button", { name: "Load nohup output" }).click()
    await expect(page.getByRole("status")).toContainText("Loaded first.md.out")
    await page.clock.runFor(10_000)
    await expect(queue).toContainText("Feedback was not sent.")
    await expect(page.getByRole("button", { name: "Send & continue" })).toBeDisabled()
    expect(writes).toEqual([])
  })
}

test("queued delivery errors retain the message and new draft without automatic retries", async ({ page }) => {
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  const { writes } = await workspace(page, running)
  const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
  const queue = page.getByRole("region", { name: "Queued follow-ups" })
  const message = "  Do not retry an ambiguous delivery.\n"
  await feedback.fill(message)
  await feedback.press("Enter")
  await feedback.fill("Keep this newer draft")
  await page.route("**/api/runs/prior-harness/continue", (route) => route.fulfill({ status: 503, json: { error: "Delivery result unavailable" } }))
  await page.route("**/api/files/first.md/run/log", (route) => route.fulfill({ json: completed }))
  await page.getByRole("button", { name: "Load nohup output" }).click()
  await expect(page.getByRole("alert")).toContainText("Delivery result unavailable")
  await expect(queue).toContainText("Delivery failed or is unconfirmed.")
  await expect(queue).toContainText("automatic retry is disabled")
  await expect(queue.locator("pre")).toHaveJSProperty("textContent", message)
  await expect(feedback).toHaveValue("Keep this newer draft")
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await feedback.press("Enter")
  await page.getByRole("button", { name: "Load nohup output" }).click()
  await expect(page.getByRole("status")).toContainText("Loaded first.md.out")
  await page.clock.runFor(10_000)
  await expect(queue).toContainText("automatic retry is disabled")
  expect(writes).toEqual([{ path: "/api/runs/prior-harness/continue", method: "POST", body: { message } }])
})

test("Stop run pauses queued feedback before cancellation settles even if the parent completes and cancellation fails", async ({ page }) => {
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  const { writes } = await workspace(page, running)
  const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
  const queue = page.getByRole("region", { name: "Queued follow-ups" })
  await feedback.fill("Do not restart after Stop")
  await feedback.press("Enter")
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/runs/prior-harness/cancel", async (route) => {
    await held
    await route.fulfill({ status: 503, json: { error: "Cancellation unavailable" } })
  })
  await page.route("**/api/files/first.md/run/log", (route) => route.fulfill({ json: completed }))
  const canceled = page.waitForRequest("**/api/runs/prior-harness/cancel")
  try {
    await page.getByRole("button", { name: "Stop run", exact: true }).click()
    await canceled
    await expect(queue).toContainText("Stop requested. Queued feedback will not resume this run.")
    await page.getByRole("button", { name: "Load nohup output" }).click()
    await expect(page.getByRole("button", { name: "Stop run", exact: true })).toBeHidden()
    await expect(queue).toContainText("Stop requested.")
    expect(writes).toEqual([{ path: "/api/runs/prior-harness/cancel", method: "POST", body: {} }])
  } finally { release() }
  await expect(page.getByRole("alert")).toContainText("Cancellation unavailable")
  await page.clock.runFor(10_000)
  await expect(queue.locator("pre")).toHaveText("Do not restart after Stop")
  expect(writes).toEqual([{ path: "/api/runs/prior-harness/cancel", method: "POST", body: {} }])
})

test("Stop without a queue blocks same-tick and subsequent queued Enter while cancellation is pending", async ({ page }) => {
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  const { writes, errors } = await workspace(page, running)
  const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
  const queue = page.getByRole("region", { name: "Queued follow-ups" })
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/runs/prior-harness/cancel", async (route) => {
    await held
    await route.fulfill({ json: { ok: true } })
  })
  await feedback.fill("Do not queue after Stop")
  await expect(queue).toBeHidden()
  const canceled = page.waitForRequest("**/api/runs/prior-harness/cancel")
  const settled = page.waitForResponse("**/api/runs/prior-harness/cancel")
  try {
    await page.getByRole("button", { name: "Stop run", exact: true }).evaluate((button: HTMLButtonElement) => {
      button.click()
      document.querySelector<HTMLTextAreaElement>("#build-feedback")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }))
    })
    await canceled
    await expect(queue).toBeHidden()
    await expect(feedback).toHaveValue("Do not queue after Stop")
    await feedback.fill("New draft while cancellation is pending")
    await feedback.press("Enter")
    await expect(page.getByRole("button", { name: "Queue follow-up", exact: true })).toBeDisabled()
    await expect(queue).toBeHidden()
    await expect(feedback).toHaveValue("New draft while cancellation is pending")
    expect(writes).toEqual([{ path: "/api/runs/prior-harness/cancel", method: "POST", body: {} }])

    await page.route("**/api/runs/prior-harness", (route) => route.fulfill({ json: completed }))
    await page.clock.runFor(650)
    await expect(page.getByRole("button", { name: "Stop run", exact: true })).toBeHidden()
    await expect(page.getByRole("button", { name: "Send & continue" })).toBeVisible()
    await expect(queue).toBeHidden()
    expect(writes).toEqual([{ path: "/api/runs/prior-harness/cancel", method: "POST", body: {} }])
  } finally { release() }
  await settled
  await page.clock.runFor(10_000)
  await expect(queue).toBeHidden()
  await expect(feedback).toHaveValue("New draft while cancellation is pending")
  expect(writes).toEqual([{ path: "/api/runs/prior-harness/cancel", method: "POST", body: {} }])
  expect(errors).toEqual([])
})

test("canceling queued feedback clears the unload warning and permits a replacement without sending canceled messages", async ({ page }) => {
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  const { writes } = await workspace(page, running)
  const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
  const queue = page.getByRole("region", { name: "Queued follow-ups" })
  for (const message of ["Cancel the original", "Cancel its replacement too"]) {
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(false)
    await feedback.fill(message)
    await feedback.press("Enter")
    await expect(queue.locator("pre")).toHaveText(message)
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true)
    await feedback.fill("Unsubmitted draft survives cancellation")
    await page.getByRole("button", { name: "Cancel queued follow-up for first.md", exact: true }).click()
    await expect(queue).toBeHidden()
    await expect(feedback).toHaveValue("Unsubmitted draft survives cancellation")
    await expect(page.getByRole("button", { name: "Queue follow-up", exact: true })).toBeEnabled()
  }
  expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(false)
  await page.route("**/api/runs/prior-harness", (route) => route.fulfill({ json: completed }))
  await page.clock.runFor(650)
  await expect(page.getByRole("button", { name: "Send & continue" })).toBeEnabled()
  expect(writes).toEqual([])
})

test("Enter during a held autosave queues locally and dispatches after saving without consuming the newer draft", async ({ page }) => {
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  const { writes } = await workspace(page)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/files/first.md", async (route) => {
    await held
    await route.fulfill({ json: { name: "first.md", content: "Autosaved before queued feedback", revision: "revision-2" } })
  })
  await page.route("**/api/runs/prior-harness/continue", (route) => route.fulfill({ json: { id: "autosave-queued-child" } }))
  await page.route("**/api/runs/autosave-queued-child", (route) => route.fulfill({ json: { ...completed, id: "autosave-queued-child", output: "Queued after autosave" } }))
  const editor = page.getByRole("textbox", { name: "Edit first.md" })
  const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
  const queue = page.getByRole("region", { name: "Queued follow-ups" })
  await editor.fill("Autosaved before queued feedback")
  await feedback.fill("Submit when autosave finishes")
  const saving = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/files/first.md" && request.method() === "PUT")
  try {
    await page.clock.runFor(500)
    await saving
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
    await expect(feedback).toBeEnabled()
    await feedback.press("Enter")
    await expect(queue.locator("pre")).toHaveText("Submit when autosave finishes")
    await expect(feedback).toHaveValue("")
    await feedback.fill("New draft while saving")
    await feedback.press("Enter")
    await expect(queue.locator("pre")).toHaveCount(1)
    await expect(queue.locator("pre")).toHaveText("Submit when autosave finishes")
    await expect(feedback).toHaveValue("New draft while saving")
    expect(writes).toEqual([{ path: "/api/files/first.md", method: "PUT", body: { content: "Autosaved before queued feedback", revision: "revision-1" } }])
  } finally { release() }
  await expect(page.getByLabel("Run output")).toHaveText("Queued after autosave")
  await expect(queue).toBeHidden()
  await expect(feedback).toHaveValue("New draft while saving")
  await expect(editor).toHaveValue("Autosaved before queued feedback")
  expect(writes).toEqual([
    { path: "/api/files/first.md", method: "PUT", body: { content: "Autosaved before queued feedback", revision: "revision-1" } },
    { path: "/api/runs/prior-harness/continue", method: "POST", body: { message: "Submit when autosave finishes" } },
  ])
})

test("feedback Enter sends the exact multiline draft and Shift+Enter inserts a newline", async ({ page }) => {
  const { writes, dialogs, errors } = await workspace(page)
  const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
  const message = "  Use the smaller option.\nKeep the existing API.\n"
  await feedback.fill("  Use the smaller option.")
  await feedback.press("End")
  await feedback.press("Shift+Enter")
  await feedback.pressSequentially("Keep the existing API.")
  await feedback.press("Shift+Enter")
  await expect(feedback).toHaveValue(message)
  expect(writes).toEqual([])
  await page.route("**/api/runs/prior-harness/continue", (route) => route.fulfill({ json: { id: "enter-harness" } }))
  await page.route("**/api/runs/enter-harness", (route) => route.fulfill({ json: { ...completed, id: "enter-harness", output: "Enter feedback applied" } }))

  await feedback.press("Enter")

  await expect(page.getByLabel("Run output")).toHaveText("Enter feedback applied")
  await expect(feedback).toHaveValue("")
  await expect(page.getByRole("textbox", { name: "Edit first.md" })).toHaveValue("Saved first.md")
  expect(writes).toEqual([{ path: "/api/runs/prior-harness/continue", method: "POST", body: { message } }])
  expect(dialogs).toEqual([])
  expect(errors).toEqual([])
})

test("feedback Enter ignores modifiers, repeat and composition and guards same-tick submissions", async ({ page }) => {
  const { writes, dialogs, errors } = await workspace(page)
  const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
  const send = page.getByRole("button", { name: "Send & continue" })
  const message = "Submit this only once"
  await feedback.fill(message)
  for (const shortcut of ["Control+Enter", "Meta+Enter", "Alt+Enter"]) {
    await feedback.press(shortcut)
    await expect(send).toBeEnabled()
    expect(writes).toEqual([])
    expect(dialogs).toEqual([])
  }
  for (const ignored of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }]) {
    await feedback.dispatchEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, ...ignored })
    await expect(send).toBeEnabled()
    expect(writes).toEqual([])
  }
  await feedback.fill(message)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/runs/prior-harness/continue", async (route) => {
    await held
    await route.fulfill({ json: { id: "guarded-enter-harness" } })
  })
  await page.route("**/api/runs/guarded-enter-harness", (route) => route.fulfill({ json: { ...completed, id: "guarded-enter-harness", output: "Single Enter submission applied" } }))
  // Dispatch before React can render disabled controls to exercise the synchronous guard.
  await feedback.evaluate((element) => {
    for (let index = 0; index < 2; index++) element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }))
  })
  await expect(send).toBeDisabled()
  await expect(feedback).toBeDisabled()
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  expect(writes).toEqual([{ path: "/api/runs/prior-harness/continue", method: "POST", body: { message } }])
  release()
  await expect(page.getByLabel("Run output")).toHaveText("Single Enter submission applied")
  await expect(feedback).toHaveValue("")
  expect(writes).toEqual([{ path: "/api/runs/prior-harness/continue", method: "POST", body: { message } }])
  expect(dialogs).toEqual([])
  expect(errors).toEqual([])
})

test("feedback Enter submits a second follow-up using the newly returned run ID", async ({ page }) => {
  const { writes, dialogs, errors } = await workspace(page)
  const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
  await page.route("**/api/runs/prior-harness/continue", (route) => route.fulfill({ json: { id: "first-follow-up" } }))
  await page.route("**/api/runs/first-follow-up", (route) => route.fulfill({ json: { ...completed, id: "first-follow-up", output: "First follow-up completed" } }))
  await page.route("**/api/runs/first-follow-up/continue", (route) => route.fulfill({ json: { id: "second-follow-up" } }))
  await page.route("**/api/runs/second-follow-up", (route) => route.fulfill({ json: { ...completed, id: "second-follow-up", output: "Second follow-up completed" } }))

  await feedback.fill("Use option two")
  await feedback.press("Enter")
  await expect(page.getByLabel("Run output")).toHaveText("First follow-up completed")
  await expect(feedback).toHaveValue("")
  await feedback.press("ArrowUp")
  await expect(feedback).toHaveValue("Use option two")
  await feedback.fill("Now add the regression test")
  await expect(page.getByRole("button", { name: "Send & continue" })).toBeEnabled()
  await feedback.press("Enter")
  await expect(page.getByLabel("Run output")).toHaveText("Second follow-up completed")
  await expect(feedback).toHaveValue("")
  await feedback.press("ArrowUp")
  await expect(feedback).toHaveValue("Now add the regression test")
  expect(writes).toEqual([
    { path: "/api/runs/prior-harness/continue", method: "POST", body: { message: "Use option two" } },
    { path: "/api/runs/first-follow-up/continue", method: "POST", body: { message: "Now add the regression test" } },
  ])
  expect(dialogs).toEqual([])
  expect(errors).toEqual([])
})

test("feedback Up Arrow preserves drafts and ignores modifiers, repeat and composition", async ({ page }) => {
  const { writes, errors } = await workspace(page)
  const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
  await feedback.press("ArrowUp")
  await expect(feedback).toHaveValue("")
  const message = "  Previous follow-up.\nKeep whitespace.\n"
  await page.route("**/api/runs/prior-harness/continue", (route) => route.fulfill({ json: { id: "recall-child" } }))
  await page.route("**/api/runs/recall-child", (route) => route.fulfill({ json: { ...running, id: "recall-child", output: "Working on follow-up" } }))
  await feedback.fill(message)
  await feedback.press("Enter")
  await expect(page.getByLabel("Run output")).toHaveText("Working on follow-up")
  await expect(feedback).toHaveValue("")
  for (const shortcut of ["Shift+ArrowUp", "Control+ArrowUp", "Meta+ArrowUp", "Alt+ArrowUp"]) {
    await feedback.press(shortcut)
    await expect(feedback).toHaveValue("")
  }
  for (const ignored of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }]) {
    await feedback.dispatchEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true, ...ignored })
    await expect(feedback).toHaveValue("")
  }
  for (const draft of ["New draft\nSecond line", " "]) {
    await feedback.fill(draft)
    await feedback.press("Control+Home")
    await feedback.press("ArrowUp")
    await expect(feedback).toHaveValue(draft)
  }
  await feedback.fill("")
  await feedback.press("ArrowUp")
  await expect(feedback).toHaveValue(message)
  await expect(page.getByRole("region", { name: "Queued follow-ups" })).toBeHidden()
  expect(writes).toEqual([{ path: "/api/runs/prior-harness/continue", method: "POST", body: { message } }])
  expect(errors).toEqual([])
})

test("feedback Enter retains the exact failed draft and retries the original run", async ({ page }) => {
  const { writes, dialogs, errors } = await workspace(page)
  const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
  const message = "  Please retry option two.\nKeep the API unchanged.\n"
  let attempts = 0
  await page.route("**/api/runs/prior-harness/continue", (route) => ++attempts === 1
    ? route.fulfill({ status: 503, json: { error: "Session temporarily unavailable" } })
    : route.fulfill({ json: { id: "retried-enter-harness" } }))
  await page.route("**/api/runs/retried-enter-harness", (route) => route.fulfill({ json: { ...completed, id: "retried-enter-harness", output: "Retry completed" } }))
  await page.getByLabel("Follow output").uncheck()
  await feedback.fill(message)
  await feedback.press("Enter")
  await expect(page.getByRole("alert")).toContainText("Session temporarily unavailable")
  await expect(feedback).toHaveValue(message)
  await expect(page.getByLabel("Run output")).toHaveText(completed.output)
  await expect(page.getByLabel("Follow output")).not.toBeChecked()
  await expect(page.getByRole("button", { name: "Send & continue" })).toBeEnabled()
  expect(writes).toEqual([{ path: "/api/runs/prior-harness/continue", method: "POST", body: { message } }])

  await feedback.press("Enter")

  await expect(page.getByLabel("Run output")).toHaveText("Retry completed")
  await expect(feedback).toHaveValue("")
  await expect(page.getByRole("alert")).toBeHidden()
  expect(writes).toEqual([
    { path: "/api/runs/prior-harness/continue", method: "POST", body: { message } },
    { path: "/api/runs/prior-harness/continue", method: "POST", body: { message } },
  ])
  expect(dialogs).toEqual([])
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
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
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
  await expect(page.getByRole("button", { name: "Save & run" })).toBeEnabled()
  const queued = { ...savedBuild, parent_id: "shortcut-harness", revision: "saved-shortcut" }
  await page.route("**/api/queued-builds", (route) => route.fulfill({ json: [queued] }))
  await page.route("**/api/runs/shortcut-harness/queued-build", (route) => route.fulfill({ json: queued }))
  await editor.press("Control+Enter")
  await expect(page.getByRole("region", { name: "Saved build queue" })).toContainText("waiting")
  await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
  await editor.press("Meta+Enter")
  expect(writes).toEqual([
    { path: "/api/files/first.md", method: "PUT", body: { content: "Snapshot from shortcut", revision: "revision-1" } },
    { path: "/api/runs", method: "POST", body: { name: "first.md", revision: "saved-shortcut" } },
    { path: "/api/files/first.md", method: "PUT", body: { content: "Snapshot from shortcut", revision: "saved-shortcut" } },
    { path: "/api/runs/shortcut-harness/queued-build", method: "POST", body: { name: "first.md", revision: "saved-shortcut" } },
  ])
})

test.describe("saved editor queue", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install()
    await page.clock.pauseAt(new Date(Date.now() + 1000))
  })

  test("active-run execution stays blocked until the saved queue list loads successfully", async ({ page }) => {
    const { writes, dialogs } = await workspace(page, running)
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let available = false
    await page.route("**/api/queued-builds", async (route) => {
      await held
      return available ? route.fulfill({ json: [] }) : route.fulfill({ status: 503, json: { error: "Queue list unavailable" } })
    })
    try {
      await page.reload()
      await expect(page.getByLabel("Run output")).toHaveText(running.output)
      await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
      await page.getByRole("textbox", { name: "Edit first.md" }).press("Control+Enter")
      expect(dialogs).toEqual([])
      expect(writes).toEqual([])
    } finally { release() }
    const queue = page.getByRole("region", { name: "Saved build queue" })
    await expect(queue).toContainText("Queue list unavailable")
    await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
    await page.getByRole("textbox", { name: "Edit first.md" }).press("Meta+Enter")
    expect(dialogs).toEqual([])
    expect(writes).toEqual([])
    available = true
    await page.clock.runFor(2000)
    await expect(queue).toBeHidden()
    await expect(page.getByRole("button", { name: "Save & run" })).toBeEnabled()
  })

  test("declining button and hotkey confirmation writes nothing", async ({ page }) => {
    const { writes, dialogs } = await workspace(page, running)
    const editor = page.getByRole("textbox", { name: "Edit first.md" })
    await editor.fill("Unapproved snapshot")
    await page.getByRole("button", { name: "Save & run" }).click()
    await editor.press("Control+Enter")
    expect(dialogs).toHaveLength(2)
    for (const message of dialogs) {
      expect(message).toMatch(/queue this editor snapshot.*current build finishes successfully/)
      expect(message).toContain("survives page closure and server restart")
      expect(message).toContain("Later saves do not replace this snapshot")
      expect(message).toContain("provider costs")
    }
    await expect(editor).toHaveValue("Unapproved snapshot")
    await expect(page.getByLabel("Run output")).toHaveText(running.output)
    await expect(page.getByRole("region", { name: "Saved build queue" })).toBeHidden()
    expect(writes).toEqual([])
  })

  test("held save queues only its acknowledged revision and original parent, retaining newer edits and logs", async ({ page }) => {
    const { writes, errors } = await workspace(page, running)
    page.removeAllListeners("dialog")
    const dialogs: string[] = []
    page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.accept() })
    const editor = page.getByRole("textbox", { name: "Edit first.md" })
    const build = page.getByRole("button", { name: "Save & run" })
    const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
    await editor.fill("Snapshot approved for execution")
    await feedback.fill("Do not send competing chat")
    await page.getByLabel("Follow output").uncheck()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    await page.route("**/api/files/first.md", async (route) => {
      await held
      await route.fulfill({ json: { name: "first.md", content: "Snapshot approved for execution", revision: savedBuild.revision } })
    })
    let queued = false
    await page.route("**/api/queued-builds", (route) => route.fulfill({ json: queued ? [savedBuild] : [] }))
    await page.route("**/api/runs/prior-harness/queued-build", (route) => {
      queued = true
      return route.fulfill({ json: savedBuild })
    })
    try {
      await build.evaluate((element: HTMLButtonElement) => { element.click(); element.click() })
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
      await expect(build).toBeDisabled()
      await expect(page.getByRole("button", { name: "Queue follow-up", exact: true })).toBeDisabled()
      await expect(page.getByLabel("Run output")).toHaveText(running.output)
      await editor.press("Control+Enter")
      await editor.fill("Newer edits must not enter the snapshot")
      // Change the displayed association while PUT is pending: enqueue still belongs to the captured parent.
      await page.route("**/api/files/first.md/run/log", (route) => route.fulfill({ json: { ...running, id: "replacement-parent", output: "Replacement association" } }))
      await page.getByRole("button", { name: "Load nohup output" }).click()
      await expect(page.getByLabel("Run output")).toHaveText("Replacement association")
      expect(writes).toEqual([{ path: "/api/files/first.md", method: "PUT", body: { content: "Snapshot approved for execution", revision: "revision-1" } }])
    } finally { release() }
    await expect(page.getByRole("status")).toContainText("Saved and queued first.md")
    await expect(page.getByRole("region", { name: "Saved build queue" })).toContainText(savedBuild.revision.slice(0, 12))
    await expect(editor).toHaveValue("Newer edits must not enter the snapshot")
    await expect(page.getByRole("region", { name: "Spec editing pane" }).getByText("Unsaved", { exact: true })).toBeVisible()
    await expect(page.getByLabel("Run output")).toHaveText("Replacement association")
    await expect(page.getByLabel("Follow output")).not.toBeChecked()
    await expect(build).toBeDisabled()
    await expect(page.getByRole("button", { name: "Queue follow-up", exact: true })).toBeDisabled()
    await feedback.press("Enter")
    await editor.press("Meta+Enter")
    expect(dialogs).toHaveLength(1)
    expect(writes).toEqual([
      { path: "/api/files/first.md", method: "PUT", body: { content: "Snapshot approved for execution", revision: "revision-1" } },
      { path: "/api/runs/prior-harness/queued-build", method: "POST", body: { name: "first.md", revision: savedBuild.revision } },
    ])
    expect(errors).toEqual([])
  })

  test("queued chat blocks editor execution until canceled", async ({ page }) => {
    const { writes, dialogs } = await workspace(page, running)
    const feedback = page.getByRole("textbox", { name: "Feedback to build session" })
    await feedback.fill("Only continue this session")
    await feedback.press("Enter")
    await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
    await page.getByRole("textbox", { name: "Edit first.md" }).press("Control+Enter")
    await expect(page.getByRole("region", { name: "Saved build queue" })).toBeHidden()
    await page.getByRole("button", { name: "Cancel queued follow-up for first.md", exact: true }).click()
    await expect(page.getByRole("button", { name: "Save & run" })).toBeEnabled()
    expect(writes).toEqual([])
    expect(dialogs).toEqual([])
  })

  test("server dispatch in a background tab recovers the latest association without changing either editor", async ({ page }) => {
    const { writes, errors } = await workspace(page, running)
    const queue = page.getByRole("region", { name: "Saved build queue" })
    let started = false
    let polls = 0
    await page.route("**/api/queued-builds", (route) => {
      polls++
      return route.fulfill({ json: [{ ...savedBuild, ...(started ? { status: "started", id: "queued-child" } : {}) }] })
    })
    await page.clock.runFor(2000)
    await expect(queue).toContainText("waiting")
    await expect(page.getByLabel("Run output")).toHaveText(running.output)
    await page.getByRole("textbox", { name: "Edit first.md" }).fill("Independent first buffer")
    await page.getByRole("tabpanel").getByRole("button", { name: /second\.md/ }).click()
    await page.getByRole("textbox", { name: "Edit second.md" }).fill("Independent second buffer")
    // Keep autosave out of this association-only test while advancing server polls.
    await page.evaluate(() => window.dispatchEvent(new Event("blur")))
    const latest = { ...completed, id: "newer-than-queued-child", output: "Latest first-file build" }
    await page.route("**/api/files/first.md/run", (route) => route.fulfill({ json: latest }))
    started = true
    const recovered = page.waitForResponse("**/api/files/first.md/run")
    await page.clock.runFor(2000)
    await recovered
    await expect(queue).toContainText("started")
    await expect(page.getByLabel("Run output")).toHaveText(second.output)
    await expect(page.getByRole("textbox", { name: "Edit second.md" })).toHaveValue("Independent second buffer")
    await page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button", { name: /^first\.md/ }).click()
    await expect(page.getByLabel("Run output")).toHaveText(latest.output)
    await expect(page.getByRole("textbox", { name: "Edit first.md" })).toHaveValue("Independent first buffer")
    await expect(queue.getByRole("button", { name: "Dismiss queued build for first.md" })).toBeVisible()
    expect(polls).toBe(2)
    expect(writes).toEqual([])
    expect(errors).toEqual([])
  })

  test("saved queue is restored from the server after reload and cancel only deletes the queue entry", async ({ page }) => {
    const { writes, dialogs } = await workspace(page, running)
    page.removeAllListeners("dialog")
    page.on("dialog", (dialog) => dialog.accept())
    let items: typeof savedBuild[] = []
    let polls = 0
    await page.route("**/api/queued-builds", (route) => { polls++; return route.fulfill({ json: items }) })
    await page.route("**/api/files/first.md", (route) => route.fulfill({ json: { name: "first.md", content: "Saved first.md", revision: savedBuild.revision } }))
    await page.route("**/api/runs/prior-harness/queued-build", (route) => {
      items = route.request().method() === "DELETE" ? [] : [savedBuild]
      return route.fulfill({ json: items[0] ?? { ok: true } })
    })
    await page.getByRole("button", { name: "Save & run" }).click()
    const queue = page.getByRole("region", { name: "Saved build queue" })
    await expect(queue).toContainText("waiting")
    await expect(page.getByLabel("Run output")).toHaveText(running.output)
    const beforeReload = polls
    await page.reload()
    await expect(queue).toContainText(savedBuild.revision.slice(0, 12))
    expect(polls).toBeGreaterThan(beforeReload)
    await expect(page.getByRole("textbox", { name: "Edit first.md" })).toHaveValue("Saved first.md")
    await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
    await queue.getByRole("button", { name: "Cancel queued build for first.md" }).click()
    await expect(queue).toBeHidden()
    await expect(page.getByRole("button", { name: "Save & run" })).toBeEnabled()
    await page.clock.runFor(6000)
    await expect(queue).toBeHidden()
    await expect(page.getByLabel("Run output")).toHaveText(running.output)
    expect(writes).toEqual([
      { path: "/api/files/first.md", method: "PUT", body: { content: "Saved first.md", revision: "revision-1" } },
      { path: "/api/runs/prior-harness/queued-build", method: "POST", body: { name: "first.md", revision: savedBuild.revision } },
      { path: "/api/runs/prior-harness/queued-build", method: "DELETE", body: {} },
    ])
    expect(dialogs).toEqual([])
  })

  for (const failure of ["save", "enqueue"]) {
    test(`${failure} errors retain logs and never automatically retry enqueue`, async ({ page }) => {
      const { writes } = await workspace(page, running)
      page.removeAllListeners("dialog")
      page.on("dialog", (dialog) => dialog.accept())
      const editor = page.getByRole("textbox", { name: "Edit first.md" })
      await editor.fill("Snapshot with failed request")
      await page.route("**/api/files/first.md", (route) => failure === "save"
        ? route.fulfill({ status: 409, json: { error: "Save revision conflict" } })
        : route.fulfill({ json: { name: "first.md", content: "Snapshot with failed request", revision: savedBuild.revision } }))
      await page.route("**/api/runs/prior-harness/queued-build", (route) => route.fulfill({ status: 503, json: { error: "Enqueue result unavailable" } }))
      await page.getByRole("button", { name: "Save & run" }).click()
      await expect(page.getByRole("alert")).toContainText(failure === "save" ? "Save revision conflict" : "Enqueue result unavailable")
      await page.clock.runFor(10_000)
      await expect(page.getByLabel("Run output")).toHaveText(running.output)
      await expect(editor).toHaveValue("Snapshot with failed request")
      await expect(page.getByRole("region", { name: "Saved build queue" })).toBeHidden()
      expect(writes).toEqual([
        { path: "/api/files/first.md", method: "PUT", body: { content: "Snapshot with failed request", revision: "revision-1" } },
        ...(failure === "enqueue" ? [{ path: "/api/runs/prior-harness/queued-build", method: "POST", body: { name: "first.md", revision: savedBuild.revision } }] : []),
      ])
    })
  }

  for (const state of ["paused", "remote unavailable"]) {
    test(`${state} queue never client-dispatches a build, even after parent completion`, async ({ page }) => {
      const { writes } = await workspace(page, running)
      const item = { ...savedBuild, ...(state === "paused" ? { status: "paused", reason: "Parent stopped; explicit action required" } : {}) }
      let unavailable = false
      await page.route("**/api/queued-builds", (route) => unavailable
        ? route.fulfill({ status: 503, json: { error: "Remote unavailable" } })
        : route.fulfill({ json: [item] }))
      await page.clock.runFor(2000)
      const queue = page.getByRole("region", { name: "Saved build queue" })
      await expect(queue).toContainText(item.status)
      await page.route("**/api/runs/prior-harness", (route) => route.fulfill({ json: completed }))
      unavailable = state === "remote unavailable"
      await page.clock.runFor(10_000)
      await expect(page.getByLabel("Run output")).toHaveText(completed.output)
      await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
      if (unavailable) await expect(queue).toContainText("Could not check saved build queue: Remote unavailable")
      else await expect(queue).toContainText(item.reason!)
      await page.getByRole("textbox", { name: "Edit first.md" }).press("Control+Enter")
      expect(writes).toEqual([])
      if (!unavailable) {
        await page.route("**/api/runs/prior-harness/queued-build", (route) => route.fulfill({ json: { ok: true } }))
        await page.route("**/api/queued-builds", (route) => route.fulfill({ json: [] }))
        await queue.getByRole("button", { name: "Dismiss queued build for first.md" }).click()
        await expect(queue).toBeHidden()
        expect(writes).toEqual([{ path: "/api/runs/prior-harness/queued-build", method: "DELETE", body: {} }])
      }
    })
  }

  test("Stop reports queue revocation errors even when cancellation was requested", async ({ page }) => {
    const { writes } = await workspace(page, running)
    await page.route("**/api/runs/prior-harness/cancel", (route) => route.fulfill({ json: { ok: true, queue_error: "Queue storage unavailable" } }))
    await page.getByRole("button", { name: "Stop run", exact: true }).click()
    await expect(page.getByRole("alert")).toContainText("Stop requested, but queued build revocation could not be confirmed: Queue storage unavailable")
    expect(writes).toEqual([{ path: "/api/runs/prior-harness/cancel", method: "POST", body: {} }])
  })

  test("plain Save and focused autosave never enqueue or replace a saved snapshot", async ({ page }) => {
    const { writes, dialogs } = await workspace(page, running)
    const editor = page.getByRole("textbox", { name: "Edit first.md" })
    let revision = 1
    await page.route("**/api/files/first.md", (route) => route.fulfill({ json: { name: "first.md", content: route.request().postDataJSON().content, revision: `revision-${++revision}` } }))
    await editor.fill("Plain saved content")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await expect(page.getByRole("status")).toHaveText("Saved first.md")
    await page.route("**/api/queued-builds", (route) => route.fulfill({ json: [savedBuild] }))
    await page.clock.runFor(2000)
    const queue = page.getByRole("region", { name: "Saved build queue" })
    await expect(queue).toContainText(savedBuild.revision.slice(0, 12))
    await editor.fill("Autosaved later content")
    await page.clock.runFor(500)
    await expect(page.getByRole("region", { name: "Spec editing pane" }).getByText("Saved", { exact: true })).toBeVisible()
    await page.clock.runFor(6000)
    await expect(editor).toHaveValue("Autosaved later content")
    await expect(queue).toContainText(savedBuild.revision.slice(0, 12))
    await expect(page.getByLabel("Run output")).toHaveText(running.output)
    expect(writes).toEqual([
      { path: "/api/files/first.md", method: "PUT", body: { content: "Plain saved content", revision: "revision-1" } },
      { path: "/api/files/first.md", method: "PUT", body: { content: "Autosaved later content", revision: "revision-2" } },
    ])
    expect(dialogs).toEqual([])
  })
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
