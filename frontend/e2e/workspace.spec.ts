import { test, expect } from "@playwright/test"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

let server: ChildProcess
let directory: string
let url: string
let pageErrors: string[]

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "spec-e2e-"))
  server = spawn(path.resolve("../backend/target/debug/spec"), [], {
    cwd: path.resolve("../backend"),
    env: { ...process.env, SPEC_WORKSPACE: directory, SPEC_PORT: "0", SPEC_UI_DIR: path.resolve("dist"), SPEC_COMMAND: undefined, SPEC_SSH_TARGET: undefined, SPEC_SSH_WORKSPACE: undefined, SPEC_SSH_KEY: undefined, SPEC_SSH_BINARY: undefined },
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
    server.on("error", reject)
    server.on("exit", (code) => { clearTimeout(timeout); reject(new Error(`Server exited ${code}`)) })
  })
})

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()))
    server.kill("SIGTERM")
    await exited
  }
  if (directory) await rm(directory, { recursive: true, force: true })
})

test.beforeEach(async ({ page, context }) => {
  pageErrors = []
  const record = (error: Error) => pageErrors.push(error.message)
  page.on("pageerror", record)
  context.on("page", (page) => page.on("pageerror", record))
})

test.afterEach(async () => {
  expect(pageErrors).toEqual([])
})

test("real API: history, independent tabs, dirty protection, split panes and reload", async ({ page }, testInfo) => {
  await page.goto(url)
  await expect(page.getByRole("button", { name: "Create file" })).toBeVisible()
  await page.getByRole("textbox", { name: "New filename" }).fill("first.md")
  await page.getByRole("button", { name: "Create file" }).click()
  await page.getByRole("textbox", { name: "Edit first.md" }).fill("# First spec\nBuild a useful tool.")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("Saved first.md")
  await expect(page.getByRole("tab", { name: "Saved files" })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("tabpanel").getByRole("button", { name: /first.md/ })).toBeVisible()
  await page.getByRole("textbox", { name: "New filename" }).fill("second.md")
  await page.getByRole("button", { name: "Create file" }).click()
  await page.getByRole("textbox", { name: "Edit second.md" }).fill("# Second spec\nIndependent buffer.")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("Saved second.md")
  await page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button", { name: "first.md", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Edit first.md" })).toHaveValue("# First spec\nBuild a useful tool.")
  await page.getByRole("textbox", { name: "Edit first.md" }).fill("Unsaved first spec")
  await page.getByRole("tabpanel").getByRole("button", { name: /first.md/ }).click()
  await expect(page.getByRole("textbox", { name: "Edit first.md" })).toHaveValue("Unsaved first spec")
  page.once("dialog", (dialog) => dialog.dismiss())
  await page.getByRole("button", { name: "Close first.md" }).click()
  await expect(page.getByRole("textbox", { name: "Edit first.md" })).toBeVisible()
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("Saved first.md")
  const editor = await page.getByRole("region", { name: "Spec editing pane" }).boundingBox()
  const output = await page.getByRole("region", { name: "Output and logs pane" }).boundingBox()
  expect(editor!.x + editor!.width).toBeLessThanOrEqual(output!.x + 1)
  await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath("workspace-desktop.png"), fullPage: true })
  await page.reload()
  await page.getByRole("tabpanel").getByRole("button", { name: /first.md/ }).click()
  await expect(page.getByRole("textbox", { name: "Edit first.md" })).toHaveValue("Unsaved first spec")
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole("textbox", { name: "Edit first.md" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("workspace-mobile.png"), fullPage: true })
})

test("rainbow theme supports keyboard focus, reduced motion and narrow screens", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(new URL("/", url).href)
  const tokenInput = page.getByLabel("Server access token")
  await expect(tokenInput).toBeVisible()
  await expect(page.locator(".brand-mark")).toHaveCSS("animation-name", "none")
  await page.keyboard.press("Tab")
  await expect(tokenInput).toBeFocused()
  await expect(tokenInput).toHaveCSS("outline-style", "solid")
  await page.screenshot({ path: testInfo.outputPath("connect-desktop.png"), fullPage: true })
  await page.setViewportSize({ width: 320, height: 740 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("connect-mobile.png"), fullPage: true })

  await tokenInput.fill(new URLSearchParams(new URL(url).hash.slice(1)).get("token")!)
  await page.getByRole("button", { name: /Open workspace/ }).click()
  await expect(page.getByRole("button", { name: "Create file" })).toBeVisible()
  await expect(page.locator(".brand-mark")).toHaveCSS("animation-name", "none")
  await expect(page.getByRole("heading", { name: "Start with a spec." })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("empty-workspace-mobile.png"), fullPage: true })

  await page.emulateMedia({ reducedMotion: "no-preference" })
  await expect(page.locator(".brand-mark")).toHaveCSS("animation-name", "spectrum-flow")
})

