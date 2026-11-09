import { test, expect } from "@playwright/test"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, request as upstreamRequest, type Server } from "node:http"
import path from "node:path"

const prefix = "/paypal/skills-marketplace"
const basic = `Basic ${Buffer.from("smoke:test-only").toString("base64")}`
let directory: string
let rust: ChildProcess
let gateway: Server
let url: string
let failConfig = false
const requests: string[] = []
const bearerLeaks: string[] = []

test.use({ httpCredentials: { username: "smoke", password: "test-only" } })

test.beforeAll(async () => {
  test.setTimeout(60_000)
  directory = await mkdtemp("/tmp/opencode/spec-subpath-")
  const ui = path.join(directory, "ui")
  const workspace = path.join(directory, "workspace")
  await mkdir(workspace)
  await writeFile(path.join(workspace, "hello world.md"), "Build a useful tool.\n")
  // Build separately so the existing root deployment suites still use dist/.
  execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--outDir", ui], {
    env: { ...process.env, SPEC_PUBLIC_BASE_PATH: prefix, VITE_SPEC_GATEWAY_AUTH: "1" },
    stdio: "pipe",
  })
  rust = spawn(path.resolve("../backend/target/debug/spec"), [], {
    cwd: path.resolve("../backend"),
    env: { HOME: directory, PATH: "/usr/bin:/bin", SPEC_WORKSPACE: workspace, SPEC_PORT: "0", SPEC_UI_DIR: ui, SPEC_AI_ENV_FILE: "/dev/null", SPEC_SETTINGS_FILE: path.join(directory, "private", "profile.json") },
    stdio: ["ignore", "pipe", "ignore"],
  })
  // Only this freshly generated fixture token is read, never deployment credentials.
  const upstream = await new Promise<URL>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture Rust server did not start")), 10_000)
    let output = ""
    rust.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(/Spec: (http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+)/)
      if (match) { clearTimeout(timer); resolve(new URL(match[1])) }
    })
    rust.once("error", (error) => { clearTimeout(timer); reject(error) })
    rust.once("exit", () => { clearTimeout(timer); reject(new Error("Fixture Rust server exited")) })
  })
  gateway = createServer((req, res) => {
    const incoming = new URL(req.url!, "http://fixture")
    if (req.headers.authorization?.startsWith("Bearer")) bearerLeaks.push(incoming.pathname)
    if (req.headers.authorization !== basic) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="subpath-smoke"' }).end()
      return
    }
    if (incoming.pathname === prefix) {
      res.writeHead(308, { Location: `${prefix}/${incoming.search}` }).end()
      return
    }
    if (!incoming.pathname.startsWith(`${prefix}/`)) { res.writeHead(404).end(); return }
    const target = incoming.pathname.slice(prefix.length) + incoming.search
    requests.push(target)
    if (/^\/(?:api\/)?(?:auth|token|bootstrap)(?:\/|\?|$)/.test(target)) { res.writeHead(404).end(); return }
    // Advertise completions without credentials; the real endpoint must fail safely.
    if (target === "/api/config") {
      res.writeHead(failConfig ? 503 : 200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      res.end(JSON.stringify(failConfig ? { error: "Fixture gateway unavailable" } : { execution: false, completion: true, chat: false, realtime: false, azureRealtime: false }))
      return
    }
    const proxy = upstreamRequest(new URL(target, upstream.origin), {
      method: req.method,
      headers: { ...req.headers, host: upstream.host, authorization: `Bearer ${upstream.hash.slice("#token=".length)}` },
    }, (response) => {
      res.writeHead(response.statusCode!, response.headers)
      response.pipe(res)
    })
    proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end() })
    res.on("close", () => proxy.destroy())
    req.pipe(proxy)
  })
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve))
  const address = gateway.address() as { port: number }
  url = `http://127.0.0.1:${address.port}${prefix}/`
})

