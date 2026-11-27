import { test, expect } from "@playwright/test"
import type { Page, Route } from "@playwright/test"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ResearchOutput } from "../src/deep-research-export"

let server: ChildProcess
let directory: string
let privateDirectory: string
let url: string
const saved = "# Completed context\nPending spec unchanged."
const fixture: ResearchOutput = {
  report: { title: "Mock research", summary: "<script>never executed</script>", findings: ["Cited claim", "Uncited claim"], limitations: ["Mock evidence only"] },
  sources: [{ id: 1, title: "Public source", url: "https://example.org/research" }],
  grounding: { "findings[0]": [1] }, warnings: ["Some fields lack grounding."],
}
test.beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "spec-research-e2e-"))
  await writeFile(path.join(directory, "research.md"), saved)
  privateDirectory = await mkdtemp(path.join(tmpdir(), "spec-exa-private-e2e-"))
  server = spawn(path.resolve("../backend/target/debug/spec"), [], {
    cwd: path.resolve("../backend"),
    env: { HOME: directory, PATH: "/usr/bin:/bin", SPEC_WORKSPACE: directory, SPEC_PORT: "0", SPEC_UI_DIR: path.resolve("dist"), SPEC_AI_ENV_FILE: "/dev/null", SPEC_SETTINGS_FILE: path.join(privateDirectory, "settings/profile.json") },
    stdio: ["ignore", "pipe", "pipe"],
  })
  url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Rust server did not start")), 10_000)
    let output = ""
    server.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(/Spec: (http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+)/)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    })
    server.once("error", (error) => { clearTimeout(timer); reject(error) })
    server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}`)) })
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
  if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true })
})
test.beforeEach(async ({ page }) => {
  await writeFile(path.join(directory, "research.md"), saved)
  page.on("pageerror", (error) => { throw error })
})
async function mock(page: Page, post: (route: Route) => Promise<void>) {
  await page.route("**/api/research", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { configured: true, message: "Mock Exa configuration" } }) : post(route))
}
async function open(page: Page) {
  await page.getByRole("button", { name: "Deep research", exact: true }).click()
  return page.getByRole("dialog", { name: "Deep research", exact: true })
}
test("real unconfigured endpoint, no-tab mode, adjacency and focus return", async ({ page }) => {
  let posts = 0
  page.on("request", (r) => { if (r.method() === "POST") posts++ })
  await page.goto(url)
  const button = page.getByRole("button", { name: "Deep research", exact: true })
  expect(await button.evaluate((el) => el.previousElementSibling?.textContent)).toBe("Editor")
  const dialog = await open(page)
  await expect(dialog.getByRole("status")).toContainText("EXA_API_KEY")
  await expect(dialog.getByRole("button", { name: "Start research" })).toBeDisabled()
  await expect(dialog.getByRole("button", { name: "Use current editor text" })).toBeDisabled()
  await expect(dialog.getByLabel("Research question")).toHaveValue("")
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(button).toBeFocused()
  expect(posts).toBe(0)
})
test("explicit copy and submit, safe cited report and export preserve dirty editor and shortcuts", async ({ page }) => {
  const posts: { path: string; body: unknown }[] = []
  await mock(page, (route) => route.fulfill({ json: fixture }))
  page.on("request", (r) => { if (r.method() !== "GET" && new URL(r.url()).pathname.startsWith("/api/")) posts.push({ path: new URL(r.url()).pathname, body: r.postDataJSON() }) })
  await page.goto(url)
  await page.getByRole("tabpanel").getByRole("button", { name: /research\.md(?:\s|$)/ }).click()
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") })
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"))
  const editor = page.getByRole("textbox", { name: "Edit research.md", exact: true })
  await editor.fill(saved + "\nUnsaved private text")
  const dialog = await open(page)
  await expect(dialog.getByLabel("Research question")).toHaveValue("")
  expect(posts).toEqual([])
  await dialog.getByRole("button", { name: "Use current editor text" }).click()
  await expect(dialog.getByLabel("Research question")).toHaveValue(saved + "\nUnsaved private text")
  await dialog.getByLabel("Research question").fill("Public question only")
  await page.keyboard.press("Control+Enter")
  await page.keyboard.press("Control+s")
  expect(posts).toEqual([])
  await dialog.getByRole("button", { name: "Start research" }).click()
  await expect(dialog.getByText(/^Cited claim/)).toBeVisible()
  expect(posts).toEqual([{ path: "/api/research", body: { query: "Public question only" } }])
  await expect(dialog.locator("script, img")).toHaveCount(0)
  await expect(dialog.getByText("<script>never executed</script>", { exact: false })).toBeVisible()
  await expect(dialog.getByRole("link", { name: "Public source", exact: true })).toHaveAttribute("rel", "noopener noreferrer")
  await expect(dialog.getByRole("link", { name: "Exa source 1", exact: true })).toBeVisible()
  await expect(dialog.getByText("No usable Exa grounding", { exact: false }).first()).toBeVisible()
  const download = page.waitForEvent("download")
  await dialog.getByRole("button", { name: "Download Markdown" }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe("deep-research.md")
  expect(await readFile((await file.path())!, "utf8")).toContain("&lt;script&gt;")
  await dialog.getByRole("button", { name: "Close deep research" }).click()
  await expect(editor).toHaveValue(saved + "\nUnsaved private text")
  await expect(page.locator(".editor-pane .badge")).toHaveText("Unsaved")
  expect(await readFile(path.join(directory, "research.md"), "utf8")).toBe(saved)
})
test("byte errors do not truncate or send; server error allows deliberate retry", async ({ page }) => {
  let count = 0
  await mock(page, (route) => { count++; return route.fulfill({ status: 502, json: { error: "Exa rate limit reached" } }) })
  await page.goto(url)
  await page.getByRole("tabpanel").getByRole("button", { name: /research\.md(?:\s|$)/ }).click()
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") }); await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"))
  await page.getByRole("textbox", { name: "Edit research.md", exact: true }).fill("é".repeat(4097))
  const dialog = await open(page)
  await dialog.getByRole("button", { name: "Use current editor text" }).click()
  await expect(dialog.getByRole("alert")).toContainText("8 KiB")
  await expect(dialog.getByLabel("Research question")).toHaveValue("")
  await dialog.getByLabel("Research question").fill("é".repeat(4097))
  await dialog.getByRole("button", { name: "Start research" }).click()
  await expect(dialog.getByLabel("Research question")).toHaveValue("é".repeat(4097))
  expect(count).toBe(0)
  await dialog.getByLabel("Research question").fill("Public question")
  await dialog.getByRole("button", { name: "Start research" }).click()
  await expect(dialog.getByRole("alert")).toHaveText("Exa rate limit reached")
  await expect(dialog.getByRole("button", { name: "Start research" })).toBeEnabled()
  expect(count).toBe(1)
})
test("busy duplicate guard, close warning, stale response ignored after reopening, mobile", async ({ page }) => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let count = 0
  await mock(page, async (route) => { count++; await held; await route.fulfill({ json: fixture }).catch(() => {}) })
  await page.goto(url)
  await page.setViewportSize({ width: 390, height: 844 })
  let dialog = await open(page)
  await dialog.getByLabel("Research question").fill("Public question")
  await dialog.getByRole("button", { name: "Start research" }).click()
  await expect(dialog.getByRole("button", { name: "Researching…", exact: true })).toBeDisabled()
  await dialog.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit())
  expect(count).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  page.once("dialog", async (d) => { expect(d.message()).toContain("charges may continue"); await d.dismiss() })
  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  page.once("dialog", (d) => d.accept())
  await dialog.getByRole("button", { name: "Close deep research" }).click()
  await expect(dialog).toBeHidden()
  dialog = await open(page)
  release()
  await expect(dialog.getByLabel("Research question")).toHaveValue("")
  await expect(dialog.getByRole("button", { name: "Download Markdown" })).toBeHidden()
  await expect(dialog.getByRole("button", { name: "Start research" })).toBeEnabled()
})

test("ordinary autosave continues independently and editor selection survives research", async ({ page }) => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const mutations: string[] = []
  await mock(page, async (route) => { await held; await route.fulfill({ json: fixture }) })
  page.on("request", (r) => { if (r.method() !== "GET") mutations.push(`${r.method()} ${new URL(r.url()).pathname}`) })
  await page.goto(url)
  await page.getByRole("tabpanel").getByRole("button", { name: /research\.md(?:\s|$)/ }).click()
  const editor = page.getByRole("textbox", { name: "Edit research.md", exact: true })
  const edited = saved + "\nOrdinary autosave, not research insertion."
  await editor.fill(edited)
  await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 9))
  const dialog = await open(page)
  await dialog.getByLabel("Research question").fill("Public question")
  await dialog.getByRole("button", { name: "Start research" }).click()
  await expect.poll(() => readFile(path.join(directory, "research.md"), "utf8")).toBe(edited)
  release()
  await expect(dialog.getByRole("button", { name: "Download Markdown" })).toBeVisible()
  await dialog.getByRole("button", { name: "Close deep research" }).click()
  await expect(editor).toHaveValue(edited)
  expect(await editor.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([2, 9])
  await expect(page.locator(".editor-pane .badge")).toHaveText("Saved")
  expect(mutations.filter((entry) => !["POST /api/research", "PUT /api/files/research.md"].includes(entry))).toEqual([])
})

test("real Settings API applies Exa preferences and disable/reset to reopened research without reload", async ({ page }) => {
  const requests: string[] = []
  page.on("request", (r) => { if (r.method() !== "GET") requests.push(`${r.method()} ${new URL(r.url()).pathname}`) })
  await page.goto(url)
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const section = page.getByRole("region", { name: "Exa Deep Search" })
  await section.getByLabel("Exa API key").fill("fake-e2e-key-never-submitted")
  await section.getByLabel("Returned pages").fill("4")
  await section.getByLabel("Source filter").selectOption("exclude")
  await section.getByLabel("Domain names").fill("Example.org")
  await section.getByRole("button", { name: "Save Exa settings", exact: true }).click()
  await expect(section.getByRole("status")).toContainText("Exa settings saved")
  await expect(section.getByLabel("Exa API key")).toHaveValue("")
  await page.getByRole("button", { name: "Back to workspace" }).click()
  let dialog = await open(page)
  await expect(dialog.getByRole("button", { name: "Start research", exact: true })).toBeEnabled()
  await expect(dialog.getByText(/Server settings when opened/)).toContainText("4 returned pages; exclude domains: example.org")
  await expect(dialog.getByText(/configured search filters are sent/)).toBeVisible()
  await dialog.getByRole("button", { name: "Close deep research" }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await section.getByLabel("Enable Deep Search").uncheck()
  await section.getByRole("button", { name: "Save Exa settings", exact: true }).click()
  await expect(section.getByRole("status")).toContainText("New research is disabled")
  await page.getByRole("button", { name: "Back to workspace" }).click()
  dialog = await open(page)
  await expect(dialog.getByRole("status")).toContainText("disabled in Settings")
  await expect(dialog.getByRole("button", { name: "Start research", exact: true })).toBeDisabled()
  await dialog.getByRole("button", { name: "Close deep research" }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  page.once("dialog", (d) => d.accept())
  await section.getByRole("button", { name: "Reset Exa settings", exact: true }).click()
  await expect(section.getByRole("status")).toContainText("No key is configured")
  expect(await readFile(path.join(privateDirectory, "settings/profile.json.research.json"), "utf8")).toBe("null")
  expect(requests).toEqual(["PUT /api/settings/research", "PUT /api/settings/research", "DELETE /api/settings/research"])
})