test("stale writes return conflicts without losing the browser buffer", async ({ page, context }) => {
  await page.goto(url)
  await page.getByRole("textbox", { name: "New filename" }).fill("conflict.md")
  await page.getByRole("button", { name: "Create file" }).click()
  await page.getByRole("textbox", { name: "Edit conflict.md" }).fill("original")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("Saved conflict.md")
  const second = await context.newPage()
  await second.goto(url)
  await second.getByRole("tabpanel").getByRole("button", { name: /conflict.md/ }).click()
  await second.getByRole("textbox", { name: "Edit conflict.md" }).fill("second browser")
  await second.getByRole("button", { name: "Save", exact: true }).click()
  await expect(second.getByRole("status")).toHaveText("Saved conflict.md")
  await page.getByRole("textbox", { name: "Edit conflict.md" }).fill("keep my changes")
  const rejected = page.waitForResponse((response) => response.url().endsWith("/api/files/conflict.md") && response.request().method() === "PUT")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  expect((await rejected).status()).toBe(409)
  await expect(page.getByRole("alert")).toContainText("File changed on disk")
  await expect(page.getByRole("textbox", { name: "Edit conflict.md" })).toHaveValue("keep my changes")
  const downloaded = page.waitForEvent("download")
  await page.getByRole("button", { name: "Download", exact: true }).click()
  const download = await downloaded
  expect(download.suggestedFilename()).toBe("conflict.md")
  expect(await readFile((await download.path())!, "utf8")).toBe("keep my changes")
  expect(await readFile(path.join(directory, "conflict.md"), "utf8")).toBe("second browser")
  await second.close()
})

test("token fragments are removed and manual connections reject invalid tokens and survive reload", async ({ page }) => {
  const token = new URLSearchParams(new URL(url).hash.slice(1)).get("token")!
  await page.goto(url)
  await expect(page.getByRole("button", { name: "Create file" })).toBeVisible()
  expect(await page.evaluate(() => location.hash.length)).toBe(0)
  expect(await page.evaluate((expected) => sessionStorage.getItem("spec-token") === expected, token)).toBe(true)
  await page.evaluate(() => sessionStorage.removeItem("spec-token"))
  await page.reload()
  const input = page.getByLabel("Server access token")
  await expect(input).toHaveValue("")
  expect((await page.request.get(new URL("/api/files", url).href)).status()).toBe(401)
  await input.fill("invalid-token")
  const rejected = page.waitForResponse((response) => response.url().endsWith("/api/config"))
  await page.getByRole("button", { name: /Open workspace/ }).click()
  expect((await rejected).status()).toBe(401)
  await expect(page.getByRole("alert")).toContainText("Paste the access token printed by the Rust server")
  await expect(input).toBeVisible()
  await expect(page.getByRole("button", { name: "Create file" })).toBeHidden()
  await input.fill(token)
  await page.getByRole("button", { name: /Open workspace/ }).click()
  await expect(page.getByRole("button", { name: "Create file" })).toBeVisible()
  await expect(page.getByRole("alert")).toBeHidden()
  expect(await page.evaluate((expected) => sessionStorage.getItem("spec-token") === expected, token)).toBe(true)
  await page.reload()
  await expect(page.getByRole("button", { name: "Create file" })).toBeVisible()
  await expect(input).toBeHidden()
  expect(await page.evaluate(() => location.hash.length)).toBe(0)
})

