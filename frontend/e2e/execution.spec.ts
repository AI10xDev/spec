import { test, expect } from "@playwright/test"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

let server: ChildProcess
let directory: string
let workspace: string
let url: string

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "spec-execution-e2e-"))
  workspace = path.join(directory, "workspace")
  await mkdir(workspace, { mode: 0o700 })
  const remoteWorkspace = path.join(directory, "remote-project")
  await mkdir(remoteWorkspace, { mode: 0o700 })
  const executable = path.join(directory, "runner.cjs")
  await writeFile(executable, `#!${process.execPath}
const fs = require("node:fs")
if (process.cwd() !== ${JSON.stringify(remoteWorkspace)}) process.exit(91)
if (process.argv.length !== 4 || process.argv[2] !== "build" || process.env.SPEC_BUILD_AUTO !== "1" || process.env.SPEC_BUILD_FOREGROUND !== "1") process.exit(90)
if (process.env.OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS !== "1" || process.env.OPENCODE_QUESTION_AUTO_RECOMMEND !== "1") process.exit(92)
if ("SPEC_SESSION_DIR" in process.env || "KIBI_SPEC_SESSION" in process.env) process.exit(93)
const content = fs.readFileSync(process.argv[3], "utf8")
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)
const instructions = fs.readFileSync(config.instructions.at(-1), "utf8")
if (!instructions.includes("Implement only pending requirements; retain completed requirements as context.")) process.exit(94)
fs.appendFileSync(${JSON.stringify(path.join(directory, "launches"))}, "launch\\n")
{
  process.stdout.write("fixture stdout: " + content + "\\n")
  process.stderr.write("fixture stderr: " + content + "\\n")
  if (content.startsWith("DETACH\\n") || content.startsWith("BROWSER\\n")) {
    const browser = content.startsWith("BROWSER\\n")
    const finish = browser ? ${JSON.stringify(path.join(directory, "finish-browser"))} : ${JSON.stringify(path.join(directory, "finish-detached"))}
    setInterval(() => {
      if (!fs.existsSync(finish)) return
      process.stdout.write(browser ? "finished after browser close\\n" : "finished after server shutdown\\n")
      process.exit(0)
    }, 50)
    setTimeout(() => process.exit(2), 15_000)
  } else if (content.startsWith("WAIT\\n")) {
    let tick = 0
    setInterval(() => process.stdout.write("fixture progress " + ++tick + ": " + content + "\\n"), 100)
    setTimeout(() => process.exit(2), 60_000)
  } else {
    process.exitCode = content.startsWith("FAIL\\n") ? 7 : 0
  }
}
`)
  await chmod(executable, 0o700)
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  const ssh = path.join(directory, "ssh-fixture")
  await writeFile(ssh, `#!/bin/bash
export HOME=${quote(directory)}
exec /bin/bash -c "\${!#}"
`)
  await chmod(ssh, 0o700)
  await writeFile(path.join(directory, ".bash_aliases"), `alias spec=${quote(quote(executable))}
unset OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS
export SPEC_BUILD_FOREGROUND=0 SPEC_BUILD_AUTO=0 OPENCODE_QUESTION_AUTO_RECOMMEND=0
export SPEC_SESSION_DIR=/unused/session KIBI_SPEC_SESSION=1
`)
  await startServer()
})

async function startServer(execution = true) {
  server = spawn(path.resolve("../backend/target/debug/spec"), [], {
    cwd: path.resolve("../backend"),
    env: {
      ...process.env,
      SPEC_WORKSPACE: workspace,
      SPEC_PORT: url ? new URL(url).port : "0",
      SPEC_UI_DIR: path.resolve("dist"),
      SPEC_COMMAND: undefined,
      SPEC_SSH_TARGET: execution ? "fixture@host" : undefined,
      SPEC_SSH_WORKSPACE: execution ? path.join(directory, "remote-project") : undefined,
      SPEC_SSH_BINARY: execution ? path.join(directory, "ssh-fixture") : undefined,
      SPEC_SSH_KEY: undefined,
      AZURE_OPENAI_ENDPOINT: undefined,
      AZURE_OPENAI_API_KEY: undefined,
      DEPLOYMENT_NAME: undefined,
      AZURE_OPENAI_API_VERSION: undefined,
    },
    stdio: ["ignore", "pipe", "ignore"],
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
}

test.afterAll(async () => {
  try {
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => server.kill("SIGKILL"), 10_000)
        server.once("exit", () => { clearTimeout(timeout); resolve() })
        server.kill("SIGTERM")
      })
    }
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true })
  }
})

