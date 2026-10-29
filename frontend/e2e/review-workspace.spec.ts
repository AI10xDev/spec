import { test, expect, type Page, type Route } from "@playwright/test"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"

let server: ChildProcess
let directory: string
let url: string
const tasks = "# Todos\n[\u2713] Implement\n[ ] Verify\n\n"
const run = (name = "a.md", id = "run-a", output = tasks) => ({ id, name, output, status: "running", truncated: false, recoverable: true, continuable: true })

test.beforeAll(async () => {
  directory = await mkdtemp("/tmp/opencode/spec-review-workspace-")
  server = spawn(path.resolve("../backend/target/debug/spec"), [], {
    cwd: path.resolve("../backend"),
    env: { HOME: "/tmp/opencode", PATH: process.env.PATH, SPEC_WORKSPACE: directory, SPEC_PORT: "0", SPEC_UI_DIR: path.resolve("dist"), SPEC_AI_ENV_FILE: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Local server did not start")), 10_000)
    let stdout = ""
    let stderr = ""
    server.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000) })
    server.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
      const match = stdout.match(/Spec: (http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+)/)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    })
    server.once("error", (error) => { clearTimeout(timer); reject(error) })
    server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Local server exited ${code}: ${stderr}`)) })
  })
})

test.afterAll(async () => {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => server.kill("SIGKILL"), 10_000)
      server.once("exit", () => { clearTimeout(timer); resolve() })
      server.kill("SIGTERM")
    })
  }
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function workspace(page: Page, options: { content?: string; completion?: boolean; runs?: ReturnType<typeof run>[] } = {}) {
  const mutations: string[] = []
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const files = { "a.md": options.content ?? "Initial", "b.md": "Second", "c.md": "Third" }
  // Every API request is intercepted, including accidental execution or provider requests.
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const endpoint = new URL(request.url()).pathname.slice(4)
    if (request.method() !== "GET") {
      mutations.push(`${request.method()} ${endpoint}`)
      return route.fulfill({ status: 503, json: { error: "Unexpected mutation" } })
    }
    let json: unknown
    if (endpoint === "/config") json = { execution: true, completion: options.completion ?? false, chat: false, realtime: false, azureRealtime: false }
    else if (endpoint === "/files") json = Object.entries(files).map(([name, content]) => ({ name, bytes: content.length, modified: 0 }))
    else if (endpoint === "/repository") json = { connected: true, dirty: true, directory: "/fixture", model: "fixture" }
    else if (endpoint === "/optimize") json = null
    else if (endpoint.startsWith("/runs/")) json = options.runs?.find((item) => item.id === endpoint.split("/")[2]) ?? null
    else if (endpoint.endsWith("/run")) json = options.runs?.find((item) => item.name === endpoint.split("/")[2]) ?? null
    else if (endpoint.startsWith("/files/") && endpoint.slice(7) in files) {
      const name = endpoint.slice(7) as keyof typeof files
      json = { name, content: files[name], revision: "1" }
    } else {
      errors.push(`Unexpected API read: ${endpoint}`)
      return route.fulfill({ status: 404, json: { error: "Unknown fixture request" } })
    }
    await route.fulfill({ json })
  })
  await page.goto(url)
  await expect(page.getByRole("tab", { name: "Saved files" })).toBeVisible()
  return { mutations, errors }
}

const savedFile = (page: Page, name: string) => page.getByRole("tabpanel").getByRole("button", { name: new RegExp(name.replace(".", "\\.")) })
const editorTab = (page: Page, name: string) => page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button", { name: new RegExp(`^${name.replace(".", "\\.")}(?: |$)`) })

for (const intent of ["editor tab", "sidebar tab", "create", "close"] as const) {
  test(`F6: delayed opens cannot override a newer ${intent} intent`, async ({ page }) => {
    await workspace(page)
    await savedFile(page, "b.md").click()
    let delayed: Route | undefined
    await page.route("**/api/files/a.md", (route) => { delayed = route })
    await savedFile(page, "a.md").click()
    await expect.poll(() => !!delayed).toBe(true)
    if (intent === "editor tab") await editorTab(page, "b.md").click()
    if (intent === "sidebar tab") {
      await page.getByRole("tab", { name: /Open tabs/ }).click()
      await savedFile(page, "b.md").click()
    }
    if (intent === "create") {
      await page.getByRole("textbox", { name: "New filename" }).fill("new.md")
      await page.getByRole("button", { name: "Create file" }).click()
    }
    if (intent === "close") await page.getByRole("button", { name: "Close b.md" }).click()
    await delayed!.fulfill({ json: { name: "a.md", content: "Late", revision: "1" } })
    await expect(editorTab(page, "a.md")).toBeVisible()
    await expect(page.getByRole("textbox", { name: "Edit a.md" })).toBeHidden()
    if (intent === "close") await expect(page.getByRole("heading", { name: "Start with a spec." })).toBeVisible()
    else await expect(page.getByRole("textbox", { name: intent === "create" ? "Edit new.md" : "Edit b.md" })).toBeVisible()
  })
}

test("F6: out-of-order reads populate independent tabs but activate only the last intent", async ({ page }) => {
  await workspace(page)
  let delayed: Route | undefined
  await page.route("**/api/files/a.md", (route) => { delayed = route })
  await savedFile(page, "a.md").click()
  await expect.poll(() => !!delayed).toBe(true)
  await savedFile(page, "b.md").click()
  await page.getByRole("textbox", { name: "Edit b.md" }).fill("Unsaved newer buffer")
  await delayed!.fulfill({ json: { name: "a.md", content: "Late", revision: "1" } })
  await expect(editorTab(page, "a.md")).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Edit b.md" })).toHaveValue("Unsaved newer buffer")
  await editorTab(page, "a.md").click()
  await expect(page.getByRole("textbox", { name: "Edit a.md" })).toHaveValue("Late")
})

test("F7: tab switches preserve native undo/redo, selection direction and scroll independently", async ({ page }) => {
  const content = "Initial\n" + "Long spec line\n".repeat(100)
  await workspace(page, { content })
  await savedFile(page, "a.md").click()
  const a = page.getByRole("textbox", { name: "Edit a.md" })
  await a.focus()
  await a.press("Control+End")
  await a.pressSequentially("XYZ")
  const view = await a.evaluate((node: HTMLTextAreaElement) => {
    node.dataset.retained = "yes"
    node.setSelectionRange(12, 19, "backward")
    node.scrollTop = 300
    return { start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection, top: node.scrollTop }
  })
  await savedFile(page, "b.md").click()
  const b = page.getByRole("textbox", { name: "Edit b.md" })
  await b.focus()
  await b.press("Control+End")
  await b.pressSequentially("QQ")
  await editorTab(page, "a.md").click()
  await expect(a).toHaveAttribute("data-retained", "yes")
  expect(await a.evaluate((node: HTMLTextAreaElement) => ({ start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection, top: node.scrollTop }))).toEqual(view)
  await a.focus()
  await a.press("Control+z")
  await expect(a).toHaveValue(content)
  await a.press("Control+Shift+z")
  await expect(a).toHaveValue(content + "XYZ")
  await editorTab(page, "b.md").click()
  await b.focus()
  await b.press("Control+z")
  await expect(b).toHaveValue("Second")
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(b).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test("F7: inactive editors cancel completions and cannot handle shortcuts or steal focus", async ({ page }) => {
  const fixture = await workspace(page, { completion: true })
  const dialogs: string[] = []
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss() })
  let pending: Route | undefined
  let completions = 0
  await page.route("**/api/completions", (route) => { completions++; pending = route })
  await savedFile(page, "a.md").click()
  const a = page.getByRole("textbox", { name: "Edit a.md" })
  await a.focus()
  await a.press("Control+End")
  await expect.poll(() => completions).toBe(1)
  await savedFile(page, "b.md").click()
  await pending!.fulfill({ json: { suffix: " ghost from a" } }).catch(() => {})
  const tab = editorTab(page, "b.md")
  await expect(tab).not.toBeFocused()
  await tab.focus()
  const hidden = page.locator('textarea[aria-label="Edit a.md"]')
  await hidden.dispatchEvent("keydown", { key: "s", ctrlKey: true })
  await hidden.dispatchEvent("keydown", { key: "Enter", ctrlKey: true })
  await hidden.dispatchEvent("keydown", { key: "/" })
  await hidden.evaluate((node: HTMLTextAreaElement) => node.focus())
  await expect(tab).toBeFocused()
  await page.waitForTimeout(700)
  expect(completions).toBe(1)
  expect(fixture.mutations).toEqual([])
  expect(dialogs).toEqual([])
  await expect(page.locator(".editor-input:visible .completion-ghost")).toHaveText("")
  await editorTab(page, "a.md").click()
  await a.focus()
  await a.press("Control+End")
  await expect.poll(() => completions).toBe(2)
  await pending!.fulfill({ json: { suffix: " accepted" } })
  await expect(page.locator(".completion-ghost:visible")).toHaveText(" accepted")
  await a.press("Tab")
  await expect(a).toHaveValue("Initial accepted")
  await editorTab(page, "b.md").click()
  await editorTab(page, "a.md").click()
  await a.focus()
  await a.press("Control+z")
  await expect(a).toHaveValue("Initial")
  expect(fixture.errors).toEqual([])
})

test("F7: marker, replacement, deletion and IME edits retain undo across tabs", async ({ page }) => {
  await workspace(page)
  await savedFile(page, "a.md").click()
  const a = page.getByRole("textbox", { name: "Edit a.md" })
  await a.focus()
  await a.press("Control+End")
  await a.press("/")
  await expect(a).toHaveValue("# Initial")
  await savedFile(page, "b.md").click()
  await editorTab(page, "a.md").click()
  await a.focus()
  await a.press("Control+z")
  await expect(a).toHaveValue("Initial")
  await a.press("Control+y")
  await expect(a).toHaveValue("# Initial")
  await a.press("Control+a")
  await page.keyboard.insertText("Replacement")
  await a.press("Backspace")
  await a.press("Backspace")
  await expect(a).toHaveValue("Replaceme")
  await editorTab(page, "b.md").click()
  await editorTab(page, "a.md").click()
  await a.focus()
  await a.press("Control+z")
  await expect(a).toHaveValue("Replacement")
  await a.press("Control+z")
  await expect(a).toHaveValue("# Initial")
  await a.press("Control+End")
  await a.dispatchEvent("compositionstart", { data: "" })
  await page.keyboard.insertText(" composed")
  await a.dispatchEvent("compositionend", { data: " composed" })
  await expect(a).toHaveValue("# Initial composed")
  await editorTab(page, "b.md").click()
  await editorTab(page, "a.md").click()
  await a.focus()
  await a.press("Control+z")
  await expect(a).toHaveValue("# Initial")
})

for (const measured of [true, false]) {
  test(`F8: failed polls mark ${measured ? "measured" : "indeterminate"} progress stale, retain guards and recover`, async ({ page }) => {
    const output = run("a.md", "run-a", measured ? tasks : "Starting...")
    await workspace(page, { runs: [output] })
    let mode: "success" | "http" | "transport" = "success"
    let polls = 0
    await page.route("**/api/runs/run-a", (route) => {
      polls++
      return mode === "http" ? route.fulfill({ status: 503, json: { error: "Poll unavailable" } })
        : mode === "transport" ? route.abort("failed") : route.fulfill({ json: output })
    })
    await savedFile(page, "a.md").click()
    const progress = page.getByRole("progressbar")
    await expect(progress).toHaveAttribute("aria-valuetext", /Build in progress/)
    if (measured) await expect(progress).toHaveAttribute("aria-valuenow", "50")
    else await expect(progress).toHaveClass(/indeterminate/)
    mode = "http"
    await expect(progress).toHaveAttribute("aria-valuetext", /progress may be stale/)
    await expect(progress).not.toHaveClass(/indeterminate/)
    await expect(page.locator(".output-pane .badge")).toHaveText("running (connection unavailable)")
    await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
    await expect(page.getByRole("button", { name: "Performance" })).toBeDisabled()
    await expect(page.getByRole("button", { name: "Save repo changes" })).toBeDisabled()
    await expect(page.getByRole("button", { name: "Stop run" })).toBeEnabled()
    mode = "transport"
    const before = polls
    await expect.poll(() => polls, { timeout: 5000 }).toBeGreaterThan(before)
    await expect(progress).toHaveAttribute("aria-valuetext", /progress may be stale/)
    mode = "success"
    await expect(progress).toHaveAttribute("aria-valuetext", /Build in progress/)
    await expect(page.locator(".output-pane .badge")).toHaveText("running")
    if (measured) await expect(progress).toHaveAttribute("aria-valuenow", "50")
    else await expect(progress).toHaveClass(/indeterminate/)
  })
}

test("F8: a failed background run poll cannot mark another run stale", async ({ page }) => {
  await workspace(page, { runs: [run(), run("b.md", "run-b")] })
  let pending: Route | undefined
  await page.route("**/api/runs/run-a", (route) => { pending = route })
  await savedFile(page, "a.md").click()
  await expect.poll(() => !!pending).toBe(true)
  await savedFile(page, "b.md").click()
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-label", /b.md/)
  await pending!.fulfill({ status: 503, json: { error: "Old run poll failed" } })
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuetext", /Build in progress/)
  await expect(page.locator(".output-pane .badge")).toHaveText("running")
})

test("F8: a late failed poll cannot mark a replacement run for the same file stale", async ({ page }) => {
  await workspace(page, { runs: [run(), run("a.md", "replacement")] })
  let pending: Route | undefined
  await page.route("**/api/runs/run-a", (route) => { pending = route })
  await page.route("**/api/files/a.md/run/log", (route) => route.fulfill({ json: run("a.md", "replacement") }))
  await savedFile(page, "a.md").click()
  await expect.poll(() => !!pending).toBe(true)
  await page.getByRole("button", { name: "Load nohup output" }).click()
  await expect(page.getByText("Run: replacement", { exact: false })).toBeVisible()
  await pending!.fulfill({ status: 503, json: { error: "Superseded poll failed" } })
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuetext", /Build in progress/)
  await expect(page.locator(".output-pane .badge")).toHaveText("running")
  await expect(page.getByRole("alert")).toBeHidden()
})

test("F10: Analytics suppresses save and build from selects, buttons and headings", async ({ page }) => {
  const fixture = await workspace(page)
  await savedFile(page, "a.md").click()
  const editor = page.locator('textarea[aria-label="Edit a.md"]')
  await editor.fill("Dirty unsaved text")
  const dialogs: string[] = []
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss() })
  await page.getByRole("button", { name: "Analytics", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByLabel("Spec to analyse")).toBeEnabled()
  for (const control of [dialog.getByLabel("Spec to analyse"), dialog.getByRole("button", { name: "Close analytics" }), dialog.getByRole("heading")]) {
    await control.evaluate((node: HTMLElement) => { node.tabIndex = 0; node.focus() })
    for (const key of ["Control+Enter", "Meta+Enter", "Control+s", "Meta+s"]) await page.keyboard.press(key)
  }
  // Also guard a programmatically delivered editor event while the modal is open.
  await editor.dispatchEvent("keydown", { key: "s", ctrlKey: true })
  expect(dialogs).toEqual([])
  expect(fixture.mutations).toEqual([])
  await expect(editor).toHaveValue("Dirty unsaved text")
  await dialog.getByRole("button", { name: "Close analytics" }).click()
  await editor.focus()
  await editor.press("Control+Enter")
  await expect.poll(() => dialogs.length).toBe(1)
  await editor.press("Control+s")
  await expect.poll(() => fixture.mutations).toEqual(["PUT /files/a.md"])
})

test("F13: sidebar tabs provide roving focus, arrow wrapping, Home/End and labelled panels", async ({ page }) => {
  await workspace(page)
  const saved = page.getByRole("tab", { name: "Saved files" })
  const opened = page.getByRole("tab", { name: /Open tabs/ })
  await expect(saved).toHaveAttribute("tabindex", "0")
  await expect(opened).toHaveAttribute("tabindex", "-1")
  await saved.focus()
  for (const [key, selected, other] of [
    ["ArrowRight", opened, saved], ["ArrowRight", saved, opened],
    ["ArrowLeft", opened, saved], ["Home", saved, opened], ["End", opened, saved],
  ] as const) {
    await page.keyboard.press(key)
    await expect(selected).toBeFocused()
    await expect(selected).toHaveAttribute("aria-selected", "true")
    await expect(selected).toHaveAttribute("tabindex", "0")
    await expect(other).toHaveAttribute("aria-selected", "false")
    await expect(other).toHaveAttribute("tabindex", "-1")
    const panel = page.getByRole("tabpanel")
    await expect(panel).toHaveAttribute("id", (await selected.getAttribute("aria-controls"))!)
    await expect(panel).toHaveAttribute("aria-labelledby", (await selected.getAttribute("id"))!)
  }
  await page.keyboard.press("Tab")
  await expect(page.getByRole("textbox", { name: "Filter files" })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("tabpanel", { name: /Open tabs/ })).toBeFocused()
})
