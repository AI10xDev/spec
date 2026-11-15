import { test, expect } from "@playwright/test"
import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"

// Opt-in: ordinary e2e runs do not require a benchmark download.
const enabled = process.env.SPEC_SWE_BENCH === "1"
test.describe.configure({ mode: "parallel" })
type Instance = { instance_id: string; repo: string; problem_statement: string; bytes: number; sha256: string }
const manifest = enabled ? JSON.parse(readFileSync(path.resolve("../workspace/swe-bench/subset.json"), "utf8")) : null
const instances: Instance[] = manifest?.instances ?? []
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
if (enabled) {
  if (manifest.revision !== "6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2" || instances.length !== 15) throw new Error("Unexpected benchmark manifest")
  for (const item of instances) {
    if (!/^[a-zA-Z0-9_-]+$/.test(item.instance_id) || hash(item.problem_statement) !== item.sha256) throw new Error("Invalid task data")
  }
}

let directory: string
let workspace: string
let server: ChildProcess
let url: string
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"

test.beforeAll(async () => {
  if (!enabled) return
  directory = await mkdtemp(path.join(tmpdir(), "spec-swe-bench-"))
  workspace = path.join(directory, "workspace")
  const project = path.join(directory, "project")
  await mkdir(workspace, { mode: 0o700 })
  await mkdir(project, { mode: 0o700 })
  // Fixed, reviewed program. Task text is read as data, never evaluated or interpolated into shell code.
  const runner = path.join(directory, "runner.cjs")
  await writeFile(runner, `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
if (process.argv[2] !== 'build' || process.env.SPEC_BUILD_SUPERVISED !== '1') process.exit(90)
const snapshot = fs.readFileSync(process.argv[3], 'utf8')
const mode = fs.readFileSync(${JSON.stringify(path.join(directory, "mode"))}, 'utf8')
if (!['success', 'failure', 'cancel'].includes(mode)) process.exit(91)
const digest = crypto.createHash('sha256').update(snapshot).digest('hex')
fs.writeFileSync(${JSON.stringify(path.join(directory, "received"))}, snapshot)
process.stdout.write('INPUT_SHA256=' + digest + '\\n')
process.stdout.write('challenge-data: ' + JSON.stringify(snapshot) + '\\n')
process.stderr.write('fixture stderr: ' + mode + '\\n')
process.stdout.write('# Todos (Integrator)\\n[•] Exercise fixture\\n[ ] Verify transport\\n\\n')
let chunk = 0
const timer = setInterval(() => {
  process.stdout.write('chunk=' + (++chunk) + ' ' + 'x'.repeat(8192) + '\\n')
  if (chunk === 8) {
    clearInterval(timer)
    if (mode !== 'cancel') {
      process.stdout.write('# Todos (Integrator)\\n[✓] Exercise fixture\\n[✓] Verify transport\\n\\nFIXTURE_END\\n')
      process.exitCode = mode === 'failure' ? 7 : 0
      clearTimeout(deadline)
    }
  }
}, 100)
const deadline = setTimeout(() => process.exit(124), 20000)
`)
  await chmod(runner, 0o700)
  const ssh = path.join(directory, "ssh-fixture")
  await writeFile(ssh, `#!/bin/bash\nexport HOME=${quote(directory)}\nexec /bin/bash -c "\${!#}"\n`)
  await chmod(ssh, 0o700)
  await writeFile(path.join(directory, ".bash_aliases"), `alias spec=${quote(quote(runner))}\n`)
  // Allowlist environment: no inherited credentials, provider settings, SSH agent, or live configuration.
  server = spawn(path.resolve("../backend/target/debug/spec"), [], {
    cwd: directory,
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: directory, TMPDIR: directory,
      LANG: "C.UTF-8", SPEC_WORKSPACE: workspace, SPEC_PORT: "0",
      SPEC_UI_DIR: path.resolve("dist"), SPEC_SSH_TARGET: "fixture@host",
      SPEC_SSH_WORKSPACE: project, SPEC_SSH_BINARY: ssh, SPEC_AI_ENV_FILE: "/dev/null",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture server startup timeout")), 10000)
    let output = ""
    let stderr = ""
    server.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000) })
    server.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(/Spec: (http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+)/)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    })
    server.once("error", error => { clearTimeout(timer); reject(error) })
    server.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture server exited ${code}: ${stderr}`)) })
  })
})

test.afterAll(async () => {
  if (!enabled) return
  if (server && server.exitCode === null && server.signalCode === null) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => server.kill("SIGKILL"), 5000)
      server.once("exit", () => { clearTimeout(timer); resolve() })
      server.kill("SIGTERM")
    })
  }
  // The fixture runner also has a hard 20s deadline if a failing test detaches it.
  if (directory) await rm(directory, { recursive: true, force: true })
})

for (const item of instances) {
  for (const scenario of ["success", "failure", "cancel"] as const) {
    test(`${item.instance_id} / ${scenario}`, async ({ page, context, browser }, testInfo) => {
      const started = performance.now()
      const metrics: Record<string, unknown> = {
        instance_id: item.instance_id, repo: item.repo, scenario, round: testInfo.repeatEachIndex,
        source_bytes: item.bytes, source_sha256: item.sha256, browser: browser.version(),
        phase: "setup", page_errors: 0, blocked_external_requests: 0,
      }
      const errors: string[] = []
      const external: string[] = []
      page.on("pageerror", error => errors.push(error.message))
      await context.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(url).origin) {
          external.push(new URL(route.request().url()).origin)
          return route.abort()
        }
        return route.continue()
      })
      await context.route("**/api/performance", route => route.fulfill({ json: null }))
      await context.route("**/api/performance/runs", route => route.fulfill({ json: [] }))
      try {
        await writeFile(path.join(directory, "mode"), scenario)
        await page.goto(url)
        const name = `${item.instance_id}-${scenario}-${testInfo.repeatEachIndex}.md`
        await page.getByRole("textbox", { name: "New filename" }).fill(name)
        await page.getByRole("button", { name: "Create file" }).click()
        const editor = page.getByRole("textbox", { name: `Edit ${name}`, exact: true })
        // HTML textarea normalizes CRLF to LF. Record and verify this explicit transformation.
        const input = item.problem_statement.replace(/\r\n?/g, "\n")
        metrics.input_bytes = Buffer.byteLength(input)
        metrics.input_sha256 = hash(input)
        metrics.phase = "input"
        await editor.fill(input)
        await expect(editor).toHaveValue(input)
        const runStart = performance.now()
        const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/runs") && response.request().method() === "POST")
        page.once("dialog", dialog => dialog.accept())
        await page.getByRole("button", { name: "Save & run" }).click()
        metrics.phase = "admission"
        expect((await responsePromise).ok()).toBe(true)
        metrics.admission_ms = performance.now() - runStart
        const output = page.getByLabel("Run output")
        metrics.phase = "snapshot-and-output"
        await expect(output).toContainText(`INPUT_SHA256=${hash(input)}`)
        metrics.first_output_ms = performance.now() - runStart
        expect(await readFile(path.join(workspace, name), "utf8")).toBe(input)
        expect(await readFile(path.join(directory, "received"), "utf8")).toBe(input)
        await expect(output).toContainText(`fixture stderr: ${scenario}`)
        const pane = page.getByRole("region", { name: "Output and logs pane" })
        metrics.phase = "terminal-state"
        if (scenario === "cancel") {
          await expect(pane.getByText("running", { exact: true })).toBeVisible()
          const cancelStart = performance.now()
          await page.getByRole("button", { name: "Stop run" }).click()
          await expect(pane.getByText("cancelled", { exact: true })).toBeVisible()
          metrics.cancel_ms = performance.now() - cancelStart
          await expect(output).not.toContainText("FIXTURE_END")
        } else {
          await expect(pane.getByText(scenario === "success" ? "completed" : "failed (exit status: 7)", { exact: true })).toBeVisible()
          await expect(output).toContainText("chunk=8")
          await expect(output).toContainText("FIXTURE_END")
          metrics.output_chars = (await output.textContent())!.length
        }
        metrics.terminal_ms = performance.now() - runStart
        await expect(page.getByRole("button", { name: "Stop run" })).toBeHidden()
        metrics.phase = "reload-recovery"
        await page.reload()
        await expect(page.getByRole("textbox", { name: `Edit ${name}`, exact: true })).toHaveValue(input)
        await expect(output).toContainText(`INPUT_SHA256=${hash(input)}`)
        await expect(pane.getByText(scenario === "cancel" ? "cancelled" : scenario === "success" ? "completed" : "failed (exit status: 7)", { exact: true })).toBeVisible()
        expect(errors).toEqual([])
        expect(external).toEqual([])
        metrics.phase = "verified"
      } finally {
        metrics.elapsed_ms = performance.now() - started
        metrics.page_errors = errors.length
        metrics.blocked_external_requests = external.length
        await testInfo.attach("swe-bench-metrics", { body: JSON.stringify(metrics), contentType: "application/json" })
        // Cancel a remaining fixture after an assertion failure; never invoke a real engine.
        const stop = page.getByRole("button", { name: "Stop run" })
        if (!page.isClosed() && await stop.isVisible().catch(() => false)) await stop.click({ timeout: 2000 }).catch(() => {})
      }
    })
  }
}
