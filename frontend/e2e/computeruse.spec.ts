import { test as base, expect } from "@playwright/test"
import type { Page } from "@playwright/test"
import { spawn } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"

type Mutation = { path: string; method: string; body: unknown }
type Bridge = { workspace: string; local: string; remote: string; launches: string; mutations: Mutation[] }

const test = base.extend<{ bridge: Bridge }>({
  bridge: async ({ page, context }, use) => {
    const directory = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "spec-computeruse-e2e-"))
    const workspace = path.join(directory, "workspace")
    const local = path.join(directory, "local instructions.txt")
    const remote = path.join(directory, "remote instructions.txt")
    const launches = path.join(directory, "launches.jsonl")
    const ssh = path.join(directory, "ssh-fixture")
    const callback = path.join(directory, "callback.cjs")
    await mkdir(workspace, { mode: 0o700 })
    // The SSH transport only executes the backend's helper inside this temporary fixture.
    await writeFile(ssh, '#!/bin/bash\nexec /bin/bash -c "${!#}"\n')
    await chmod(ssh, 0o700)
    await writeFile(callback, `const fs = require("node:fs")
const content = fs.readFileSync(process.argv[2], "utf8")
fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify(content) + "\\n")
process.stdout.write("fixture stdout: " + content + "\\n" + "x".repeat(600) + "\\n")
process.stderr.write("fixture stderr: no desktop actions\\n")
setInterval(() => {}, 1000)
setTimeout(() => process.exit(2), 60000)
`)
    const server = spawn(path.resolve("../backend/target/debug/spec"), [], {
      cwd: path.resolve("../backend"),
      // Do not inherit any operator SSH, model, or computeruse configuration.
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        SPEC_WORKSPACE: workspace,
        SPEC_PORT: "0",
        SPEC_UI_DIR: path.resolve("dist"),
        SPEC_AI_ENV_FILE: "/dev/null",
        SPEC_SSH_TARGET: "fixture@host",
        SPEC_SSH_WORKSPACE: workspace,
        SPEC_SSH_BINARY: ssh,
        SPEC_COMPUTERUSE_LOCAL_FILE: local,
        SPEC_COMPUTERUSE_REMOTE_FILE: remote,
        SPEC_COMPUTERUSE_COMMAND: JSON.stringify([process.execPath, callback, "{instructions}"]),
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let diagnostics = ""
    server.stderr!.on("data", (chunk: Buffer) => { diagnostics += chunk.toString() })
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Rust server did not start: ${diagnostics}`)), 10_000)
        let output = ""
        server.stdout!.on("data", (chunk: Buffer) => {
          output += chunk.toString()
          const match = output.match(/Spec: (http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+)/)
          if (match) { clearTimeout(timer); resolve(match[1]) }
        })
        server.once("error", (error) => { clearTimeout(timer); reject(error) })
        server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${diagnostics}`)) })
      })
      await context.route("**/api/config", async (route) => {
        const response = await route.fetch()
        await route.fulfill({ response, json: { ...await response.json(), execution: false } })
      })
      await context.route("**/api/performance", (route) => route.fulfill({ json: null }))
      await context.route("**/api/performance/runs", (route) => route.fulfill({ json: [] }))
      await context.route(/\/api\/runs(?:\/|$)/, (route) => route.request().method() === "GET"
        ? route.continue()
        : route.fulfill({ status: 503, json: { error: "Normal build intercepted by fixture" } }))
      const mutations: Mutation[] = []
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("request", (request) => {
        if (request.url().includes("/api/") && request.method() !== "GET") {
          mutations.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postDataJSON() })
        }
      })
      await page.clock.install()
      await page.clock.pauseAt(new Date(Date.now() + 1000))
      await page.goto(url)
      await page.getByRole("textbox", { name: "New filename" }).fill("instructions.md")
      await page.getByRole("button", { name: "Create file" }).click()
      await expect(page.getByRole("button", { name: "Computeruse: off", exact: true })).toBeEnabled()
      await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
      await use({ workspace, local, remote, launches, mutations })
      expect(errors).toEqual([])
    } finally {
      if (server.exitCode === null && server.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => server.kill("SIGKILL"), 10_000)
          server.once("exit", () => { clearTimeout(timer); resolve() })
          server.kill("SIGTERM")
        })
      }
      await rm(directory, { recursive: true, force: true })
    }
  },
})