test("enabled execution: confirmation, saved snapshot, per-file polling, completion and cancellation", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await page.goto(url)
  const run = page.getByRole("button", { name: "Save & run" })
  const pane = page.getByRole("region", { name: "Output and logs pane" })
  const output = page.getByLabel("Run output")
  const tabs = page.getByRole("navigation", { name: "Editor tabs" })
  const snapshot = "WAIT\nSaved first snapshot."
  const edited = "Later buffer edits must not reach the running process."
  const second = "COMPLETE\nOnly the second file's output."

  await page.getByRole("textbox", { name: "New filename" }).fill("snapshot.md")
  await page.getByRole("button", { name: "Create file" }).click()
  const editor = page.getByRole("textbox", { name: "Edit snapshot.md" })
  await editor.fill(snapshot)
  await expect(run).toBeEnabled()
  const confirmation = page.waitForEvent("dialog")
  page.once("dialog", (dialog) => dialog.dismiss())
  await run.click()
  expect((await confirmation).type()).toBe("confirm")
  expect((await confirmation).message()).toContain("incur provider costs")
  expect((await confirmation).message()).toContain("Automatic tool approval is requested")
  expect((await confirmation).message()).toContain("recommended answers to runtime questions")
  await expect(pane.getByText("Idle", { exact: true })).toBeVisible()
  await expect(editor).toHaveValue(snapshot)
  await expect(run).toBeEnabled()
  await expect(readFile(path.join(workspace, "snapshot.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })

  const started = page.waitForResponse((response) => response.url().endsWith("/api/runs") && response.request().method() === "POST")
  page.once("dialog", (dialog) => dialog.accept())
  await run.click()
  const response = await started
  expect(response.ok()).toBe(true)
  const { id } = await response.json() as { id: string }
  await expect(page.getByRole("status")).toHaveText("Saved snapshot.md")
  await expect(pane.getByText("running", { exact: true })).toBeVisible()
  await expect(output).toContainText(`fixture stdout: ${snapshot}`)
  await expect(output).toContainText(`fixture stderr: ${snapshot}`)
  await expect(run).toBeDisabled()
  await expect(page.getByRole("button", { name: "Stop run" })).toBeVisible()
  await editor.fill(edited)
  expect(await readFile(path.join(workspace, "snapshot.md"), "utf8")).toBe(snapshot)

  await page.getByRole("textbox", { name: "New filename" }).fill("completed.md")
  await page.getByRole("button", { name: "Create file" }).click()
  await expect(pane.getByText("Idle", { exact: true })).toBeVisible()
  await expect(output).not.toContainText(snapshot)
  await expect(page.getByRole("button", { name: "Stop run" })).toBeHidden()
  await page.getByRole("textbox", { name: "Edit completed.md" }).fill(second)
  await expect(run).toBeEnabled()
  page.once("dialog", (dialog) => dialog.accept())
  await run.click()
  await expect(pane.getByText("completed", { exact: true })).toBeVisible()
  await expect(output).toContainText(`fixture stdout: ${second}`)
  await expect(output).toContainText(`fixture stderr: ${second}`)
  await expect(output).not.toContainText(snapshot)
  await expect(run).toBeEnabled()
  await expect(page.getByRole("button", { name: "Stop run" })).toBeHidden()
  const completedOutput = await output.textContent()

  // A fresh GET after switching back proves polling resumes for the still-running file.
  const resumed = page.waitForResponse((response) => response.url().endsWith(`/api/runs/${id}`) && response.request().method() === "GET")
  await tabs.getByRole("button", { name: /^snapshot\.md/ }).click()
  expect((await resumed).ok()).toBe(true)
  await expect(pane.getByText("running", { exact: true })).toBeVisible()
  await expect(output).toContainText(`fixture stdout: ${snapshot}`)
  await expect(output).toContainText(/fixture progress \d+: WAIT/)
  await expect(output).not.toContainText(edited)
  await expect(output).not.toContainText(second)
  await expect(editor).toHaveValue(edited)
  await expect(run).toBeDisabled()
  await page.getByRole("button", { name: "Stop run" }).click()
  await expect(pane.getByText("cancelled", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Stop run" })).toBeHidden()
  await expect(run).toBeEnabled()
  await tabs.getByRole("button", { name: "completed.md", exact: true }).click()
  await expect(pane.getByText("completed", { exact: true })).toBeVisible()
  await expect(output).toHaveText(completedOutput!)
  expect(pageErrors).toEqual([])
})

test("enabled execution: empty specs are rejected and nonzero exits show failure", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await page.goto(url)
  const run = page.getByRole("button", { name: "Save & run" })
  const pane = page.getByRole("region", { name: "Output and logs pane" })
  const output = page.getByLabel("Run output")
  await page.getByRole("textbox", { name: "New filename" }).fill("failure.md")
  await page.getByRole("button", { name: "Create file" }).click()
  const editor = page.getByRole("textbox", { name: "Edit failure.md" })
  await editor.fill(" \n\t ")
  const rejected = page.waitForResponse((response) => response.url().endsWith("/api/runs") && response.request().method() === "POST")
  page.once("dialog", (dialog) => dialog.accept())
  await run.click()
  expect((await rejected).status()).toBe(400)
  await expect(page.getByRole("alert")).toContainText("Cannot run an empty spec")
  await expect(pane.getByText("Idle", { exact: true })).toBeVisible()
  await expect(output).not.toContainText("[started]")
  await expect(page.getByRole("button", { name: "Stop run" })).toBeHidden()
  await expect(run).toBeEnabled()

  const failed = "FAIL\nIntentional fixture failure."
  await editor.fill(failed)
  page.once("dialog", (dialog) => dialog.accept())
  await run.click()
  await expect(page.getByRole("alert")).toBeHidden()
  await expect(pane.getByText("failed (exit status: 7)", { exact: true })).toBeVisible()
  await expect(output).toContainText(`fixture stdout: ${failed}`)
  await expect(output).toContainText(`fixture stderr: ${failed}`)
  await expect(page.getByRole("button", { name: "Stop run" })).toBeHidden()
  await expect(run).toBeEnabled()
  expect(pageErrors).toEqual([])
})

test("slash-marked lines reach the build unchanged with completion instructions", async ({ page }) => {
  await page.goto(url)
  await page.getByRole("textbox", { name: "New filename" }).fill("markers.md")
  await page.getByRole("button", { name: "Create file" }).click()
  const editor = page.getByRole("textbox", { name: "Edit markers.md" })
  const content = "Already implemented\nStill pending\n## Heading\nUse C#\n```text\n# code\n```"
  await editor.fill(content)
  await editor.press("Control+Home")
  await editor.press("/")
  const snapshot = `# ${content}`
  await expect(editor).toHaveValue(snapshot)
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Save & run" }).click()
  await expect(page.getByRole("region", { name: "Output and logs pane" }).getByText("completed", { exact: true })).toBeVisible()
  await expect(page.getByLabel("Run output")).toContainText(`fixture stdout: ${snapshot}`)
  expect(await readFile(path.join(workspace, "markers.md"), "utf8")).toBe(snapshot)
})

test("output recovery failures leave editing available and stale recovery cannot replace a new run", async ({ page }) => {
  await page.goto(url)
  await page.getByRole("textbox", { name: "New filename" }).fill("recovery-error.md")
  await page.getByRole("button", { name: "Create file" }).click()
  await page.getByRole("textbox", { name: "Edit recovery-error.md" }).fill("COMPLETE\nNew run output.")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("Saved recovery-error.md")
  await page.route("**/api/files/recovery-error.md/run", (route) => route.fulfill({ status: 503, json: { error: "Recovery offline" } }))
  await page.reload()
  await expect(page.getByRole("alert")).toContainText("Could not recover output for recovery-error.md")
  await expect(page.getByRole("textbox", { name: "Edit recovery-error.md" })).toHaveValue("COMPLETE\nNew run output.")
  await page.unroute("**/api/files/recovery-error.md/run")
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/files/recovery-error.md/run", async (route) => {
    await held
    await route.fulfill({ json: { id: "old-run", name: "recovery-error.md", status: "completed", output: "stale recovered output", truncated: false, recoverable: false } })
  })
  const requested = page.waitForRequest("**/api/files/recovery-error.md/run")
  await page.getByRole("button", { name: "Recover output" }).click()
  await requested
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Save & run" }).click()
  await expect(page.getByLabel("Run output")).toContainText("New run output.")
  const recovered = page.waitForResponse("**/api/files/recovery-error.md/run")
  release()
  await recovered
  await expect(page.getByLabel("Run output")).not.toContainText("stale recovered output")
})

test("unavailable recovered runs keep polling without permitting duplicate builds", async ({ page }) => {
  await page.goto(url)
  await page.getByRole("textbox", { name: "New filename" }).fill("recover-poll.md")
  await page.getByRole("button", { name: "Create file" }).click()
  await page.getByRole("textbox", { name: "Edit recover-poll.md" }).fill("Pending requirement")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("Saved recover-poll.md")
  const recovered = { id: "recover-poll", name: "recover-poll.md", status: "unavailable (SSH offline)", output: "cached output", truncated: false, recoverable: true }
  await page.route("**/api/files/recover-poll.md/run", (route) => route.fulfill({ json: recovered }))
  let polls = 0
  await page.route("**/api/runs/recover-poll", (route) => route.fulfill({ json: ++polls === 1 ? recovered : { ...recovered, status: "completed", output: "reconnected output", recoverable: false } }))
  await page.reload()
  await expect(page.getByLabel("Run output")).toHaveText("cached output")
  await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
  await expect(page.getByLabel("Run output")).toHaveText("reconnected output")
  await expect(page.getByRole("button", { name: "Save & run" })).toBeEnabled()
})

test("closing the browser does not cancel an admitted build", async ({ page, request }) => {
  await page.goto(url)
  await page.getByRole("textbox", { name: "New filename" }).fill("browser-close.md")
  await page.getByRole("button", { name: "Create file" }).click()
  await page.getByRole("textbox", { name: "Edit browser-close.md" }).fill("BROWSER\nKeep working without the editor.")
  const started = page.waitForResponse((response) => response.url().endsWith("/api/runs") && response.request().method() === "POST")
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Save & run" }).click()
  const { id } = await (await started).json() as { id: string }
  await expect(page.getByLabel("Run output")).toContainText("fixture stdout: BROWSER")
  await page.close()
  const endpoint = new URL(`/api/runs/${id}`, url).href
  const headers = { Authorization: `Bearer ${new URLSearchParams(new URL(url).hash.slice(1)).get("token")}` }
  expect((await (await request.get(endpoint, { headers })).json()).status).toBe("running")
  await writeFile(path.join(directory, "finish-browser"), "")
  await expect.poll(async () => (await (await request.get(endpoint, { headers })).json()).status).toBe("completed")
  expect((await (await request.get(endpoint, { headers })).json()).output).toContain("finished after browser close")
})

test("startup restores live and completed output after server restart without relaunch", async ({ page }) => {
  await page.goto(url)
  await page.getByRole("textbox", { name: "New filename" }).fill("detached.md")
  await page.getByRole("button", { name: "Create file" }).click()
  await page.getByRole("textbox", { name: "Edit detached.md" }).fill("DETACH\nKeep working after shutdown.")
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Save & run" }).click()
  const output = page.getByLabel("Run output")
  await expect(output).toContainText("fixture stdout: DETACH")
  const session = (await output.textContent())!.match(/\[remote\] session: (.+) \(output\.log,/)
  expect(session).not.toBeNull()
  const remoteDirectory = session![1]
  const launches = await readFile(path.join(directory, "launches"), "utf8")
  const buildRequests: string[] = []
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/runs")) buildRequests.push(request.url())
  })
  await page.reload()
  await expect(page.getByRole("textbox", { name: "Edit detached.md" })).toHaveValue("DETACH\nKeep working after shutdown.")
  await expect(output).toContainText("fixture stdout: DETACH")
  await expect(readFile(path.join(remoteDirectory, "status"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  await new Promise<void>((resolve) => {
    server.once("exit", () => resolve())
    server.kill("SIGTERM")
  })
  await startServer()
  await page.goto("about:blank")
  await page.goto(url)
  await expect(page.getByRole("textbox", { name: "Edit detached.md" })).toHaveValue("DETACH\nKeep working after shutdown.")
  await expect(output).toContainText("fixture stdout: DETACH")
  await expect(page.getByRole("button", { name: "Stop run" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
  const editor = page.getByRole("textbox", { name: "Edit detached.md" })
  await editor.fill("Unsaved edits must survive output recovery.")
  const recovered = page.waitForResponse("**/api/files/detached.md/run")
  await page.getByRole("button", { name: "Recover output" }).click()
  expect((await recovered).ok()).toBe(true)
  await expect(editor).toHaveValue("Unsaved edits must survive output recovery.")
  expect(await readFile(path.join(workspace, "detached.md"), "utf8")).toBe("DETACH\nKeep working after shutdown.")
  await editor.fill("DETACH\nKeep working after shutdown.")
  await writeFile(path.join(directory, "finish-detached"), "")
  await expect.poll(async () => readFile(path.join(remoteDirectory, "status"), "utf8").catch(() => "running")).toBe("0\n")
  expect(await readFile(path.join(remoteDirectory, "output.log"), "utf8")).toContain("finished after server shutdown")
  await expect(readFile(path.join(remoteDirectory, "snapshot.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  await expect(output).toContainText("finished after server shutdown")
  await expect(page.getByRole("region", { name: "Output and logs pane" }).getByText("completed", { exact: true })).toBeVisible()
  await new Promise<void>((resolve) => {
    server.once("exit", () => resolve())
    server.kill("SIGTERM")
  })
  await startServer(false)
  await page.goto("about:blank")
  await page.goto(url)
  await expect(output).toContainText("finished after server shutdown")
  await expect(page.getByRole("button", { name: "Stop run" })).toBeHidden()
  await expect(page.getByRole("button", { name: "Save & run" })).toBeDisabled()
  expect(await readFile(path.join(directory, "launches"), "utf8")).toBe(launches)
  expect(buildRequests).toEqual([])
})