test("filenames, empty files, filtered navigation, keyboard saves and accepted dirty discard", async ({ page }) => {
  await page.goto(url)
  const filename = page.getByRole("textbox", { name: "New filename" })
  const create = page.getByRole("button", { name: "Create file" })
  const pane = page.getByRole("region", { name: "Spec editing pane" })
  const files = page.getByRole("tabpanel")
  const filter = page.getByRole("textbox", { name: "Filter files" })
  for (const invalid of ["   ", "../escape.md", ".hidden.md", "bad\\name.md", "bad:name.md", "a".repeat(181)]) {
    await filename.fill(invalid)
    await create.click()
    await expect(page.getByRole("alert")).toContainText("Choose a filename without directories, hidden names, or control characters")
    await expect(page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button")).toHaveCount(0)
  }
  await filename.fill("empty.md")
  await create.click()
  await expect(page.getByRole("alert")).toBeHidden()
  await expect(page.getByRole("textbox", { name: "Edit empty.md" })).toHaveValue("")
  await expect(pane.getByText("Unsaved", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("Saved empty.md")
  expect(await readFile(path.join(directory, "empty.md"), "utf8")).toBe("")
  await page.getByRole("button", { name: "Close empty.md" }).click()

  await filename.fill("keyboard.md")
  await create.click()
  const editor = page.getByRole("textbox", { name: "Edit keyboard.md" })
  const content = "# Keyboard save\nThese bytes belong on disk.\n"
  await editor.fill(content)
  await filter.fill("EMPTY.MD")
  await expect(files.getByRole("button")).toHaveCount(1)
  await expect(files.getByRole("button", { name: /empty\.md/ })).toBeVisible()
  await page.getByRole("tab", { name: /Open tabs/ }).click()
  await expect(files.getByRole("button")).toHaveCount(0)
  await filter.fill("KEYBOARD.MD")
  await expect(files.getByRole("button")).toHaveCount(1)
  await expect(files.getByRole("button", { name: /^keyboard\.md/ })).toBeVisible()
  await expect(editor).toHaveValue(content)
  await editor.press("Control+s")
  await expect(page.getByRole("status")).toHaveText("Saved keyboard.md")
  await expect(pane.getByText("Saved", { exact: true })).toBeVisible()
  expect(await readFile(path.join(directory, "keyboard.md"), "utf8")).toBe(content)
  await page.getByRole("tab", { name: "Saved files" }).click()
  await expect(files.getByRole("button")).toHaveCount(1)
  await expect(files.getByRole("button", { name: /keyboard\.md/ })).toBeVisible()
  await editor.fill("Discard these unsaved edits")
  await expect(pane.getByText("Unsaved", { exact: true })).toBeVisible()
  const discarded = page.waitForEvent("dialog")
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Close keyboard.md" }).click()
  expect((await discarded).message()).toBe("Discard unsaved changes to keyboard.md?")
  await expect(editor).toBeHidden()
  expect(await readFile(path.join(directory, "keyboard.md"), "utf8")).toBe(content)
  await files.getByRole("button", { name: /keyboard\.md/ }).click()
  await expect(editor).toHaveValue(content)
  await expect(pane.getByText("Saved", { exact: true })).toBeVisible()
})

test("edits during a real in-flight save retain the later buffer and save again successfully", async ({ page }) => {
  await page.goto(url)
  await page.getByRole("textbox", { name: "New filename" }).fill("inflight.md")
  await page.getByRole("button", { name: "Create file" }).click()
  const editor = page.getByRole("textbox", { name: "Edit inflight.md" })
  const save = page.getByRole("button", { name: "Save", exact: true })
  const pane = page.getByRole("region", { name: "Spec editing pane" })
  const snapshot = "Submitted snapshot"
  const edited = `${snapshot} + later edits`
  await editor.fill(snapshot)
  let release!: () => void
  let fetched!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const submitted = new Promise<void>((resolve) => { fetched = resolve })
  await page.route("**/api/files/inflight.md", async (route) => {
    const response = await route.fetch()
    fetched()
    await gate
    await route.fulfill({ response })
  }, { times: 1 })
  try {
    await save.click()
    await submitted
    await expect(save).toBeDisabled()
    expect(await readFile(path.join(directory, "inflight.md"), "utf8")).toBe(snapshot)
    await editor.press("Control+End")
    await editor.pressSequentially(" + later edits")
  } finally {
    release()
  }
  await expect(page.getByRole("status")).toHaveText("Saved inflight.md")
  await expect(editor).toHaveValue(edited)
  await expect(pane.getByText("Unsaved", { exact: true })).toBeVisible()
  expect(await readFile(path.join(directory, "inflight.md"), "utf8")).toBe(snapshot)
  await save.click()
  await expect(pane.getByText("Saved", { exact: true })).toBeVisible()
  await expect(page.getByRole("alert")).toBeHidden()
  await expect(editor).toHaveValue(edited)
  expect(await readFile(path.join(directory, "inflight.md"), "utf8")).toBe(edited)
})