test.afterAll(async () => {
  if (gateway) {
    gateway.closeAllConnections()
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
  }
  if (rust && rust.exitCode === null && rust.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => rust.kill("SIGKILL"), 5000)
      rust.once("exit", () => { clearTimeout(timer); resolve() })
      rust.kill("SIGTERM")
    })
  }
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("full workspace, demo purchase and chat stay under the Basic-authenticated prefix", async ({ page, context }) => {
  const errors: string[] = []
  const escaped: string[] = []
  context.on("page", (child) => child.on("pageerror", (error) => errors.push(error.message)))
  page.on("pageerror", (error) => errors.push(error.message))
  context.on("request", (request) => {
    const address = new URL(request.url())
    if (address.protocol.startsWith("http") && (address.origin !== new URL(url).origin || !address.pathname.startsWith(prefix))) escaped.push(address.pathname)
  })
  await context.addInitScript(() => sessionStorage.setItem("spec-token", "stale-test-token"))
  await page.goto(url.slice(0, -1) + "#token=ignored-test-token")
  await expect(page.getByRole("button", { name: "Create file" })).toBeVisible()
  await expect(page.getByLabel("Server access token")).toHaveCount(0)
  expect(await page.evaluate(() => sessionStorage.getItem("spec-token"))).toBe("stale-test-token")
  await page.getByRole("tabpanel").getByRole("button", { name: /hello world\.md/ }).click()
  const editor = page.getByRole("textbox", { name: "Edit hello world.md", exact: true })
  await expect(editor).toHaveValue("Build a useful tool.\n")
  await editor.fill("Build a useful tool with ")
  await expect.poll(() => requests.includes("/api/completions")).toBe(true)
  await expect(page.getByText("Completion unavailable. Continue typing to retry.")).toBeVisible()
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await page.reload()
  await expect(editor).toHaveValue("Build a useful tool with ")

  await page.getByRole("button", { name: "Purchase Skills", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Skills marketplace", exact: true })
  await dialog.getByRole("navigation").getByRole("button", { name: /Code Review/ }).click()
  await expect(dialog.locator("pre")).toHaveCount(0)
  await dialog.getByRole("button", { name: "Purchase Skills", exact: true }).click()
  await expect(dialog).toContainText("This was a simulation; no payment was made.")
  await dialog.getByRole("button", { name: "Display full contents", exact: true }).click()
  await expect(dialog.locator("pre")).toContainText("Read the diff and surrounding code.")
  await dialog.getByRole("button", { name: "Enable editing", exact: true }).click()
  const copy = page.getByRole("textbox", { name: "Edit skill-code-review.md", exact: true })
  await expect(copy).toBeFocused()
  await expect(copy).toHaveValue(/Read the diff and surrounding code\./)
  const editedSkill = (await copy.inputValue()) + "\nA workspace-only edit.\n"
  await copy.fill(editedSkill)
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await page.reload()
  await page.getByRole("tab", { name: "Saved files", exact: true }).click()
  await page.getByRole("tabpanel").getByRole("button", { name: /skill-code-review\.md/ }).click()
  await expect(copy).toHaveValue(editedSkill)
  expect(requests).toContain("/api/files/skill-code-review.md")
  await page.getByRole("tabpanel").getByRole("button", { name: /hello world\.md/ }).click()

  const outputPopup = context.waitForEvent("page")
  await page.getByRole("button", { name: "Maximize output", exact: true }).click()
  const outputWindow = await outputPopup
  expect(new URL(outputWindow.url()).pathname).toBe(`${prefix}/output-window.html`)
  await expect(outputWindow.getByLabel("Run output")).toContainText("Remote execution is disabled")
  await expect(outputWindow.locator(".output-window-content")).toHaveCSS("height", `${await outputWindow.evaluate(() => innerHeight)}px`)
  await outputWindow.getByRole("button", { name: "Restore output", exact: true }).click()
  await expect.poll(() => outputWindow.isClosed()).toBe(true)

  const popup = context.waitForEvent("page")
  await page.getByRole("button", { name: "Open session chat" }).click()
  const chat = await popup
  await expect(chat.getByRole("link", { name: "Open workspace" })).toHaveAttribute("href", `${prefix}/`)
  expect(new URL(chat.url()).pathname).toBe(`${prefix}/`)
  expect(new URL(chat.url()).searchParams.get("chat")).toBe("hello world.md")
  await chat.reload()
  await expect(chat.getByRole("heading", { name: "hello world.md", exact: true })).toBeVisible()
  const workspace = context.waitForEvent("page")
  await chat.getByRole("link", { name: "Open workspace" }).click()
  await expect((await workspace).getByRole("button", { name: "Create file" })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(requests.some((request) => request.startsWith("/assets/") && request.endsWith(".js"))).toBe(true)
  expect(requests.some((request) => request.startsWith("/assets/") && request.endsWith(".css"))).toBe(true)
  expect(requests).toContain("/api/files/hello%20world.md")
  expect(requests.some((request) => /auth|bootstrap|token/.test(request))).toBe(false)
  expect(bearerLeaks).toEqual([])
  expect(escaped).toEqual([])
  expect(errors).toEqual([])
})

test("gateway connection failures can retry without a workspace token", async ({ page }) => {
  failConfig = true
  try {
    await page.goto(url)
    await expect(page.getByRole("alert")).toHaveText("Fixture gateway unavailable")
    await expect(page.getByLabel("Server access token")).toHaveCount(0)
    expect(await page.evaluate(() => sessionStorage.getItem("spec-token"))).toBeNull()
    failConfig = false
    await page.getByRole("button", { name: /Open workspace/ }).click()
    await expect(page.getByRole("button", { name: "Create file" })).toBeVisible()
    expect(bearerLeaks).toEqual([])
  } finally { failConfig = false }
})
