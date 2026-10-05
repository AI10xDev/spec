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
const content = fs.readFileSync(process.argv[3], "utf8")
{
  process.stdout.write("fixture stdout: " + content + "\\n")
  process.stderr.write("fixture stderr: " + content + "\\n")
  if (content.startsWith("WAIT\\n")) {
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
  await writeFile(path.join(directory, ".bash_aliases"), `alias spec=${quote(quote(executable))}\n`)
  server = spawn(path.resolve("../backend/target/debug/spec"), [], {
    cwd: path.resolve("../backend"),
    env: {
      ...process.env,
      SPEC_WORKSPACE: workspace,
      SPEC_PORT: "0",
      SPEC_UI_DIR: path.resolve("dist"),
      SPEC_COMMAND: undefined,
      SPEC_SSH_TARGET: "fixture@host",
      SPEC_SSH_WORKSPACE: remoteWorkspace,
      SPEC_SSH_BINARY: ssh,
      SPEC_SSH_KEY: undefined,
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
})

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
  await expect(output).toContainText("[completed]")
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
  await expect(output).toContainText("[cancelled]")
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
  await expect(output).toContainText("[failed (exit status: 7)]")
  await expect(page.getByRole("button", { name: "Stop run" })).toBeHidden()
  await expect(run).toBeEnabled()
  expect(pageErrors).toEqual([])
})