async function enable(page: Page, content = "Initial shared instructions\n") {
  await page.getByRole("textbox", { name: "Edit instructions.md", exact: true }).fill(content)
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Computeruse: off", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("No callback executed.")
  await expect(page.getByRole("button", { name: "Computeruse: on", exact: true })).toHaveAttribute("aria-pressed", "true")
}

async function holdResponse(page: Page, pattern: string) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let received!: () => void
  const pending = new Promise<void>((resolve) => { received = resolve })
  await page.route(pattern, async (route) => {
    const response = await route.fetch()
    received()
    await gate
    await route.fulfill({ response })
  }, { times: 1 })
  return { pending, release }
}

test("enabling replaces remote text with the exact saved snapshot, without a callback", async ({ page, bridge }) => {
  await writeFile(bridge.remote, "Existing remote text\n")
  const snapshot = "  Keep spacing\n\tand tabs, quotes: \"text\"; UTF-8: \u00e9\n\n"
  const editor = page.getByRole("textbox", { name: "Edit instructions.md", exact: true })
  await editor.fill(snapshot)
  const held = await holdResponse(page, "**/api/files/instructions.md")
  const confirmation = page.waitForEvent("dialog")
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Computeruse: off", exact: true }).click()
  expect((await confirmation).message()).toContain("replaces the current remote text")
  await held.pending
  try {
    await editor.fill("Typed while saving; do not share this yet.")
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
    expect(bridge.mutations.map((item) => item.path)).toEqual(["/api/files/instructions.md"])
  } finally { held.release() }
  await expect(page.getByRole("status")).toContainText("No callback executed.")
  for (const file of [path.join(bridge.workspace, "instructions.md"), bridge.local, bridge.remote]) {
    expect(await readFile(file, "utf8")).toBe(snapshot)
  }
  await expect(editor).toHaveValue("Typed while saving; do not share this yet.")
  await expect(page.getByRole("button", { name: "Reload remote" })).toBeDisabled()
  expect(bridge.mutations.map((item) => item.path)).toEqual(["/api/files/instructions.md", "/api/computeruse/push"])
  await expect(readFile(bridge.launches, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
})

test("manual Save syncs both mirrors, but debounced autosave only saves the editor file", async ({ page, bridge }) => {
  await enable(page)
  const editor = page.getByRole("textbox", { name: "Edit instructions.md", exact: true })
  bridge.mutations.length = 0
  await editor.fill("Autosaved locally\n")
  await page.clock.runFor(499)
  expect(bridge.mutations).toEqual([])
  await page.clock.runFor(1)
  await expect(page.getByRole("status")).toHaveText("Saved instructions.md")
  expect(await readFile(path.join(bridge.workspace, "instructions.md"), "utf8")).toBe("Autosaved locally\n")
  expect(await readFile(bridge.local, "utf8")).toBe("Initial shared instructions\n")
  expect(await readFile(bridge.remote, "utf8")).toBe("Initial shared instructions\n")
  expect(bridge.mutations.map((item) => item.path)).toEqual(["/api/files/instructions.md"])
  await editor.fill("Explicit Save snapshot\n")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("No callback executed.")
  await page.clock.runFor(2000)
  expect(await readFile(bridge.local, "utf8")).toBe("Explicit Save snapshot\n")
  expect(await readFile(bridge.remote, "utf8")).toBe("Explicit Save snapshot\n")
  expect(bridge.mutations.map((item) => item.path)).toEqual(["/api/files/instructions.md", "/api/files/instructions.md", "/api/computeruse/push"])
  await expect(readFile(bridge.launches, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
})

test("enabling locks the origin tab during remote lookup and cancellation releases it without saving discarded text", async ({ page, bridge }) => {
  const tabs = page.getByRole("navigation", { name: "Editor tabs" })
  const editor = page.getByRole("textbox", { name: "Edit instructions.md", exact: true })
  const close = page.getByRole("button", { name: "Close instructions.md", exact: true })
  await editor.fill("Origin draft that must never be resurrected")
  await page.getByRole("textbox", { name: "New filename" }).fill("other.md")
  await page.getByRole("button", { name: "Create file" }).click()
  await tabs.getByRole("button", { name: /^instructions\.md/ }).click()
  const held = await holdResponse(page, "**/api/computeruse/file")
  const confirmation = page.waitForEvent("dialog")
  page.once("dialog", (dialog) => dialog.dismiss())
  await page.getByRole("button", { name: "Computeruse: off", exact: true }).click()
  await held.pending
  try {
    await expect(close).toBeDisabled()
    await tabs.getByRole("button", { name: /^other\.md/ }).click()
    await expect(close).toBeDisabled()
    await expect(page.getByRole("button", { name: "Close other.md", exact: true })).toBeEnabled()
    await tabs.getByRole("button", { name: /^instructions\.md/ }).click()
    await expect(editor).toHaveValue("Origin draft that must never be resurrected")
    await expect(close).toBeDisabled()
    await tabs.getByRole("button", { name: /^other\.md/ }).click()
    expect(bridge.mutations).toEqual([])
  } finally { held.release() }
  expect((await confirmation).message()).toContain("Enable computeruse for instructions.md")
  await expect(close).toBeEnabled()
  await expect(page.getByRole("textbox", { name: "Edit other.md", exact: true })).toHaveValue("")
  page.once("dialog", (dialog) => dialog.accept())
  await close.click()
  await expect(close).toHaveCount(0)
  await page.clock.runFor(2000)
  await expect(close).toHaveCount(0)
  await page.getByRole("textbox", { name: "New filename" }).fill("instructions.md")
  await page.getByRole("button", { name: "Create file" }).click()
  await expect(editor).toHaveValue("")
  await expect(page.getByRole("button", { name: "Computeruse: off", exact: true })).toHaveAttribute("aria-pressed", "false")
  expect(bridge.mutations).toEqual([])
  for (const file of [path.join(bridge.workspace, "instructions.md"), bridge.local, bridge.remote, bridge.launches]) {
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  }
})

for (const action of ["button", "Control+Enter"] as const) {
  test(`${action} runs only computeruse with the acknowledged saved revision`, async ({ page, bridge }) => {
    await enable(page)
    bridge.mutations.length = 0
    const editor = page.getByRole("textbox", { name: "Edit instructions.md", exact: true })
    const snapshot = `Callback snapshot from ${action}\n`
    await editor.fill(snapshot)
    const held = await holdResponse(page, "**/api/files/instructions.md")
    const saved = page.waitForResponse((response) => response.url().endsWith("/api/files/instructions.md") && response.request().method() === "PUT")
    const confirmation = page.waitForEvent("dialog")
    page.once("dialog", (dialog) => dialog.accept())
    if (action === "button") await page.getByRole("button", { name: "Save & run" }).click()
    else await editor.press(action)
    const dialog = await confirmation
    expect(dialog.type()).toBe("confirm")
    expect(dialog.message()).toContain("launch the configured computeruse callback")
    expect(dialog.message()).toContain("incur costs")
    expect(dialog.message()).toContain("does not run a remote spec build")
    await held.pending
    try {
      await editor.fill("Later edit must not reach the callback.")
      expect(bridge.mutations.map((item) => item.path)).toEqual(["/api/files/instructions.md"])
    } finally { held.release() }
    const document = await (await saved).json()
    await expect(page.getByRole("status")).toContainText("started the local computeruse callback")
    expect(bridge.mutations).toEqual([
      { path: "/api/files/instructions.md", method: "PUT", body: { content: snapshot, revision: expect.any(String) } },
      { path: "/api/computeruse/run", method: "POST", body: { name: "instructions.md", revision: document.revision, remote_revision: expect.any(String) } },
    ])
    expect(document.content).toBe(snapshot)
    await expect.poll(() => readFile(bridge.launches, "utf8").catch(() => "")).toBe(JSON.stringify(snapshot) + "\n")
    expect(await readFile(bridge.remote, "utf8")).toBe(snapshot)
    expect(await readFile(bridge.local, "utf8")).toBe(snapshot)
    await expect(editor).toHaveValue("Later edit must not reach the callback.")
    await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
    await editor.press("Control+Enter")
    expect(bridge.mutations).toHaveLength(2)
  })
}

test("cancelled enable, run and reload confirmations perform no writes or launches", async ({ page, bridge }) => {
  const editor = page.getByRole("textbox", { name: "Edit instructions.md", exact: true })
  await editor.fill("Unconfirmed snapshot")
  const confirmation = page.waitForEvent("dialog")
  page.once("dialog", (dialog) => dialog.dismiss())
  await page.getByRole("button", { name: "Computeruse: off", exact: true }).click()
  expect((await confirmation).message()).toContain("remote text file will be created")
  await expect(page.getByRole("button", { name: "Computeruse: off", exact: true })).toBeEnabled()
  expect(bridge.mutations).toEqual([])
  for (const file of [path.join(bridge.workspace, "instructions.md"), bridge.local, bridge.remote, bridge.launches]) {
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  }
  await enable(page)
  bridge.mutations.length = 0
  page.once("dialog", (dialog) => dialog.dismiss())
  await page.getByRole("button", { name: "Reload remote" }).click()
  await editor.fill("Cancelled run edits")
  for (const action of ["button", "Control+Enter"]) {
    page.once("dialog", (dialog) => dialog.dismiss())
    if (action === "button") await page.getByRole("button", { name: "Save & run" }).click()
    else await editor.press(action)
  }
  expect(bridge.mutations).toEqual([])
  await expect(editor).toHaveValue("Cancelled run edits")
  for (const file of [path.join(bridge.workspace, "instructions.md"), bridge.local, bridge.remote]) {
    expect(await readFile(file, "utf8")).toBe("Initial shared instructions\n")
  }
  await expect(readFile(bridge.launches, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
})

test("Reload remote imports clean text but preserves edits typed during an in-flight pull", async ({ page, bridge }) => {
  await enable(page)
  const editor = page.getByRole("textbox", { name: "Edit instructions.md", exact: true })
  const reload = page.getByRole("button", { name: "Reload remote" })
  await editor.fill("Dirty local text")
  await expect(reload).toBeDisabled()
  await editor.fill("Initial shared instructions\n")
  await expect(reload).toBeEnabled()
  await writeFile(bridge.remote, "First remote revision\n")
  page.once("dialog", (dialog) => dialog.accept())
  await reload.click()
  await expect(editor).toHaveValue("First remote revision\n")
  await expect(reload).toBeEnabled()
  expect(await readFile(bridge.local, "utf8")).toBe("First remote revision\n")
  await writeFile(bridge.remote, "Second remote revision\n")
  const held = await holdResponse(page, "**/api/computeruse/pull")
  page.once("dialog", (dialog) => dialog.accept())
  await reload.click()
  await held.pending
  try {
    await editor.fill("Typed during remote reload\n")
    await expect(reload).toBeDisabled()
  } finally { held.release() }
  await expect(page.getByRole("status")).toContainText("Loaded remote text")
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled()
  await expect(editor).toHaveValue("Typed during remote reload\n")
  await expect(reload).toBeDisabled()
  expect(await readFile(path.join(bridge.workspace, "instructions.md"), "utf8")).toBe("Second remote revision\n")
  expect(await readFile(bridge.local, "utf8")).toBe("Second remote revision\n")
  // Saving the retained buffer must use the pulled editor and remote revisions.
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("No callback executed.")
  await expect(page.getByRole("alert")).toBeHidden()
  expect(await readFile(bridge.remote, "utf8")).toBe("Typed during remote reload\n")
  expect(bridge.mutations.filter((item) => /\/run(?:s|$)/.test(item.path))).toEqual([])
  await expect(readFile(bridge.launches, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
})

for (const failure of ["conflict", "unavailable"] as const) {
  test(`a ${failure} editor save never syncs or launches a callback`, async ({ page, bridge }) => {
    await enable(page)
    if (failure === "conflict") await writeFile(path.join(bridge.workspace, "instructions.md"), "External editor change\n")
    else await page.route("**/api/files/instructions.md", (route) => route.fulfill({ status: 503, json: { error: "Fixture save unavailable" } }), { times: 1 })
    bridge.mutations.length = 0
    await page.getByRole("textbox", { name: "Edit instructions.md", exact: true }).fill("Keep failed save edits\n")
    const rejected = page.waitForResponse((response) => response.url().endsWith("/api/files/instructions.md") && response.request().method() === "PUT")
    page.once("dialog", (dialog) => dialog.accept())
    await page.getByRole("button", { name: "Save & run" }).click()
    expect((await rejected).status()).toBe(failure === "conflict" ? 409 : 503)
    await expect(page.getByRole("alert")).toContainText(failure === "conflict" ? "File changed on disk" : "Fixture save unavailable")
    await page.clock.runFor(2000)
    expect(bridge.mutations.map((item) => item.path)).toEqual(["/api/files/instructions.md"])
    await expect(page.getByRole("textbox", { name: "Edit instructions.md", exact: true })).toHaveValue("Keep failed save edits\n")
    expect(await readFile(bridge.local, "utf8")).toBe("Initial shared instructions\n")
    expect(await readFile(bridge.remote, "utf8")).toBe("Initial shared instructions\n")
    await expect(readFile(bridge.launches, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })
}

test("a stale remote revision reports a conflict without launching or falling back to a build", async ({ page, bridge }) => {
  await enable(page)
  await writeFile(bridge.remote, "External remote change\n")
  bridge.mutations.length = 0
  await page.getByRole("textbox", { name: "Edit instructions.md", exact: true }).fill("Saved but not shared\n")
  const rejected = page.waitForResponse((response) => response.url().endsWith("/api/computeruse/run"))
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Save & run" }).click()
  expect((await rejected).status()).toBe(409)
  await expect(page.getByRole("alert")).toContainText("No callback executed")
  expect(bridge.mutations.map((item) => item.path)).toEqual(["/api/files/instructions.md", "/api/computeruse/run"])
  expect(await readFile(path.join(bridge.workspace, "instructions.md"), "utf8")).toBe("Saved but not shared\n")
  expect(await readFile(bridge.remote, "utf8")).toBe("External remote change\n")
  expect(await readFile(bridge.local, "utf8")).toBe("Initial shared instructions\n")
  await expect(readFile(bridge.launches, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  await expect(page.getByRole("button", { name: "Stop computeruse" })).toBeHidden()
})

test("mode is scoped to its tab; disabling and page reload restore normal Save and run routing", async ({ page, bridge }) => {
  await enable(page)
  await page.getByRole("textbox", { name: "New filename" }).fill("other.md")
  await page.getByRole("button", { name: "Create file" }).click()
  await expect(page.getByRole("button", { name: "Computeruse: off", exact: true })).toHaveAttribute("aria-pressed", "false")
  await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
  bridge.mutations.length = 0
  await page.getByRole("textbox", { name: "Edit other.md", exact: true }).fill("Other tab local save")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("Saved other.md")
  expect(bridge.mutations.map((item) => item.path)).toEqual(["/api/files/other.md"])
  const tabs = page.getByRole("navigation", { name: "Editor tabs" })
  await tabs.getByRole("button", { name: "instructions.md", exact: true }).click()
  await expect(page.getByRole("button", { name: "Computeruse: on", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Computeruse: on", exact: true }).click()
  await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
  bridge.mutations.length = 0
  const editor = page.getByRole("textbox", { name: "Edit instructions.md", exact: true })
  await editor.fill("Normal local save")
  await editor.press("Control+Enter")
  expect(bridge.mutations).toEqual([])
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("Saved instructions.md")
  expect(bridge.mutations.map((item) => item.path)).toEqual(["/api/files/instructions.md"])
  expect(await readFile(bridge.remote, "utf8")).toBe("Initial shared instructions\n")

  // Advertise normal execution only here; the fixture intercepts every /runs mutation.
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...await response.json(), execution: true } })
  })
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(page.getByRole("button", { name: "Save & run" })).toBeEnabled()
  bridge.mutations.length = 0
  page.once("dialog", (dialog) => dialog.accept())
  await editor.press("Control+Enter")
  await expect(page.getByRole("alert")).toContainText("Normal build intercepted by fixture")
  expect(bridge.mutations.map((item) => item.path)).toEqual(["/api/files/instructions.md", "/api/runs"])
  await enable(page, "Shared before page reload")
  await page.reload()
  await expect(editor).toHaveValue("Shared before page reload")
  await expect(page.getByRole("button", { name: "Computeruse: off", exact: true })).toHaveAttribute("aria-pressed", "false")
  await expect(page.getByRole("button", { name: "Save & run" })).toHaveAttribute("title", "Save & run (Ctrl/Cmd+Enter)")
  await expect(readFile(bridge.launches, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
})

test("a prelaunch status poll cannot replace an acknowledged callback or hide its Stop control", async ({ page, bridge }) => {
  const snapshot = "Callback associated with the newer run\n"
  await enable(page, snapshot)
  bridge.mutations.length = 0
  const panel = page.getByRole("region", { name: "Computeruse shared files" })
  const stop = page.getByRole("button", { name: "Stop computeruse" })
  const runButton = page.getByRole("button", { name: "Save & run" })
  const held = await holdResponse(page, "**/api/computeruse")
  const stale = page.waitForResponse((response) => response.url().endsWith("/api/computeruse") && response.request().method() === "GET")
  await page.clock.runFor(1500)
  await held.pending
  let run: { id: string; name: string; output: string }
  try {
    const started = page.waitForResponse((response) => response.url().endsWith("/api/computeruse/run"))
    page.once("dialog", (dialog) => dialog.accept())
    await runButton.click()
    run = (await (await started).json()).run
    await expect(page.getByRole("status")).toContainText("started the local computeruse callback")
    await expect(stop).toBeVisible()
    await expect(runButton).toBeDisabled()
    await expect.poll(() => readFile(bridge.launches, "utf8").catch(() => "")).toBe(JSON.stringify(snapshot) + "\n")
  } finally { held.release() }
  expect(await (await stale).json()).toMatchObject({ configured: true, run: null })
  await (await stale).finished()

  // A subsequent poll proves the stale response was processed. Hold it too so it
  // cannot repair a regressed UI before the assertions below observe it.
  const fresh = await holdResponse(page, "**/api/computeruse")
  await page.clock.runFor(1600)
  await fresh.pending
  try {
    await expect(stop).toBeVisible()
    await expect(runButton).toBeDisabled()
    await expect(panel).toContainText(`Local callback / ${run.name} / running`)
    await expect(page.getByLabel("Computeruse output")).toHaveText(run.output)
    await page.getByRole("textbox", { name: "Edit instructions.md", exact: true }).press("Control+Enter")
    expect(bridge.mutations.map((item) => item.path)).toEqual(["/api/files/instructions.md", "/api/computeruse/run"])
  } finally { fresh.release() }
  await expect(page.getByLabel("Computeruse output")).toContainText(`fixture stdout: ${snapshot.trimEnd()}`)
  const cancelled = page.waitForResponse((response) => response.url().endsWith(`/api/computeruse/runs/${run.id}/cancel`))
  await stop.click()
  expect((await cancelled).ok()).toBe(true)
  expect(await readFile(bridge.launches, "utf8")).toBe(JSON.stringify(snapshot) + "\n")
})

test("callback status, output, polling failure and stop remain safe and fit mobile screens", async ({ page, bridge }) => {
  await enable(page)
  const panel = page.getByRole("region", { name: "Computeruse shared files" })
  await page.route("**/api/computeruse", (route) => route.fulfill({ status: 503, json: { error: "Fixture status unavailable" } }), { times: 1 })
  await page.clock.runFor(1500)
  await expect(panel.getByRole("alert")).toContainText("Local callback status unavailable")
  await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
  bridge.mutations.length = 0
  await page.getByRole("textbox", { name: "Edit instructions.md", exact: true }).press("Control+Enter")
  expect(bridge.mutations).toEqual([])
  await page.clock.runFor(1500)
  await expect(panel.getByRole("alert")).toBeHidden()
  await expect(page.getByRole("button", { name: "Save & run" })).toBeEnabled()
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Save & run" }).click()
  await expect(panel).toContainText("Local callback / instructions.md / running")
  await expect.poll(() => readFile(bridge.launches, "utf8").catch(() => "")).toBe(JSON.stringify("Initial shared instructions\n") + "\n")
  await page.clock.runFor(1500)
  await expect(page.getByLabel("Computeruse output")).toContainText("fixture stdout: Initial shared instructions")
  await expect(page.getByLabel("Computeruse output")).toContainText("fixture stderr: no desktop actions")
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await expect(panel.getByRole("button", { name: "Stop computeruse" })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    const box = await panel.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
  }
  const cancel = page.waitForResponse((response) => /\/api\/computeruse\/runs\/[^/]+\/cancel$/.test(response.url()))
  await page.getByRole("button", { name: "Stop computeruse" }).click()
  expect((await cancel).ok()).toBe(true)
  await expect(page.getByRole("status")).toContainText("Waiting for local process termination")
  await expect.poll(async () => {
    await page.clock.runFor(1500)
    return panel.textContent()
  }).toContain("Local callback / instructions.md / cancelled")
  await expect(page.getByRole("button", { name: "Stop computeruse" })).toBeHidden()
  await expect(page.getByRole("button", { name: "Save & run" })).toBeEnabled()
  await expect(page.getByLabel("Computeruse output")).toContainText("fixture stdout")
  expect(bridge.mutations.filter((item) => item.path.startsWith("/api/runs"))).toEqual([])
  expect(bridge.mutations.filter((item) => item.path.endsWith("/cancel"))).toEqual([
    { path: expect.stringMatching(/^\/api\/computeruse\/runs\/[^/]+\/cancel$/), method: "POST", body: {} },
  ])
  expect(await readFile(bridge.launches, "utf8")).toBe(JSON.stringify("Initial shared instructions\n") + "\n")
})
