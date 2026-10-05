import { test, expect } from "@playwright/test"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

let server: ChildProcess
let directory: string
let url: string

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "spec-e2e-"))
  server = spawn(path.resolve("../backend/target/debug/spec"), [], {
    cwd: path.resolve("../backend"),
    env: { ...process.env, SPEC_WORKSPACE: directory, SPEC_PORT: "0", SPEC_OPENCODE: undefined },
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

test("real API: history, independent tabs, dirty protection, split panes and reload", async ({ page }) => {
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
  await page.screenshot({ path: "../docs/workspace.png", fullPage: true })
  await page.reload()
  await page.getByRole("tabpanel").getByRole("button", { name: /first.md/ }).click()
  await expect(page.getByRole("textbox", { name: "Edit first.md" })).toHaveValue("Unsaved first spec")
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole("textbox", { name: "Edit first.md" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
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
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("File changed on disk")
  await expect(page.getByRole("textbox", { name: "Edit conflict.md" })).toHaveValue("keep my changes")
  await second.close()
})
