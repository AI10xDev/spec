import { test, expect } from "@playwright/test"
import type { Route } from "@playwright/test"
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
    env: { ...process.env, SPEC_WORKSPACE: directory, SPEC_PORT: "0", SPEC_UI_DIR: path.resolve("dist"), SPEC_COMMAND: undefined, SPEC_SSH_TARGET: undefined, SPEC_SSH_WORKSPACE: undefined, SPEC_SSH_KEY: undefined, SPEC_SSH_BINARY: undefined, AZURE_OPENAI_ENDPOINT: undefined, AZURE_OPENAI_API_KEY: undefined, DEPLOYMENT_NAME: undefined, AZURE_OPENAI_API_VERSION: undefined },
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

test.describe("trailing completions", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/config", (route) => route.fulfill({ json: { execution: false, completion: true } }))
    // Every completion is intercepted, including unexpected requests during a failing test.
    await page.route("**/api/completions", (route) => route.fulfill({ json: { suffix: "" } }))
    await page.clock.install()
    await page.clock.pauseAt(new Date(Date.now() + 1000))
    await page.goto(url)
    // A previous completion test may have saved this shared fixture filename.
    await rm(path.join(directory, "completion.md"), { force: true })
    await page.getByRole("textbox", { name: "New filename" }).fill("completion.md")
    await page.getByRole("button", { name: "Create file" }).click()
  })

  test("debounces trailing text for 500ms, accepts one clause with native undo, and dismisses until typing", async ({ page }) => {
    const prefixes: string[] = []
    await page.route("**/api/completions", async (route) => {
      expect(route.request().method()).toBe("POST")
      expect(route.request().headers().authorization).toBe(`Bearer ${new URLSearchParams(new URL(url).hash.slice(1)).get("token")}`)
      prefixes.push(route.request().postDataJSON().prefix)
      await route.fulfill({ json: { suffix: prefixes.length === 1 ? "board," : " files." } })
    })
    const editor = page.getByRole("textbox", { name: "Edit completion.md" })
    const ghost = page.locator(".completion-ghost")
    await expect(page.getByRole("checkbox", { name: "Trailing completions" })).toBeChecked()
    await editor.fill("Build a das")
    await page.clock.runFor(400)
    expect(prefixes).toEqual([])
    await editor.pressSequentially("h")
    await page.clock.runFor(499)
    expect(prefixes).toEqual([])
    await expect(ghost).toHaveText("")
    await page.clock.runFor(1)
    await expect(ghost).toHaveText("board,")
    await expect(ghost).toBeVisible()
    expect(prefixes).toEqual(["Build a dash"])
    await expect(editor).toHaveValue("Build a dash")
    await expect(page.locator(".toolbar")).toContainText("1 lines · 12 bytes")
    await expect(page.locator(".completion-mirror")).toHaveAttribute("aria-hidden", "true")
    await editor.press("Tab")
    await expect(editor).toBeFocused()
    await expect(editor).toHaveValue("Build a dashboard,")
    await expect(ghost).toHaveText("")
    await page.clock.runFor(1500)
    expect(prefixes).toHaveLength(1)
    await editor.press("Control+z")
    await expect(editor).toHaveValue("Build a dash")
    await editor.press("Control+Shift+z")
    await expect(editor).toHaveValue("Build a dashboard,")
    await editor.pressSequentially(" then sync")
    await page.clock.runFor(500)
    await expect(ghost).toHaveText(" files.")
    expect(prefixes).toEqual(["Build a dash", "Build a dashboard, then sync"])
    await editor.press("Escape")
    await page.getByRole("textbox", { name: "Filter files" }).focus()
    await editor.focus()
    await editor.press("ArrowLeft")
    await editor.press("End")
    await page.clock.runFor(2000)
    await expect(ghost).toHaveText("")
    await expect(editor).toHaveValue("Build a dashboard, then sync")
    expect(prefixes).toHaveLength(2)
    await editor.pressSequentially(" more")
    await page.clock.runFor(500)
    await expect(ghost).toHaveText(" files.")
    expect(prefixes).toEqual(["Build a dash", "Build a dashboard, then sync", "Build a dashboard, then sync more"])
  })

  test("accepts unpunctuated parts once and resumes only after another edit", async ({ page }) => {
    const prefixes: string[] = []
    await page.route("**/api/completions", async (route) => {
      prefixes.push(route.request().postDataJSON().prefix)
      await route.fulfill({ json: { suffix: prefixes.length === 1 ? " a dashboard" : " files" } })
    })
    const editor = page.getByRole("textbox", { name: "Edit completion.md" })
    const ghost = page.locator(".completion-ghost")
    await expect(editor).toHaveValue("")
    await editor.fill("Build")
    await page.clock.runFor(500)
    await expect(ghost).toHaveText(" a dashboard")
    await editor.press("Tab")
    await expect(editor).toHaveValue("Build a dashboard")
    await page.clock.runFor(1500)
    await expect(ghost).toHaveText("")
    expect(prefixes).toEqual(["Build"])
    await editor.pressSequentially(", then sync")
    await page.clock.runFor(500)
    await expect(ghost).toHaveText(" files")
    await page.getByRole("button", { name: "Accept part", exact: true }).click()
    await expect(editor).toHaveValue("Build a dashboard, then sync files")
    await page.clock.runFor(1500)
    await expect(ghost).toHaveText("")
    expect(prefixes).toEqual(["Build", "Build a dashboard, then sync"])
  })

  test("completes opened CRLF files without changing saved content before acceptance", async ({ page }) => {
    const content = "First line\r\nBuild"
    const normalized = "First line\nBuild"
    const response = await page.request.put(new URL("/api/files/completion-crlf.md", url).href, {
      headers: { Authorization: `Bearer ${new URLSearchParams(new URL(url).hash.slice(1)).get("token")}` },
      data: { content, revision: null },
    })
    expect(response.ok()).toBe(true)
    const prefixes: string[] = []
    await page.route("**/api/completions", async (route) => {
      prefixes.push(route.request().postDataJSON().prefix)
      await route.fulfill({ json: { suffix: " a tool." } })
    })
    await page.getByRole("button", { name: "Refresh file list" }).click()
    await page.getByRole("tabpanel").getByRole("button", { name: /completion-crlf\.md/ }).click()
    const editor = page.getByRole("textbox", { name: "Edit completion-crlf.md" })
    await editor.focus()
    await editor.press("Control+End")
    await page.clock.runFor(500)
    await expect(page.locator(".completion-ghost")).toHaveText(" a tool.")
    expect(prefixes).toEqual([normalized])
    await expect(page.locator(".completion-mirror")).toHaveText(`${normalized} a tool.\n`)
    await expect(page.getByRole("region", { name: "Spec editing pane" }).getByText("Saved", { exact: true })).toBeVisible()
    await editor.press("Control+s")
    await expect(page.getByRole("status")).toHaveText("Saved completion-crlf.md")
    expect(await readFile(path.join(directory, "completion-crlf.md"), "utf8")).toBe(content)
    await editor.press("Tab")
    await expect(editor).toHaveValue(`${normalized} a tool.`)
    await editor.press("Control+s")
    await expect(page.getByRole("region", { name: "Spec editing pane" }).getByText("Saved", { exact: true })).toBeVisible()
    expect(await readFile(path.join(directory, "completion-crlf.md"), "utf8")).toBe(`${normalized} a tool.`)
  })

  test("ignores responses from before edits, caret movement, and a tab switch", async ({ page }) => {
    const requests: Route[] = []
    await page.route("**/api/completions", (route) => { requests.push(route) })
    const original = page.getByRole("textbox", { name: "Edit completion.md" })
    const ghost = page.locator(".completion-ghost")
    for (const change of ["edit", "caret", "tab"]) {
      await test.step(change, async () => {
        const count = requests.length
        const text = `Build a ${change} draft`
        await original.fill(text)
        await page.clock.runFor(500)
        await expect.poll(() => requests.length).toBe(count + 1)
        let active = original
        if (change === "edit") await original.fill(`${text} again`)
        if (change === "caret") {
          await original.press("ArrowLeft")
          await page.clock.runFor(1000)
          expect(requests).toHaveLength(count + 1)
          await expect(ghost).toHaveText("")
          await original.press("End")
        }
        if (change === "tab") {
          await page.getByRole("textbox", { name: "New filename" }).fill("completion-other.md")
          await page.getByRole("button", { name: "Create file" }).click()
          active = page.getByRole("textbox", { name: "Edit completion-other.md" })
          // Identical buffers ensure a response cannot be validated by text alone.
          await active.fill(text)
        }
        await page.clock.runFor(500)
        await expect.poll(() => requests.length).toBe(count + 2)
        await requests[count + 1].fulfill({ json: { suffix: " fresh," } })
        await expect(ghost).toHaveText(" fresh,")
        await requests[count].fulfill({ json: { suffix: " STALE." } })
        await page.clock.runFor(1000)
        await expect(ghost).toHaveText(" fresh,")
        await expect(active).toHaveValue(change === "edit" ? `${text} again` : text)
        expect(requests).toHaveLength(count + 2)
        if (change === "tab") {
          await page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button", { name: /^completion\.md/ }).click()
          await expect(original).toHaveValue(text)
          await expect(ghost).toHaveText("")
        }
      })
    }
  })

  test("suppresses selections and IME, trails only line ends, and bounds Unicode context", async ({ page }) => {
    const prefixes: string[] = []
    await page.route("**/api/completions", async (route) => {
      prefixes.push(route.request().postDataJSON().prefix)
      await route.fulfill({ json: { suffix: " complete," } })
    })
    const editor = page.getByRole("textbox", { name: "Edit completion.md" })
    const ghost = page.locator(".completion-ghost")
    const text = "First line\nKeep this line"
    await editor.fill(text)
    await editor.press("Shift+ArrowLeft")
    await page.clock.runFor(1000)
    expect(prefixes).toEqual([])
    await expect(ghost).toHaveText("")
    await editor.press("Control+Home")
    await editor.press("ArrowRight")
    await page.clock.runFor(1000)
    expect(prefixes).toEqual([])
    await editor.press("End")
    await page.clock.runFor(500)
    await expect(ghost).toHaveText(" complete,")
    expect(prefixes).toEqual(["First line"])
    await expect(editor).toHaveValue(text)
    await editor.press("Shift+ArrowLeft")
    await expect(ghost).toHaveText("")
    await page.clock.runFor(1000)
    expect(prefixes).toHaveLength(1)

    await editor.press("Control+End")
    await editor.dispatchEvent("compositionstart", { data: "" })
    await editor.pressSequentially(" input")
    await page.clock.runFor(1000)
    await expect(ghost).toHaveText("")
    expect(prefixes).toHaveLength(1)
    await editor.dispatchEvent("compositionend", { data: "input" })
    await page.clock.runFor(500)
    await expect(ghost).toHaveText(" complete,")
    expect(prefixes).toEqual(["First line", `${text} input`])

    const longText = "\u{1F600}".repeat(6000) + " Addx"
    await editor.fill(longText)
    await page.clock.runFor(500)
    await expect.poll(() => prefixes.length).toBe(3)
    expect(prefixes[2]).toBe("\u{1F600}".repeat(1997) + " Addx")
    expect(prefixes[2].length).toBeLessThanOrEqual(4000)
    expect(new TextEncoder().encode(prefixes[2]).length).toBeLessThanOrEqual(16 * 1024)
    await expect(editor).toHaveValue(longText)
  })

  test("turning completions off removes the ghost and suppresses requests across tabs", async ({ page }) => {
    let requests = 0
    await page.route("**/api/completions", async (route) => {
      requests++
      await route.fulfill({ json: { suffix: " safely." } })
    })
    const editor = page.getByRole("textbox", { name: "Edit completion.md" })
    const checkbox = page.getByRole("checkbox", { name: "Trailing completions" })
    await expect(checkbox).toBeEnabled()
    await expect(checkbox).toBeChecked()
    await editor.fill("Build")
    await page.clock.runFor(500)
    await expect(page.locator(".completion-ghost")).toHaveText(" safely.")
    await checkbox.uncheck()
    await expect(page.getByRole("button", { name: "Accept part" })).toBeHidden()
    await editor.fill("Build without suggestions")
    await page.clock.runFor(1500)
    await expect(page.locator(".completion-ghost")).toHaveText("")
    expect(requests).toBe(1)
    await page.getByRole("textbox", { name: "New filename" }).fill("completion-disabled.md")
    await page.getByRole("button", { name: "Create file" }).click()
    await expect(checkbox).not.toBeChecked()
    const second = page.getByRole("textbox", { name: "Edit completion-disabled.md" })
    await second.fill("Another draft")
    await page.clock.runFor(1000)
    expect(requests).toBe(1)
    await checkbox.check()
    await second.focus()
    await page.clock.runFor(500)
    await expect(page.locator(".completion-ghost")).toHaveText(" safely.")
    expect(requests).toBe(2)
  })

  test("unconfigured completion is disabled and Tab retains normal focus navigation", async ({ page }) => {
    let requests = 0
    await page.route("**/api/config", (route) => route.fulfill({ json: { execution: false, completion: false } }))
    await page.route("**/api/completions", async (route) => {
      requests++
      await route.fulfill({ json: { suffix: " unexpected." } })
    })
    await page.reload()
    await page.getByRole("textbox", { name: "New filename" }).fill("unconfigured.md")
    await page.getByRole("button", { name: "Create file" }).click()
    const checkbox = page.getByRole("checkbox", { name: "Trailing completions" })
    await expect(checkbox).toBeDisabled()
    await expect(checkbox).not.toBeChecked()
    await expect(page.getByText("Azure not configured", { exact: true })).toBeVisible()
    const editor = page.getByRole("textbox", { name: "Edit unconfigured.md" })
    await editor.fill("Still editable")
    await page.clock.runFor(1500)
    expect(requests).toBe(0)
    await expect(page.locator(".completion-ghost")).toHaveText("")
    await editor.press("Tab")
    await expect(page.getByRole("button", { name: "Download", exact: true })).toBeFocused()
    await expect(editor).toHaveValue("Still editable")
  })

  test("mobile ghost is one clipped visual line and Accept part preserves the buffer until clicked", async ({ page }) => {
    const suffix = " a deliberately long suggestion".repeat(20) + ","
    let requests = 0
    await page.route("**/api/completions", async (route) => {
      requests++
      await route.fulfill({ json: { suffix } })
    })
    await page.setViewportSize({ width: 320, height: 740 })
    const editor = page.getByRole("textbox", { name: "Edit completion.md" })
    await editor.fill("Build")
    const before = await editor.evaluate((node: HTMLTextAreaElement) => node.scrollTop)
    await page.clock.runFor(500)
    const ghost = page.locator(".completion-ghost")
    await expect(ghost).toHaveText(suffix)
    await expect(ghost).toHaveCSS("white-space", "pre")
    await expect(page.locator(".editor-input")).toHaveCSS("overflow", "hidden")
    const box = (await ghost.boundingBox())!
    const inputBox = (await editor.boundingBox())!
    expect(box.height).toBeLessThanOrEqual(await editor.evaluate((node) => parseFloat(getComputedStyle(node).lineHeight)))
    expect(box.x + box.width).toBeGreaterThan(inputBox.x + inputBox.width)
    expect(await editor.evaluate((node: HTMLTextAreaElement) => node.scrollTop)).toBe(before)
    expect(await editor.evaluate((node: HTMLTextAreaElement) => node.scrollWidth <= node.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expect(editor).toHaveValue("Build")
    const accept = page.getByRole("button", { name: "Accept part", exact: true })
    await accept.scrollIntoViewIfNeeded()
    await expect(accept).toBeInViewport()
    await accept.click()
    await expect(editor).toHaveValue(`Build${suffix}`)
    await expect(editor).toBeFocused()
    await expect(accept).toBeHidden()
    await page.clock.runFor(1000)
    expect(requests).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test("wrapped and scrolled ghost aligns with text and remains outside saved content", async ({ page }, testInfo) => {
    await page.route("**/api/completions", (route) => route.fulfill({ json: { suffix: "board," } }))
    const editor = page.getByRole("textbox", { name: "Edit completion.md" })
    const content = "Earlier line\n".repeat(40) + "Some wrapping context ".repeat(8) + "dash"
    await editor.fill(content)
    await editor.press("Control+End")
    await page.clock.runFor(500)
    await expect(page.locator(".completion-ghost")).toHaveText("board,")
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      // End at an unchanged caret does not scroll it back into view after resize.
      await editor.press("Control+Home")
      await editor.press("Control+End")
      await page.clock.runFor(500)
      await expect(page.locator(".completion-ghost")).toHaveText("board,")
      const alignment = await page.locator(".completion-mirror").evaluate((node) => {
        const prefix = node.firstChild!
        const ghost = node.querySelector(".completion-ghost")!.firstChild!
        const before = document.createRange()
        before.setStart(prefix, prefix.textContent!.length - 1)
        before.setEnd(prefix, prefix.textContent!.length)
        const after = document.createRange()
        after.selectNodeContents(ghost)
        const typed = before.getBoundingClientRect()
        const suggested = after.getBoundingClientRect()
        const viewport = node.getBoundingClientRect()
        return { dy: suggested.y - typed.y, dx: suggested.x - typed.right, scroll: node.scrollTop, top: suggested.top, bottom: suggested.bottom, viewportTop: viewport.top, viewportBottom: viewport.bottom }
      })
      expect(Math.abs(alignment.dy)).toBeLessThanOrEqual(1)
      expect(Math.abs(alignment.dx)).toBeLessThanOrEqual(1)
      expect(alignment.scroll).toBeGreaterThan(0)
      expect(alignment.scroll).toBe(await editor.evaluate((node: HTMLTextAreaElement) => node.scrollTop))
      expect(alignment.top, `ghost top at ${width}px`).toBeGreaterThanOrEqual(alignment.viewportTop)
      expect(alignment.bottom, `ghost bottom at ${width}px`).toBeLessThanOrEqual(alignment.viewportBottom)
      await page.screenshot({ path: testInfo.outputPath(`completion-${width}.png`), fullPage: true })
    }
    await editor.press("Control+s")
    await expect(page.getByRole("status")).toHaveText("Saved completion.md")
    expect(await readFile(path.join(directory, "completion.md"), "utf8")).toBe(content)
    await editor.press("Escape")
  })

  test("provider errors and empty suggestions keep editing and Tab usable, then retry on typing", async ({ page }) => {
    const prefixes: string[] = []
    await page.route("**/api/completions", async (route) => {
      prefixes.push(route.request().postDataJSON().prefix)
      await route.fulfill(prefixes.length === 1
        ? { status: 503, json: { error: "Mock provider unavailable" } }
        : { json: { suffix: prefixes.length === 2 ? "" : " successfully." } })
    })
    const editor = page.getByRole("textbox", { name: "Edit completion.md" })
    const ghost = page.locator(".completion-ghost")
    await editor.fill("Retry")
    await page.clock.runFor(500)
    await expect(page.getByText("Completion unavailable. Continue typing to retry.", { exact: true })).toBeVisible()
    await expect(page.getByRole("alert")).toBeHidden()
    await expect(ghost).toHaveText("")
    await expect(editor).toHaveValue("Retry")
    await page.clock.runFor(2000)
    expect(prefixes).toEqual(["Retry"])
    await editor.pressSequentially(" again")
    await page.clock.runFor(500)
    await expect.poll(() => prefixes.length).toBe(2)
    await expect(page.locator("#completion-help")).toHaveText("One sentence part at a time")
    await expect(ghost).toHaveText("")
    await editor.press("Tab")
    await expect(page.getByRole("button", { name: "Download", exact: true })).toBeFocused()
    await expect(editor).toHaveValue("Retry again")
    await editor.focus()
    await editor.pressSequentially(" now")
    await page.clock.runFor(500)
    await expect(ghost).toHaveText(" successfully.")
    expect(prefixes).toEqual(["Retry", "Retry again", "Retry again now"])
    await expect(editor).toHaveValue("Retry again now")
  })
})
