import { test, expect } from "@playwright/test"
import type { Page, Route } from "@playwright/test"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

let server: ChildProcess
let directory: string
let root: string
let url: string
const saved = "Review this saved spec without executing it.\n"
const retained = "Existing output must remain unchanged.\n"
const unsaved = "Unsaved editor changes must not enter the marketplace.\n"
const instruction = "Read the diff and surrounding code."
const full = "# Private instructions\n\nOnly explicit display may fetch this body.\n"
type Skill = { id: string; name: string; path: string; description: string; price: string; currency: string; purchased: boolean; order?: { id: string; approvalUrl: string } }
const skills: Skill[] = [
  { id: "code-review", name: "Code Review", path: "code-review/skills.md", description: "Review changes for correctness, security, and missing tests.", price: "5.00", currency: "USD", purchased: false },
  { id: "test-design", name: "Test Design", path: "test-design/skills.md", description: "Turn acceptance criteria into focused regression tests.", price: "7.50", currency: "USD", purchased: false },
  { id: "release-check", name: "Release Check", path: "release-check/skills.md", description: "Prepare an evidence-based release checklist.", price: "4.00", currency: "USD", purchased: false },
]
const catalog = (items = skills, mode = "sandbox") => ({ mode, repository: "example/private-skills", skills: items })
const order = (mode = "sandbox") => ({ id: "ORDER-ONE", approvalUrl: `https://www.${mode === "live" ? "" : "sandbox."}paypal.com/checkoutnow?token=ORDER-ONE` })
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

type SdkBehavior = "cancel" | "manual" | "popup-failure" | "popup-failure-early" | "instance-failure" | "ineligible"
type Callbacks = { onApprove: (data: { orderId: string }) => Promise<void>; onCancel: () => void; onError: () => void; onComplete: () => void }
declare global {
  interface Window {
    marketplacePayPal: {
      behavior: SdkBehavior
      instances: unknown[]
      eligibility: unknown[]
      starts: { options: unknown; promise: boolean; activeGesture: boolean; orderId?: string }[]
      sessions: Callbacks[]
      destroyed: number
      autoComplete: boolean
      approvals: { status: "fulfilled" | "rejected"; error?: string; destroyed: boolean }[]
      completions: { destroyed: boolean }[]
      orderOutcomes: string[]
    }
  }
}

test.beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "spec-marketplace-e2e-"))
  root = path.join(directory, "workspace")
  await mkdir(root)
  await writeFile(path.join(root, "foo.md"), saved)
  await writeFile(path.join(root, "foo.md.out"), retained)
  server = spawn(path.resolve("../backend/target/debug/spec"), [], {
    cwd: path.resolve("../backend"),
    // No inherited provider credentials; private receipts stay outside the editable workspace.
    env: { HOME: directory, PATH: "/usr/bin:/bin", SPEC_WORKSPACE: root, SPEC_PORT: "0", SPEC_UI_DIR: path.resolve("dist"), SPEC_AI_ENV_FILE: "/dev/null", SPEC_SETTINGS_FILE: path.join(directory, "private", "profile.json") },
    stdio: ["ignore", "pipe", "pipe"],
  })
  url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Rust server did not start")), 10_000)
    let stdout = ""
    let stderr = ""
    server.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000) })
    server.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
      const match = stdout.match(/Spec: (http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+)/)
      if (match) { clearTimeout(timeout); resolve(match[1]) }
    })
    server.once("error", (error) => { clearTimeout(timeout); reject(error) })
    server.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${stderr}`)) })
  })
})

test.afterEach(async () => {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => server.kill("SIGKILL"), 10_000)
      server.once("exit", () => { clearTimeout(timeout); resolve() })
      server.kill("SIGTERM")
    })
  }
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function workspace(page: Page, mock?: (route: Route) => Promise<void>, options: { mode?: "sandbox" | "live"; sdk?: SdkBehavior; config?: (route: Route) => Promise<void> } = {}) {
  const mutations: { path: string; method: string; body: unknown }[] = []
  const contentReads: string[] = []
  const external: string[] = []
  const errors: string[] = []
  const dialogs: string[] = []
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.endsWith("/content")) contentReads.push(pathname)
    if (pathname.startsWith("/api/") && request.method() !== "GET") mutations.push({ path: pathname, method: request.method(), body: request.postData() ? request.postDataJSON() : null })
  })
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss() })
  // Block any accidental provider navigation, including a new approval tab, before network access.
  await page.context().route("**/*", (route) => {
    const address = new URL(route.request().url())
    if (address.protocol.startsWith("http") && address.origin !== new URL(url).origin) {
      external.push(address.href)
      return route.abort()
    }
    return route.continue()
  })
  if (mock) {
    // The real v6 loader reuses this namespace only when its version starts with 6.
    // Keep the demo server's strict CSP intact and never load provider scripts.
    await page.addInitScript((behavior: SdkBehavior) => {
      const state = window.marketplacePayPal = {
        behavior, instances: [] as unknown[], eligibility: [] as unknown[],
        starts: [] as Window["marketplacePayPal"]["starts"], sessions: [] as Callbacks[], destroyed: 0,
        autoComplete: true, approvals: [] as Window["marketplacePayPal"]["approvals"],
        completions: [] as { destroyed: boolean }[], orderOutcomes: [] as string[],
      }
      Object.assign(window, { paypal: {
        version: "6.0.0",
        async createInstance(config: unknown) {
          state.instances.push(config)
          if (state.behavior === "instance-failure") throw new Error("SDK initialization failed")
          return {
            async findEligibleMethods(config: unknown) {
              state.eligibility.push(config)
              return { isEligible: (method: string) => method === "paypal" && state.behavior !== "ineligible" }
            },
            createPayPalOneTimePaymentSession(callbacks: Callbacks) {
              let destroyed = false
              const exposed: Callbacks = {
                async onApprove(data) {
                  // Model the provider awaiting verification before its completion callback.
                  try {
                    await callbacks.onApprove(data)
                    state.approvals.push({ status: "fulfilled", destroyed })
                  } catch (error) {
                    state.approvals.push({ status: "rejected", error: error instanceof Error ? error.message : String(error), destroyed })
                    callbacks.onError()
                  } finally { if (state.autoComplete) exposed.onComplete() }
                },
                onCancel() {
                  callbacks.onCancel()
                  queueMicrotask(() => { if (state.autoComplete) exposed.onComplete() })
                },
                onError() {
                  callbacks.onError()
                  queueMicrotask(() => { if (state.autoComplete) exposed.onComplete() })
                },
                onComplete() {
                  state.completions.push({ destroyed })
                  callbacks.onComplete()
                },
              }
              state.sessions.push(exposed)
              return {
                async start(options: unknown, pending: Promise<{ orderId: string }>) {
                  const start = { options, promise: pending instanceof Promise, activeGesture: navigator.userActivation.isActive, orderId: undefined as string | undefined }
                  state.starts.push(start)
                  void pending.then(() => state.orderOutcomes.push("fulfilled"), () => state.orderOutcomes.push("rejected"))
                  if (state.behavior === "popup-failure-early") throw new Error("Popup blocked before order creation finished")
                  const result = await pending
                  start.orderId = result.orderId
                  if (state.behavior === "popup-failure") throw new Error("Popup blocked")
                  if (state.behavior === "cancel") exposed.onCancel()
                },
                destroy() { destroyed = true; state.destroyed++ },
              }
            },
          }
        },
      } })
    }, options.sdk ?? "cancel")
    await page.route("**/api/marketplace{,/**}", (route) => {
      if (new URL(route.request().url()).pathname === "/api/marketplace/paypal-sdk") {
        expect(route.request().method()).toBe("GET")
        return options.config ? options.config(route) : route.fulfill({ json: { clientId: "public-browser-test-client", environment: options.mode === "live" ? "production" : "sandbox" } })
      }
      return mock(route)
    })
  }
  await page.goto(url)
  await page.getByRole("tabpanel").getByRole("button", { name: /foo\.md(?:\s|$)/ }).click()
  const editor = page.getByRole("textbox", { name: "Edit foo.md", exact: true })
  await expect(editor).toHaveValue(saved)
  return {
    mutations, contentReads, external,
    async unchanged(value = saved) {
      await expect(editor).toHaveValue(value)
      await expect(page.getByRole("button", { name: "Current file: foo.md", exact: true })).toHaveAttribute("aria-pressed", "true")
      await expect(page.getByRole("button", { name: "Performance output", exact: true })).toHaveAttribute("aria-pressed", "false")
      expect(await readFile(path.join(root, "foo.md"), "utf8")).toBe(saved)
      expect(await readFile(path.join(root, "foo.md.out"), "utf8")).toBe(retained)
      expect(mutations.filter((request) => !request.path.startsWith("/api/marketplace/"))).toEqual([])
      expect(errors).toEqual([])
      expect(dialogs).toEqual([])
      expect(external).toEqual([])
    },
  }
}

async function open(page: Page, name?: string) {
  await page.getByRole("button", { name: "Purchase Skills", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Skills marketplace", exact: true })
  await expect(dialog).toBeVisible()
  if (name) await dialog.getByRole("navigation", { name: "Available skills" }).getByRole("button", { name: new RegExp(name) }).click()
  return dialog
}

test("real demo previews are gated; explicit simulation and reveal persist across reopen and reload", async ({ page, request }) => {
  const state = await workspace(page)
  const origin = new URL(url).origin
  const headers = { Authorization: `Bearer ${new URL(url).hash.slice("#token=".length)}` }
  for (const endpoint of ["/api/marketplace", "/api/marketplace/skills/code-review/content"]) {
    expect((await request.get(origin + endpoint)).status()).toBe(401)
  }
  expect((await request.post(`${origin}/api/marketplace/orders`, { data: { skillId: "code-review" } })).status()).toBe(401)
  const preview = await request.get(`${origin}/api/marketplace`, { headers })
  expect(preview.status()).toBe(200)
  expect(preview.headers()["cache-control"]).toBe("no-store")
  const data = await preview.json()
  expect(data.mode).toBe("demo")
  expect(data.skills.map((skill: Skill) => skill.id)).toEqual(skills.map((skill) => skill.id))
  expect(JSON.stringify(data)).not.toContain(instruction)
  for (const skill of data.skills) {
    expect(skill).not.toHaveProperty("content")
    expect((await request.get(`${origin}/api/marketplace/skills/${skill.id}/content`, { headers })).status()).toBe(403)
  }
  let dialog = await open(page)
  await expect(dialog).toContainText("EXAMPLES / NO CHARGE")
  for (const skill of data.skills) {
    await dialog.getByRole("navigation").getByRole("button", { name: new RegExp(skill.name) }).click()
    await expect(dialog.getByRole("region", { name: "Skill preview" })).toContainText(skill.description)
    await expect(dialog.locator("pre")).toHaveCount(0)
    await expect(dialog.getByRole("button", { name: "Display full contents" })).toHaveCount(0)
    await expect(dialog.getByRole("button", { name: "Enable editing", exact: true })).toHaveCount(0)
    expect(await dialog.textContent()).not.toContain(instruction)
  }
  expect(state.contentReads).toEqual([])
  expect(state.mutations).toEqual([])
  await dialog.getByRole("navigation").getByRole("button", { name: /Code Review/ }).click()
  const purchase = dialog.getByRole("button", { name: "Purchase Skills", exact: true })
  await expect(purchase).toHaveAccessibleDescription(/Simulated purchase \(no charge\)/)
  expect(await purchase.evaluate((element) => getComputedStyle(element).backgroundImage)).toMatch(/linear-gradient.*rgb\(255, 145, 145\).*rgb\(197, 163, 255\)/)
  await purchase.click()
  await expect(dialog).toContainText("This was a simulation; no payment was made.")
  await expect(dialog.locator("pre")).toHaveCount(0)
  expect(state.contentReads).toEqual([])
  await dialog.getByRole("button", { name: "Display full contents", exact: true }).click()
  await expect(dialog.locator("pre")).toContainText(instruction)
  await dialog.getByRole("button", { name: "Hide full contents", exact: true }).click()
  await expect(dialog.locator("pre")).toHaveCount(0)
  for (const reload of [false, true]) {
    await page.keyboard.press("Escape")
    if (reload) {
      await page.reload()
      await page.getByRole("tabpanel").getByRole("button", { name: /foo\.md(?:\s|$)/ }).click()
    }
    dialog = await open(page, "Code Review")
    await expect(dialog.locator("pre")).toHaveCount(0)
    await expect(dialog.getByRole("button", { name: "Purchase Skills", exact: true })).toHaveCount(0)
    await dialog.getByRole("button", { name: "Display full contents", exact: true }).click()
    await expect(dialog.locator("pre")).toContainText(instruction)
  }
  expect(state.mutations).toEqual([{ path: "/api/marketplace/orders", method: "POST", body: { skillId: "code-review" } }])
  expect(state.contentReads).toHaveLength(3)
  await page.keyboard.press("Escape")
  await state.unchanged()
})

test("Purchase Skills topbar modal traps focus, restores Escape focus, and blocks run shortcuts without editor changes", async ({ page }) => {
  const state = await workspace(page)
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  const editor = page.getByRole("textbox", { name: "Edit foo.md", exact: true })
  await editor.fill(unsaved)
  const opener = page.locator(".topbar").getByRole("button", { name: "Purchase Skills", exact: true })
  await expect(opener).toHaveAttribute("aria-haspopup", "dialog")
  const dialog = await open(page, "Code Review")
  expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(true)
  const close = dialog.getByRole("button", { name: "Close skills marketplace" })
  const buy = dialog.getByRole("button", { name: "Purchase Skills", exact: true })
  await buy.focus()
  await page.keyboard.press("Tab")
  await expect.soft(close, `Tab from the last control focused ${await page.evaluate(() => document.activeElement?.tagName)}`).toBeFocused()
  await close.focus()
  await page.keyboard.press("Shift+Tab")
  await expect.soft(buy, `Shift+Tab from the first control focused ${await page.evaluate(() => document.activeElement?.tagName)}`).toBeFocused()
  await buy.focus()
  await page.getByRole("textbox", { name: "Edit foo.md", exact: true, includeHidden: true }).evaluate((element: HTMLElement) => element.focus())
  await expect(buy).toBeFocused()
  await dialog.getByRole("heading", { name: "Code Review", exact: true }).click()
  await page.keyboard.press("Control+Enter")
  await page.keyboard.press("Meta+Enter")
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(opener).toBeFocused()
  await (await open(page)).getByRole("button", { name: "Close skills marketplace" }).click()
  await expect(opener).toBeFocused()
  expect(state.mutations).toEqual([])
  await expect(page.locator(".editor-pane .badge")).toHaveText("Unsaved")
  await state.unchanged(unsaved)
})

test("large rainbow Purchase Skills launcher stays top-centered without overlapping header controls", async ({ page }) => {
  const state = await workspace(page)
  const opener = page.locator(".topbar").getByRole("button", { name: "Purchase Skills", exact: true })
  for (const width of [1440, 1024, 780, 390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await expect(opener).toBeInViewport()
    const bounds = (await opener.boundingBox())!
    expect(Math.abs(bounds.x + bounds.width / 2 - width / 2)).toBeLessThanOrEqual(1)
    expect(bounds.y).toBeLessThanOrEqual(24)
    expect(bounds.width).toBeGreaterThanOrEqual(240)
    expect(bounds.height).toBeGreaterThanOrEqual(56)
    expect(await opener.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain("linear-gradient")
    for (const neighbor of [page.locator(".topbar > .brand"), page.locator(".topbar-actions")]) {
      const other = (await neighbor.boundingBox())!
      expect(bounds.x + bounds.width <= other.x || other.x + other.width <= bounds.x
        || bounds.y + bounds.height <= other.y || other.y + other.height <= bounds.y).toBe(true)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await opener.click()
    await expect(page.getByRole("dialog", { name: "Skills marketplace", exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(opener).toBeFocused()
  }
  await state.unchanged()
})

test("receipt-backed catalog warns during GitHub outage and still reveals an owned file", async ({ page }) => {
  const state = await workspace(page, async (route) => {
    if (new URL(route.request().url()).pathname === "/api/marketplace") return route.fulfill({ json: { ...catalog([{ ...skills[0], purchased: true }]), warning: "GitHub catalog unavailable. Showing saved purchases and payment orders only." } })
    if (route.request().url().endsWith("/content")) return route.fulfill({ json: { content: full } })
    throw new Error("Unexpected marketplace request")
  })
  const dialog = await open(page, "Code Review")
  await expect(dialog.getByRole("status")).toContainText("GitHub catalog unavailable")
  expect(state.contentReads).toEqual([])
  await dialog.getByRole("button", { name: "Display full contents", exact: true }).click()
  await expect(dialog.locator("pre")).toHaveText(full)
  expect(state.mutations).toEqual([])
  await page.keyboard.press("Escape")
  await state.unchanged()
})

test("explicit replacement leaves unsafe orders locked and opens only the server-confirmed replacement", async ({ page }) => {
  let replacements = 0
  const replacement = { id: "ORDER-TWO", approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-TWO" }
  const state = await workspace(page, async (route) => {
    const endpoint = new URL(route.request().url()).pathname
    if (endpoint === "/api/marketplace") return route.fulfill({ json: catalog([{ ...skills[0], order: order() }]) })
    if (endpoint === "/api/marketplace/orders/ORDER-ONE/replace") {
      replacements++
      return replacements === 1
        ? route.fulfill({ status: 409, json: { error: "Only a confirmed voided unpaid order can be replaced." } })
        : route.fulfill({ json: { ...replacement, purchased: false } })
    }
    throw new Error(`Unexpected marketplace request: ${endpoint}`)
  })
  const dialog = await open(page, "Code Review")
  await dialog.getByText("Expired order?", { exact: true }).click()
  const button = dialog.getByRole("button", { name: "Start a new order", exact: true })
  await button.focus()
  await page.keyboard.press("Tab")
  await expect(dialog.getByRole("button", { name: "Close skills marketplace" })).toBeFocused()
  await button.click()
  await expect(dialog.getByRole("alert")).toContainText("Only a confirmed voided unpaid order")
  await expect(dialog.getByRole("link", { name: /Continue to PayPal/ })).toHaveAttribute("href", order().approvalUrl)
  await button.click()
  await expect(dialog.getByRole("link", { name: /Continue to PayPal/ })).toHaveAttribute("href", replacement.approvalUrl)
  await expect(dialog.getByRole("button", { name: "Display full contents" })).toHaveCount(0)
  expect(state.contentReads).toEqual([])
  expect(state.mutations).toEqual(Array.from({ length: 2 }, () => ({ path: "/api/marketplace/orders/ORDER-ONE/replace", method: "POST", body: {} })))
  await page.keyboard.press("Escape")
  await state.unchanged()
})

test("sandbox pending and failed captures stay locked, restore on reopen, and retry only the same order", async ({ page }) => {
  let created = false
  let captures = 0
  const held = deferred()
  const state = await workspace(page, async (route) => {
    const endpoint = new URL(route.request().url()).pathname
    if (endpoint === "/api/marketplace") return route.fulfill({ json: catalog([{ ...skills[0], ...(created ? { order: order() } : {}) }]) })
    if (endpoint === "/api/marketplace/orders") { created = true; return route.fulfill({ json: { ...order(), purchased: false } }) }
    if (endpoint.endsWith("/capture")) {
      captures++
      if (captures === 1) { await held.promise; return route.fulfill({ json: { purchased: false } }) }
      if (captures === 2) return route.fulfill({ status: 502, json: { error: "Payment declined; retry this same order." } })
      return route.fulfill({ json: { purchased: true } })
    }
    if (endpoint.endsWith("/content")) return route.fulfill({ json: { content: full } })
    throw new Error(`Unexpected marketplace endpoint: ${endpoint}`)
  })
  let dialog = await open(page, "Code Review")
  await dialog.getByRole("button", { name: "Purchase Skills", exact: true }).click()
  const link = dialog.getByRole("link", { name: /Continue to PayPal/ })
  await expect(link).toHaveAttribute("href", order().approvalUrl)
  await expect(link).toHaveAttribute("target", "_blank")
  await expect(link).toHaveAttribute("rel", "noopener noreferrer")
  expect(captures).toBe(0)
  expect(state.contentReads).toEqual([])
  try {
    await dialog.getByRole("button", { name: "Check payment", exact: true }).click()
    await expect.poll(() => captures).toBe(1)
    await expect(dialog.getByRole("button", { name: "Check payment", exact: true })).toBeDisabled()
    await expect(dialog.getByRole("button", { name: "Refresh catalog" })).toBeDisabled()
  } finally { held.resolve() }
  await expect(dialog.getByRole("alert")).toContainText("Payment is not complete")
  await expect(dialog.getByRole("button", { name: "Display full contents" })).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Enable editing", exact: true })).toHaveCount(0)
  await page.keyboard.press("Escape")
  dialog = await open(page, "Code Review")
  await expect(dialog).toContainText("ORDER-ONE")
  await expect(dialog.getByRole("button", { name: "Purchase Skills", exact: true })).toBeEnabled()
  expect(captures).toBe(1)
  await dialog.getByRole("button", { name: "Check payment", exact: true }).click()
  await expect(dialog.getByRole("alert")).toHaveText("Payment declined; retry this same order.")
  await expect(dialog.locator("pre")).toHaveCount(0)
  expect(state.contentReads).toEqual([])
  await dialog.getByRole("button", { name: "Check payment", exact: true }).click()
  await expect(dialog).toContainText("Payment verified")
  expect(state.contentReads).toEqual([])
  await dialog.getByRole("button", { name: "Display full contents", exact: true }).click()
  await expect(dialog.locator("pre")).toHaveText(full)
  expect(state.mutations).toEqual([
    { path: "/api/marketplace/orders", method: "POST", body: { skillId: "code-review" } },
    ...Array.from({ length: 3 }, () => ({ path: "/api/marketplace/orders/ORDER-ONE/capture", method: "POST", body: {} })),
  ])
  await page.keyboard.press("Escape")
  await state.unchanged()
})

test("cancelled live checkout keeps a safe fallback link and never captures without approval", async ({ page }) => {
  const state = await workspace(page, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: catalog(skills, "live") })
    return route.fulfill({ json: { ...order("live"), purchased: false } })
  }, { mode: "live" })
  const dialog = await open(page, "Test Design")
  await expect(dialog).toContainText("PAYPAL LIVE / REAL PAYMENTS")
  expect(state.mutations).toEqual([])
  const purchase = dialog.getByRole("button", { name: "Purchase Skills", exact: true })
  await expect(purchase).toBeEnabled()
  await expect(purchase).toHaveAccessibleDescription(/Live payment, real money/)
  expect(await purchase.evaluate((element) => getComputedStyle(element).backgroundImage)).toMatch(/linear-gradient.*rgb\(255, 145, 145\).*rgb\(197, 163, 255\)/)
  await purchase.click()
  await expect(dialog.getByRole("status")).toContainText("checkout cancelled")
  const link = dialog.getByRole("link", { name: /Continue to PayPal/ })
  await expect(link).toHaveAttribute("href", order("live").approvalUrl)
  await expect(link).toHaveAttribute("target", "_blank")
  await expect(link).toHaveAttribute("rel", "noopener noreferrer")
  // The link is inspected, not followed: this suite never visits a payment provider.
  await expect(dialog.getByRole("button", { name: "Display full contents" })).toHaveCount(0)
  expect(state.contentReads).toEqual([])
  expect(state.mutations).toEqual([{ path: "/api/marketplace/orders", method: "POST", body: { skillId: "test-design" } }])
  await page.keyboard.press("Escape")
  await state.unchanged()
})

test("v6 popup receives an order promise; approval unlocks only after server capture and explicit reveal", async ({ page }) => {
  const heldOrder = deferred()
  const heldCapture = deferred()
  let captures = 0
  const state = await workspace(page, async (route) => {
    const endpoint = new URL(route.request().url()).pathname
    if (endpoint === "/api/marketplace") return route.fulfill({ json: catalog([skills[0]]) })
    if (endpoint === "/api/marketplace/orders") {
      await heldOrder.promise
      return route.fulfill({ json: { ...order(), purchased: false } })
    }
    if (endpoint === "/api/marketplace/orders/ORDER-ONE/capture") {
      captures++
      await heldCapture.promise
      return route.fulfill({ json: { purchased: true } })
    }
    if (endpoint.endsWith("/content")) return route.fulfill({ json: { content: full } })
    throw new Error(`Unexpected marketplace request: ${endpoint}`)
  }, { sdk: "manual" })
  const dialog = await open(page, "Code Review")
  const purchase = dialog.getByRole("button", { name: "Purchase Skills", exact: true })
  await expect(purchase).toBeEnabled()
  await expect(purchase).toHaveAccessibleDescription(/Sandbox test payment, not a real charge/)
  expect(await purchase.evaluate((element) => getComputedStyle(element).backgroundImage)).toMatch(/linear-gradient.*rgb\(255, 145, 145\).*rgb\(197, 163, 255\)/)
  try {
    await purchase.click()
    await expect.poll(() => page.evaluate(() => window.marketplacePayPal.starts)).toEqual([{
      options: { presentationMode: "popup", fullPageOverlay: { enabled: false } },
      promise: true, activeGesture: true, orderId: undefined,
    }])
    expect(await page.evaluate(() => window.marketplacePayPal.instances)).toEqual([{
      clientId: "public-browser-test-client", components: ["paypal-payments"], pageType: "checkout",
    }])
    expect(await page.evaluate(() => window.marketplacePayPal.eligibility)).toEqual([{ currencyCode: "USD" }])
    expect(captures).toBe(0)
    await expect(purchase).toBeDisabled()
  } finally { heldOrder.resolve() }
  await expect.poll(() => page.evaluate(() => window.marketplacePayPal.starts[0].orderId)).toBe("ORDER-ONE")
  try {
    await page.evaluate(() => {
      window.marketplacePayPal.autoComplete = false
      void window.marketplacePayPal.sessions[0].onApprove({ orderId: "ORDER-ONE" })
    })
    await expect.poll(() => captures).toBe(1)
    await expect(dialog.getByRole("status")).toHaveText("Checking and capturing payment...")
    await expect(dialog.getByRole("button", { name: "Display full contents" })).toHaveCount(0)
    expect(state.contentReads).toEqual([])
  } finally { heldCapture.resolve() }
  await expect.poll(() => page.evaluate(() => window.marketplacePayPal.approvals)).toEqual([{ status: "fulfilled", destroyed: false }])
  await expect(dialog.getByRole("button", { name: "Display full contents", exact: true })).toBeDisabled()
  await expect(dialog.getByRole("button", { name: "Refresh catalog" })).toBeDisabled()
  expect(await page.evaluate(() => window.marketplacePayPal.destroyed)).toBe(0)
  await page.evaluate(() => window.marketplacePayPal.sessions[0].onComplete())
  await expect(dialog.getByRole("status")).toContainText("Payment verified")
  await expect(dialog.locator("pre")).toHaveCount(0)
  expect(state.contentReads).toEqual([])
  await expect.poll(() => page.evaluate(() => window.marketplacePayPal.destroyed)).toBe(1)
  expect(await page.evaluate(() => window.marketplacePayPal.completions)).toEqual([{ destroyed: false }])
  await dialog.getByRole("button", { name: "Display full contents", exact: true }).click()
  await expect(dialog.locator("pre")).toHaveText(full)
  expect(state.mutations).toEqual([
    { path: "/api/marketplace/orders", method: "POST", body: { skillId: "code-review" } },
    { path: "/api/marketplace/orders/ORDER-ONE/capture", method: "POST", body: {} },
  ])
  await page.keyboard.press("Escape")
  await state.unchanged()
})

for (const outcome of ["cancel", "error", "popup-failure", "wrong-order"] as const) {
  test(`v6 ${outcome} stays locked and resumes the saved order without creating another payment`, async ({ page }) => {
    let created = false
    const state = await workspace(page, async (route) => {
      const endpoint = new URL(route.request().url()).pathname
      if (endpoint === "/api/marketplace") return route.fulfill({ json: catalog([{ ...skills[0], ...(created ? { order: order() } : {}) }]) })
      if (endpoint === "/api/marketplace/orders") {
        created = true
        return route.fulfill({ json: { ...order(), purchased: false } })
      }
      throw new Error(`Unexpected marketplace request: ${endpoint}`)
    }, { sdk: outcome === "popup-failure" ? outcome : "manual" })
    let dialog = await open(page, "Code Review")
    await dialog.getByRole("button", { name: "Purchase Skills", exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.marketplacePayPal.starts[0]?.orderId)).toBe("ORDER-ONE")
    if (outcome !== "popup-failure") await page.evaluate(async (outcome) => {
      const session = window.marketplacePayPal.sessions[0]
      if (outcome === "cancel") session.onCancel()
      else if (outcome === "error") session.onError()
      else await session.onApprove({ orderId: "OTHER-ORDER" })
    }, outcome)
    const message = { cancel: "checkout cancelled", error: "checkout failed", "popup-failure": "Could not open PayPal", "wrong-order": "different order" }[outcome]
    await expect(dialog.getByRole(outcome === "cancel" ? "status" : "alert")).toContainText(message)
    await expect(dialog.getByRole("button", { name: "Display full contents" })).toHaveCount(0)
    await expect(dialog.getByRole("link", { name: /Continue to PayPal/ })).toHaveAttribute("href", order().approvalUrl)
    await expect(dialog.getByRole("button", { name: "Check payment", exact: true })).toBeEnabled()
    await expect.poll(() => page.evaluate(() => window.marketplacePayPal.destroyed)).toBe(1)
    if (outcome === "wrong-order") expect(await page.evaluate(() => window.marketplacePayPal.approvals)).toEqual([{
      status: "rejected", error: "PayPal returned a different order. Refresh to recover your original purchase.", destroyed: false,
    }])
    await page.keyboard.press("Escape")
    await page.evaluate(() => { window.marketplacePayPal.behavior = "cancel" })
    dialog = await open(page, "Code Review")
    await dialog.getByRole("button", { name: "Purchase Skills", exact: true }).click()
    await expect(dialog.getByRole("status")).toContainText("checkout cancelled")
    expect(await page.evaluate(() => window.marketplacePayPal.starts.map((start) => start.orderId))).toEqual(["ORDER-ONE", "ORDER-ONE"])
    expect(state.mutations).toEqual([{ path: "/api/marketplace/orders", method: "POST", body: { skillId: "code-review" } }])
    expect(state.contentReads).toEqual([])
    await expect(dialog.locator("pre")).toHaveCount(0)
    await page.keyboard.press("Escape")
    await state.unchanged()
  })
}

for (const failure of ["pending", "server-error"] as const) {
  test(`SDK approval with ${failure} capture cannot unlock a saved order`, async ({ page }) => {
    const state = await workspace(page, async (route) => {
      const endpoint = new URL(route.request().url()).pathname
      if (endpoint === "/api/marketplace") return route.fulfill({ json: catalog([{ ...skills[0], order: order() }]) })
      if (endpoint === "/api/marketplace/orders/ORDER-ONE/capture") return failure === "pending"
        ? route.fulfill({ json: { purchased: false } })
        : route.fulfill({ status: 502, json: { error: "Capture verification failed" } })
      throw new Error(`Unexpected marketplace request: ${endpoint}`)
    }, { sdk: "manual" })
    const dialog = await open(page, "Code Review")
    await dialog.getByRole("button", { name: "Purchase Skills", exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.marketplacePayPal.starts[0]?.orderId)).toBe("ORDER-ONE")
    await page.evaluate(async () => {
      window.marketplacePayPal.autoComplete = false
      await window.marketplacePayPal.sessions[0].onApprove({ orderId: "ORDER-ONE" })
    })
    expect(await page.evaluate(() => window.marketplacePayPal.approvals)).toEqual([{
      status: "rejected", destroyed: false,
      error: failure === "pending" ? "Payment is not complete. Full contents remain locked. You can check this same order again." : "Capture verification failed",
    }])
    expect(await page.evaluate(() => window.marketplacePayPal.destroyed)).toBe(0)
    await expect(dialog.getByRole("button", { name: "Check payment", exact: true })).toBeDisabled()
    await page.evaluate(() => window.marketplacePayPal.sessions[0].onComplete())
    await expect(dialog.getByRole("alert")).toContainText(failure === "pending" ? "Payment is not complete" : "Capture verification failed")
    await expect.poll(() => page.evaluate(() => window.marketplacePayPal.destroyed)).toBe(1)
    expect(await page.evaluate(() => window.marketplacePayPal.completions)).toEqual([{ destroyed: false }])
    await expect(dialog.getByRole("button", { name: "Display full contents" })).toHaveCount(0)
    await expect(dialog.getByRole("button", { name: "Check payment", exact: true })).toBeEnabled()
    expect(state.contentReads).toEqual([])
    expect(state.mutations).toEqual([{ path: "/api/marketplace/orders/ORDER-ONE/capture", method: "POST", body: {} }])
    await page.keyboard.press("Escape")
    await state.unchanged()
  })
}

test("popup startup failure before order creation cannot relock a newer recovered purchase", async ({ page }) => {
  const held = deferred()
  let created = false
  const newer = { id: "ORDER-TWO", approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-TWO" }
  const state = await workspace(page, async (route) => {
    const endpoint = new URL(route.request().url()).pathname
    if (endpoint === "/api/marketplace") return route.fulfill({ json: catalog([{ ...skills[0], ...(created ? { order: newer } : {}) }]) })
    if (endpoint === "/api/marketplace/orders") {
      created = true
      await held.promise
      return route.fulfill({ json: { ...order(), purchased: false } })
    }
    if (endpoint === "/api/marketplace/orders/ORDER-TWO/capture") return route.fulfill({ json: { purchased: true } })
    if (endpoint.endsWith("/content")) return route.fulfill({ json: { content: full } })
    throw new Error(`Unexpected marketplace request: ${endpoint}`)
  }, { sdk: "popup-failure-early" })
  const dialog = await open(page, "Code Review")
  try {
    await dialog.getByRole("button", { name: "Purchase Skills", exact: true }).click()
    await expect(dialog.getByRole("alert")).toContainText("Could not open PayPal")
    await expect.poll(() => created).toBe(true)
    expect(await page.evaluate(() => window.marketplacePayPal.orderOutcomes)).toEqual([])
    await expect.poll(() => page.evaluate(() => window.marketplacePayPal.destroyed)).toBe(1)
    await dialog.getByRole("button", { name: "Refresh catalog" }).click()
    await expect(dialog.getByRole("link", { name: /Continue to PayPal/ })).toHaveAttribute("href", newer.approvalUrl)
    await dialog.getByRole("button", { name: "Check payment", exact: true }).click()
    await expect(dialog.getByRole("button", { name: "Display full contents", exact: true })).toBeEnabled()
  } finally { held.resolve() }
  await expect.poll(() => page.evaluate(() => window.marketplacePayPal.orderOutcomes)).toEqual(["rejected"])
  await expect(dialog.getByRole("status")).toContainText("Payment verified")
  await expect(dialog.getByRole("alert")).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Purchase Skills", exact: true })).toHaveCount(0)
  await expect(dialog.getByRole("link", { name: /Continue to PayPal/ })).toHaveCount(0)
  expect(state.contentReads).toEqual([])
  await dialog.getByRole("button", { name: "Display full contents", exact: true }).click()
  await expect(dialog.locator("pre")).toHaveText(full)
  expect(state.mutations).toEqual([
    { path: "/api/marketplace/orders", method: "POST", body: { skillId: "code-review" } },
    { path: "/api/marketplace/orders/ORDER-TWO/capture", method: "POST", body: {} },
  ])
  await page.keyboard.press("Escape")
  await state.unchanged()
})

test("repeated SDK approvals share one capture and finish both handshakes before destruction", async ({ page }) => {
  const held = deferred()
  let captures = 0
  const state = await workspace(page, async (route) => {
    const endpoint = new URL(route.request().url()).pathname
    if (endpoint === "/api/marketplace") return route.fulfill({ json: catalog([{ ...skills[0], order: order() }]) })
    if (endpoint === "/api/marketplace/orders/ORDER-ONE/capture") {
      captures++
      await held.promise
      return route.fulfill({ json: { purchased: true } })
    }
    throw new Error(`Unexpected marketplace request: ${endpoint}`)
  }, { sdk: "manual" })
  const dialog = await open(page, "Code Review")
  try {
    await dialog.getByRole("button", { name: "Purchase Skills", exact: true }).click()
    await page.evaluate(() => {
      window.marketplacePayPal.autoComplete = false
      const session = window.marketplacePayPal.sessions[0]
      void session.onApprove({ orderId: "ORDER-ONE" })
      void session.onApprove({ orderId: "ORDER-ONE" })
    })
    await expect.poll(() => captures).toBe(1)
    await expect(dialog.getByRole("button", { name: "Display full contents" })).toHaveCount(0)
  } finally { held.resolve() }
  await expect.poll(() => page.evaluate(() => window.marketplacePayPal.approvals)).toEqual([
    { status: "fulfilled", destroyed: false }, { status: "fulfilled", destroyed: false },
  ])
  expect(captures).toBe(1)
  expect(await page.evaluate(() => window.marketplacePayPal.destroyed)).toBe(0)
  await expect(dialog.getByRole("button", { name: "Display full contents", exact: true })).toBeDisabled()
  await page.evaluate(() => window.marketplacePayPal.sessions[0].onComplete())
  await expect(dialog.getByRole("button", { name: "Display full contents", exact: true })).toBeEnabled()
  await expect.poll(() => page.evaluate(() => window.marketplacePayPal.destroyed)).toBe(1)
  expect(state.mutations).toEqual([{ path: "/api/marketplace/orders/ORDER-ONE/capture", method: "POST", body: {} }])
  expect(state.contentReads).toEqual([])
  await page.keyboard.press("Escape")
  await state.unchanged()
})

test("synchronous cancellation invalidates approval before onComplete without capturing", async ({ page }) => {
  const state = await workspace(page, async (route) => {
    if (new URL(route.request().url()).pathname === "/api/marketplace") return route.fulfill({ json: catalog([{ ...skills[0], order: order() }]) })
    throw new Error("Cancelled checkout must not capture")
  }, { sdk: "manual" })
  const dialog = await open(page, "Code Review")
  await dialog.getByRole("button", { name: "Purchase Skills", exact: true }).click()
  await page.evaluate(async () => {
    window.marketplacePayPal.autoComplete = false
    const session = window.marketplacePayPal.sessions[0]
    session.onCancel()
    await session.onApprove({ orderId: "ORDER-ONE" })
  })
  expect(await page.evaluate(() => window.marketplacePayPal.approvals)).toEqual([{ status: "rejected", error: "Checkout closed", destroyed: false }])
  expect(await page.evaluate(() => window.marketplacePayPal.destroyed)).toBe(0)
  await expect(dialog.getByRole("button", { name: "Check payment", exact: true })).toBeDisabled()
  await page.evaluate(() => window.marketplacePayPal.sessions[0].onComplete())
  await expect(dialog.getByRole("status")).toContainText("checkout cancelled")
  await expect(dialog.getByRole("button", { name: "Check payment", exact: true })).toBeEnabled()
  await expect(dialog.getByRole("button", { name: "Display full contents" })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.marketplacePayPal.destroyed)).toBe(1)
  expect(state.mutations).toEqual([])
  expect(state.contentReads).toEqual([])
  await page.keyboard.press("Escape")
  await state.unchanged()
})

test("SDK error during capture rejects a late success without unlocking or overwriting the failure", async ({ page }) => {
  const held = deferred()
  let captures = 0
  const state = await workspace(page, async (route) => {
    const endpoint = new URL(route.request().url()).pathname
    if (endpoint === "/api/marketplace") return route.fulfill({ json: catalog([{ ...skills[0], order: order() }]) })
    if (endpoint === "/api/marketplace/orders/ORDER-ONE/capture") {
      captures++
      await held.promise
      return route.fulfill({ json: { purchased: true } })
    }
    throw new Error(`Unexpected marketplace request: ${endpoint}`)
  }, { sdk: "manual" })
  const dialog = await open(page, "Code Review")
  try {
    await dialog.getByRole("button", { name: "Purchase Skills", exact: true }).click()
    await page.evaluate(() => {
      window.marketplacePayPal.autoComplete = false
      void window.marketplacePayPal.sessions[0].onApprove({ orderId: "ORDER-ONE" })
    })
    await expect.poll(() => captures).toBe(1)
    await page.evaluate(() => window.marketplacePayPal.sessions[0].onError())
    expect(await page.evaluate(() => window.marketplacePayPal.destroyed)).toBe(0)
    await expect(dialog.getByRole("button", { name: "Check payment", exact: true })).toBeDisabled()
  } finally { held.resolve() }
  await expect.poll(() => page.evaluate(() => window.marketplacePayPal.approvals)).toEqual([{ status: "rejected", error: "Checkout closed", destroyed: false }])
  await expect(dialog.getByRole("button", { name: "Display full contents" })).toHaveCount(0)
  await expect(dialog).not.toContainText("Payment verified")
  await page.evaluate(() => window.marketplacePayPal.sessions[0].onComplete())
  await expect(dialog.getByRole("alert")).toContainText("PayPal checkout failed")
  await expect(dialog.getByRole("button", { name: "Check payment", exact: true })).toBeEnabled()
  await expect(dialog.getByRole("link", { name: /Continue to PayPal/ })).toHaveAttribute("href", order().approvalUrl)
  await expect.poll(() => page.evaluate(() => window.marketplacePayPal.destroyed)).toBe(1)
  expect(state.mutations).toEqual([{ path: "/api/marketplace/orders/ORDER-ONE/capture", method: "POST", body: {} }])
  expect(state.contentReads).toEqual([])
  await page.keyboard.press("Escape")
  await state.unchanged()
})

test("sandbox to live mode changes fail closed until document reload, including after modal reopen", async ({ page }) => {
  let mode = "sandbox"
  let configs = 0
  const state = await workspace(page, async (route) => {
    if (new URL(route.request().url()).pathname === "/api/marketplace") return route.fulfill({ json: catalog([skills[0]], mode) })
    throw new Error("Mode changes must not create or capture payments")
  }, {
    async config(route) {
      configs++
      return route.fulfill({ json: { clientId: "public-browser-test-client", environment: mode === "live" ? "production" : "sandbox" } })
    },
  })
  let dialog = await open(page, "Code Review")
  await expect(dialog.getByRole("button", { name: "Purchase Skills", exact: true })).toBeEnabled()
  mode = "live"
  await dialog.getByRole("button", { name: "Refresh catalog" }).click()
  await expect(dialog).toContainText("PAYPAL LIVE / REAL PAYMENTS")
  await expect(dialog).toContainText("PayPal mode changed. Save your editor work and reload this page before purchasing.")
  await expect(dialog.getByRole("button", { name: "Purchase Skills", exact: true })).toBeDisabled()
  await dialog.getByRole("button", { name: "Retry PayPal", exact: true }).click()
  await expect.poll(() => configs).toBe(3)
  await expect(dialog).toContainText("reload this page before purchasing")
  await page.keyboard.press("Escape")
  dialog = await open(page, "Code Review")
  await expect(dialog).toContainText("reload this page before purchasing")
  await expect(dialog.getByRole("button", { name: "Purchase Skills", exact: true })).toBeDisabled()
  expect(await page.evaluate(() => window.marketplacePayPal.instances.length)).toBe(1)
  expect(await page.evaluate(() => window.marketplacePayPal.starts)).toEqual([])
  expect(state.mutations).toEqual([])
  expect(state.contentReads).toEqual([])
  await page.keyboard.press("Escape")
  await state.unchanged()
})

test("an already-purchased order response unlocks without capture or automatic content disclosure", async ({ page }) => {
  const state = await workspace(page, async (route) => {
    const endpoint = new URL(route.request().url()).pathname
    if (endpoint === "/api/marketplace") return route.fulfill({ json: catalog([skills[0]]) })
    if (endpoint === "/api/marketplace/orders") return route.fulfill({ json: { id: "ORDER-ONE", approvalUrl: null, purchased: true } })
    throw new Error(`Unexpected marketplace request: ${endpoint}`)
  }, { sdk: "manual" })
  const dialog = await open(page, "Code Review")
  await dialog.getByRole("button", { name: "Purchase Skills", exact: true }).click()
  await expect(dialog.getByRole("status")).toContainText("already owns this skill. No new payment was made")
  await expect(dialog.getByRole("alert")).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Display full contents", exact: true })).toBeEnabled()
  await expect(dialog.locator("pre")).toHaveCount(0)
  expect(state.contentReads).toEqual([])
  expect(state.mutations).toEqual([{ path: "/api/marketplace/orders", method: "POST", body: { skillId: "code-review" } }])
  await expect.poll(() => page.evaluate(() => window.marketplacePayPal.destroyed)).toBe(1)
  await page.keyboard.press("Escape")
  await state.unchanged()
})

for (const failure of ["config-error", "mode-mismatch", "instance-failure", "ineligible"] as const) {
  test(`PayPal readiness ${failure} disables purchases but preserves fallback and explicit retry`, async ({ page }) => {
    const held = deferred()
    let configs = 0
    const state = await workspace(page, async (route) => {
      if (new URL(route.request().url()).pathname === "/api/marketplace") return route.fulfill({ json: catalog([{ ...skills[0], order: order() }]) })
      throw new Error("Readiness must not create or capture orders")
    }, {
      sdk: failure === "instance-failure" || failure === "ineligible" ? failure : "manual",
      async config(route) {
        configs++
        if (configs === 1) {
          await held.promise
          if (failure === "config-error") return route.fulfill({ status: 503, json: { error: "SDK configuration unavailable" } })
        }
        return route.fulfill({ json: { clientId: "public-browser-test-client", environment: configs === 1 && failure === "mode-mismatch" ? "production" : "sandbox" } })
      },
    })
    const dialog = await open(page, "Code Review")
    const purchase = dialog.getByRole("button", { name: "Purchase Skills", exact: true })
    try {
      await expect(dialog).toContainText("Loading secure PayPal checkout")
      await expect(purchase).toBeDisabled()
    } finally { held.resolve() }
    await expect(dialog).toContainText("PayPal checkout is unavailable")
    await expect(purchase).toBeDisabled()
    await expect(dialog.getByRole("button", { name: "Check payment", exact: true })).toBeEnabled()
    await expect(dialog.getByRole("link", { name: /Continue to PayPal/ })).toHaveAttribute("href", order().approvalUrl)
    expect(await page.evaluate(() => window.marketplacePayPal.starts)).toEqual([])
    if (failure === "config-error" || failure === "mode-mismatch") expect(await page.evaluate(() => window.marketplacePayPal.instances)).toEqual([])
    await page.evaluate(() => { window.marketplacePayPal.behavior = "manual" })
    await dialog.getByRole("button", { name: "Retry PayPal", exact: true }).click()
    await expect(purchase).toBeEnabled()
    expect(configs).toBe(2)
    expect(state.mutations).toEqual([])
    expect(state.contentReads).toEqual([])
    await page.keyboard.press("Escape")
    await state.unchanged()
  })
}

test("catalog loading, failure, empty state and explicit retry recover without a purchase", async ({ page }) => {
  const held = deferred()
  let reads = 0
  const state = await workspace(page, async (route) => {
    reads++
    if (reads === 1) { await held.promise; return route.fulfill({ status: 503, json: { error: "Catalog temporarily unavailable" } }) }
    return route.fulfill({ json: catalog(reads === 2 ? [] : skills) })
  })
  const dialog = await open(page)
  try {
    await expect(dialog.getByRole("status")).toHaveText("Loading skills...")
    await expect(dialog.getByRole("button", { name: "Retry catalog" })).toBeDisabled()
    await expect(dialog.getByRole("navigation")).toHaveCount(0)
  } finally { held.resolve() }
  await expect(dialog.getByRole("alert")).toHaveText("Catalog temporarily unavailable")
  await dialog.getByRole("button", { name: "Retry catalog" }).click()
  await expect(dialog).toContainText("No skills are listed in this repository yet")
  await expect(dialog.getByRole("navigation").getByRole("button")).toHaveCount(0)
  await dialog.getByRole("button", { name: "Refresh catalog" }).click()
  await expect(dialog.getByRole("navigation").getByRole("button")).toHaveCount(3)
  await expect(dialog.getByRole("alert")).toHaveCount(0)
  expect(reads).toBe(3)
  expect(state.mutations).toEqual([])
  await page.keyboard.press("Escape")
  await state.unchanged()
})

test("switching skills clears revealed content and renders hostile preview and Markdown literally", async ({ page }) => {
  const attack = '<img src="https://example.invalid/x" onerror="alert(1)"><script>alert(2)</script>'
  const markdown = `${full}${attack}\n[unsafe](javascript:alert(3))\n${"long-line".repeat(100)}`
  const state = await workspace(page, (route) => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("/content")
    ? { content: markdown }
    : catalog([{ ...skills[0], name: attack, description: attack, purchased: true }, skills[1]]) }))
  const dialog = await open(page)
  await dialog.getByRole("navigation").getByRole("button").first().click()
  await expect(dialog.getByRole("heading", { name: attack, exact: true })).toBeVisible()
  await expect(dialog.locator(".skills-description")).toHaveText(attack)
  await expect(dialog.locator("img, script, iframe")).toHaveCount(0)
  expect(state.contentReads).toEqual([])
  await dialog.getByRole("button", { name: "Display full contents", exact: true }).click()
  await expect(dialog.locator("pre")).toHaveText(markdown)
  await expect(dialog.locator("pre a, pre img, pre script")).toHaveCount(0)
  await dialog.getByRole("navigation").getByRole("button", { name: /Test Design/ }).click()
  await expect(dialog.locator("pre")).toHaveCount(0)
  expect(await dialog.textContent()).not.toContain(full)
  await dialog.getByRole("navigation").getByRole("button").first().click()
  await expect(dialog.locator("pre")).toHaveCount(0)
  expect(state.contentReads).toHaveLength(1)
  await page.keyboard.press("Escape")
  await state.unchanged()
})

test("closing an in-flight purchase restores the saved order without stale success or a repeat payment", async ({ page }) => {
  const held = deferred()
  const finished = deferred()
  let created = false
  const state = await workspace(page, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: catalog([{ ...skills[0], ...(created ? { order: order() } : {}) }]) })
    created = true
    await held.promise
    try { await route.fulfill({ json: { ...order(), purchased: false } }) } finally { finished.resolve() }
  })
  let dialog = await open(page, "Code Review")
  try {
    await dialog.getByRole("button", { name: "Purchase Skills", exact: true }).click()
    await expect.poll(() => created).toBe(true)
    await expect(dialog.getByRole("status")).toHaveText("Opening PayPal checkout...")
    await expect(dialog.getByRole("button", { name: "Purchase Skills", exact: true })).toBeDisabled()
    await dialog.getByRole("button", { name: "Close skills marketplace" }).click()
    dialog = await open(page, "Code Review")
    await expect(dialog.getByRole("button", { name: "Check payment", exact: true })).toBeEnabled()
  } finally { held.resolve() }
  await finished.promise
  await expect.poll(() => page.evaluate(() => window.marketplacePayPal.destroyed)).toBe(1)
  await page.evaluate(async () => {
    const stale = window.marketplacePayPal.sessions[0]
    await stale.onApprove({ orderId: "ORDER-ONE" })
    stale.onCancel()
    stale.onError()
  })
  expect(await page.evaluate(() => window.marketplacePayPal.approvals)).toEqual([{ status: "rejected", error: "Checkout closed", destroyed: true }])
  await expect(dialog.getByRole("status")).toHaveCount(0)
  await expect(dialog.getByRole("alert")).toHaveCount(0)
  await expect(dialog.getByRole("link", { name: /Continue to PayPal/ })).toHaveAttribute("href", order().approvalUrl)
  expect(state.mutations).toEqual([{ path: "/api/marketplace/orders", method: "POST", body: { skillId: "code-review" } }])
  expect(state.contentReads).toEqual([])
  await page.keyboard.press("Escape")
  await state.unchanged()
})

test("closing an in-flight reveal cannot leak stale contents into a reopened selection", async ({ page }) => {
  const held = deferred()
  const finished = deferred()
  const state = await workspace(page, async (route) => {
    if (!new URL(route.request().url()).pathname.endsWith("/content")) return route.fulfill({ json: catalog([{ ...skills[0], purchased: true }, skills[1]]) })
    await held.promise
    try { await route.fulfill({ json: { content: full } }) } finally { finished.resolve() }
  })
  let dialog = await open(page, "Code Review")
  try {
    await dialog.getByRole("button", { name: "Display full contents", exact: true }).click()
    await expect(dialog.getByRole("status")).toHaveText("Loading full contents...")
    await page.keyboard.press("Escape")
    dialog = await open(page, "Test Design")
  } finally { held.resolve() }
  await finished.promise
  await expect(dialog.locator("pre")).toHaveCount(0)
  await expect(dialog.getByRole("heading", { name: "Test Design", exact: true })).toBeVisible()
  await expect(dialog.getByRole("status")).toHaveCount(0)
  expect(await dialog.textContent()).not.toContain(full)
  expect(state.contentReads).toHaveLength(1)
  expect(state.mutations).toEqual([])
  await page.keyboard.press("Escape")
  await state.unchanged()
})

test("rejects unsafe or mode-mismatched restored PayPal approval URLs", async ({ page }) => {
  let approvalUrl = ""
  const state = await workspace(page, (route) => route.fulfill({ json: catalog([{ ...skills[0], order: { id: "ORDER-ONE", approvalUrl } }]) }))
  for (const address of [
    "javascript:alert(1)",
    "https://www.sandbox.paypal.com.evil.invalid/checkoutnow?token=ORDER-ONE",
    "https://www.paypal.com/checkoutnow?token=ORDER-ONE",
    "https://www.sandbox.paypal.com/checkoutnow?token=OTHER",
    "https://www.sandbox.paypal.com@evil.invalid/checkoutnow?token=ORDER-ONE",
  ]) {
    approvalUrl = address
    const dialog = await open(page, "Code Review")
    await expect(dialog.getByRole("alert")).toContainText("Invalid approval link")
    await expect(dialog.getByRole("link")).toHaveCount(0)
    await expect(dialog.getByRole("button", { name: "Purchase Skills", exact: true })).toHaveCount(0)
    await page.keyboard.press("Escape")
  }
  expect(state.mutations).toEqual([])
  await state.unchanged()
})

test("390px and 320px layouts keep catalog, purchase controls, and long full contents within the viewport", async ({ page }) => {
  const long = `${full}${"unbroken-markdown-text".repeat(100)}`
  const state = await workspace(page, (route) => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("/content")
    ? { content: long }
    : catalog([{ ...skills[0], purchased: true }, { ...skills[1], order: order() }]) }))
  const dialog = await open(page, "Code Review")
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await dialog.getByRole("navigation").getByRole("button", { name: /Code Review/ }).click()
    await dialog.getByRole("button", { name: "Display full contents", exact: true }).click()
    await expect(dialog.locator("pre")).toHaveText(long)
    for (const control of [dialog.getByRole("button", { name: "Close skills marketplace" }), dialog.getByRole("button", { name: "Hide full contents", exact: true }), dialog.locator("pre")]) {
      await control.scrollIntoViewIfNeeded()
      await expect(control).toBeInViewport()
      const bounds = (await control.boundingBox())!
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
    }
    await dialog.getByRole("navigation").getByRole("button", { name: /Test Design/ }).click()
    for (const control of [dialog.getByRole("button", { name: "Purchase Skills", exact: true }), dialog.getByRole("link", { name: /Continue to PayPal/ }), dialog.getByRole("button", { name: "Check payment", exact: true })]) {
      await control.scrollIntoViewIfNeeded()
      await expect(control).toBeInViewport()
      const bounds = (await control.boundingBox())!
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
    }
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  expect(state.mutations).toEqual([])
  await page.keyboard.press("Escape")
  await state.unchanged()
})

test("Enable editing imports an exact real demo purchase without reveal; only explicit Save persists the copy", async ({ page }) => {
  const state = await workspace(page)
  let dialog = await open(page, "Code Review")
  await dialog.getByRole("button", { name: "Purchase Skills", exact: true }).click()
  await expect(dialog).toContainText("This was a simulation; no payment was made.")
  await expect(dialog.locator("pre")).toHaveCount(0)
  expect(state.contentReads).toEqual([])
  const response = page.waitForResponse((response) => response.url().endsWith("/skills/code-review/content"))
  await dialog.getByRole("button", { name: "Enable editing", exact: true }).click()
  const body = await response
  expect(body.status()).toBe(200)
  expect(body.request().method()).toBe("GET")
  const { content } = await body.json()
  expect(content).toContain(instruction)
  const editor = page.getByRole("textbox", { name: "Edit skill-code-review.md", exact: true })
  await expect(dialog).toBeHidden()
  await expect(editor).toHaveValue(content)
  await expect(editor).toBeFocused()
  await expect(page.locator(".editor-pane .badge")).toHaveText("Unsaved")
  // Wait past normal autosave: importing a buffer is not a user edit.
  await page.waitForTimeout(800)
  await expect(readFile(path.join(root, "skill-code-review.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  expect(state.mutations).toEqual([{ path: "/api/marketplace/orders", method: "POST", body: { skillId: "code-review" } }])
  await page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button", { name: "foo.md", exact: true }).click()
  await state.unchanged()
  await page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button", { name: /^skill-code-review\.md(?:\s|$)/ }).click()
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("Saved skill-code-review.md")
  expect(await readFile(path.join(root, "skill-code-review.md"), "utf8")).toBe(content)
  await page.reload()
  await expect(editor).toHaveValue(content)
  dialog = await open(page, "Code Review")
  await expect(dialog.getByRole("button", { name: "Purchase Skills", exact: true })).toHaveCount(0)
  await expect(dialog.locator("pre")).toHaveCount(0)
  await dialog.getByRole("button", { name: "Display full contents", exact: true }).click()
  expect(await dialog.locator("pre").textContent()).toBe(content)
  expect(state.contentReads).toEqual(Array(2).fill("/api/marketplace/skills/code-review/content"))
  expect(state.mutations).toEqual([
    { path: "/api/marketplace/orders", method: "POST", body: { skillId: "code-review" } },
    { path: "/api/files/skill-code-review.md", method: "PUT", body: { content, revision: null } },
  ])
  expect(await readFile(path.join(root, "foo.md"), "utf8")).toBe(saved)
  expect(await readFile(path.join(root, "foo.md.out"), "utf8")).toBe(retained)
  expect(state.external).toEqual([])
})

test("Enable editing reuses revealed content, fits mobile, and keyboard editing autosaves only the copy", async ({ page }) => {
  const state = await workspace(page, async (route) => {
    const endpoint = new URL(route.request().url()).pathname
    if (endpoint === "/api/marketplace") return route.fulfill({ json: catalog([{ ...skills[0], purchased: true }]) })
    if (endpoint.endsWith("/content")) return route.fulfill({ json: { content: full } })
    throw new Error(`Unexpected marketplace request: ${endpoint}`)
  })
  let dialog = await open(page, "Code Review")
  await dialog.getByRole("button", { name: "Display full contents", exact: true }).click()
  expect(await dialog.locator("pre").textContent()).toBe(full)
  const edit = dialog.getByRole("button", { name: "Enable editing", exact: true })
  await expect(edit).toHaveAccessibleDescription(/purchased original and GitHub file stay unchanged/)
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await edit.scrollIntoViewIfNeeded()
    await expect(edit).toBeInViewport()
    const bounds = (await edit.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await dialog.getByRole("button", { name: "Hide full contents", exact: true }).focus()
  await page.keyboard.press("Tab")
  await expect(edit).toBeFocused()
  await page.keyboard.press("Enter")
  const editor = page.getByRole("textbox", { name: "Edit skill-code-review.md", exact: true })
  await expect(dialog).toBeHidden()
  await expect(editor).toHaveValue(full)
  await expect(editor).toBeFocused()
  await expect(page.locator(".editor-pane .badge")).toHaveText("Unsaved")
  await page.waitForTimeout(800)
  expect(state.contentReads).toEqual(["/api/marketplace/skills/code-review/content"])
  expect(state.mutations).toEqual([])
  await expect(readFile(path.join(root, "skill-code-review.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.keyboard.press("Control+End")
  await page.keyboard.type("My local revision.")
  const content = `${full}My local revision.`
  await expect(editor).toHaveValue(content)
  await expect(page.getByRole("status")).toHaveText("Saved skill-code-review.md")
  expect(await readFile(path.join(root, "skill-code-review.md"), "utf8")).toBe(content)
  await page.reload()
  await expect(editor).toHaveValue(content)
  dialog = await open(page, "Code Review")
  await dialog.getByRole("button", { name: "Display full contents", exact: true }).click()
  expect(await dialog.locator("pre").textContent()).toBe(full)
  expect(state.mutations).toEqual([{ path: "/api/files/skill-code-review.md", method: "PUT", body: { content, revision: null } }])
  expect(await readFile(path.join(root, "foo.md"), "utf8")).toBe(saved)
  expect(await readFile(path.join(root, "foo.md.out"), "utf8")).toBe(retained)
  expect(state.external).toEqual([])
})

test("Enable editing refreshes saved filenames and preserves colliding unsaved tabs and original buffers", async ({ page }) => {
  const state = await workspace(page, async (route) => {
    const endpoint = new URL(route.request().url()).pathname
    if (endpoint === "/api/marketplace") return route.fulfill({ json: catalog([{ ...skills[0], purchased: true }]) })
    if (endpoint.endsWith("/content")) return route.fulfill({ json: { content: full } })
    throw new Error(`Unexpected marketplace request: ${endpoint}`)
  })
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  await page.getByRole("textbox", { name: "Edit foo.md", exact: true }).fill(unsaved)
  // This file appears after the browser's initial listing and must be discovered at import time.
  await writeFile(path.join(root, "skill-code-review.md"), "Existing saved skill copy.\n")
  await page.getByRole("textbox", { name: "New filename" }).fill("skill-code-review-2.md")
  await page.getByRole("button", { name: "Create file" }).click()
  await page.getByRole("textbox", { name: "Edit skill-code-review-2.md", exact: true }).fill("Keep this unsaved tab.")
  for (const suffix of [3, 4]) {
    const dialog = await open(page, "Code Review")
    const listing = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/files")
    await dialog.getByRole("button", { name: "Enable editing", exact: true }).click()
    expect((await listing).status()).toBe(200)
    await expect(dialog).toBeHidden()
    await expect(page.getByRole("textbox", { name: `Edit skill-code-review-${suffix}.md`, exact: true })).toHaveValue(full)
    await expect(page.locator(".editor-pane .badge")).toHaveText("Unsaved")
    await expect(readFile(path.join(root, `skill-code-review-${suffix}.md`), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  }
  const tabs = page.getByRole("navigation", { name: "Editor tabs" })
  for (const [name, content] of [["foo.md", unsaved], ["skill-code-review-2.md", "Keep this unsaved tab."], ["skill-code-review-3.md", full], ["skill-code-review-4.md", full]]) {
    await tabs.getByRole("button", { name: new RegExp(`^${name.replaceAll(".", "\\.")}(?:\\s|$)`) }).click()
    await expect(page.getByRole("textbox", { name: `Edit ${name}`, exact: true })).toHaveValue(content)
  }
  expect(await readFile(path.join(root, "skill-code-review.md"), "utf8")).toBe("Existing saved skill copy.\n")
  await expect(readFile(path.join(root, "skill-code-review-2.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  await tabs.getByRole("button", { name: /^foo\.md(?:\s|$)/ }).click()
  expect(state.mutations).toEqual([])
  await state.unchanged(unsaved)
})

test("Enable editing content 403 and 503 leave the dialog open without a copy and allow retry", async ({ page }) => {
  let reads = 0
  const state = await workspace(page, async (route) => {
    const endpoint = new URL(route.request().url()).pathname
    if (endpoint === "/api/marketplace") return route.fulfill({ json: catalog([{ ...skills[0], purchased: true }]) })
    if (endpoint.endsWith("/content")) {
      const status = [403, 503, 200][reads++]
      return route.fulfill({ status, json: status === 200 ? { content: full } : { error: `Content unavailable (${status})` } })
    }
    throw new Error(`Unexpected marketplace request: ${endpoint}`)
  })
  const dialog = await open(page, "Code Review")
  for (const status of [403, 503]) {
    await dialog.getByRole("button", { name: "Enable editing", exact: true }).click()
    await expect(dialog.getByRole("alert")).toHaveText(`Content unavailable (${status})`)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Enable editing", exact: true })).toBeEnabled()
    await expect(dialog.locator("pre")).toHaveCount(0)
    await expect(page.getByRole("textbox", { name: "Edit skill-code-review.md", exact: true, includeHidden: true })).toHaveCount(0)
    await expect(page.getByRole("textbox", { name: "Edit foo.md", exact: true, includeHidden: true })).toHaveValue(saved)
    expect(state.mutations).toEqual([])
    await expect(readFile(path.join(root, "skill-code-review.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  }
  await dialog.getByRole("button", { name: "Enable editing", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("textbox", { name: "Edit skill-code-review.md", exact: true })).toHaveValue(full)
  expect(state.contentReads).toHaveLength(3)
  await page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button", { name: "foo.md", exact: true }).click()
  await state.unchanged()
})

for (const delayed of ["content", "files"] as const) {
  test(`closing Enable editing during delayed ${delayed} GET prevents late copies and mutations`, async ({ page }) => {
    const held = deferred()
    const started = deferred()
    const finished = deferred()
    const state = await workspace(page, async (route) => {
      const endpoint = new URL(route.request().url()).pathname
      if (endpoint === "/api/marketplace") return route.fulfill({ json: catalog([{ ...skills[0], purchased: true }, skills[1]]) })
      if (endpoint.endsWith("/content")) {
        if (delayed === "content") { started.resolve(); await held.promise }
        try { await route.fulfill({ json: { content: full } }) } finally { if (delayed === "content") finished.resolve() }
        return
      }
      throw new Error(`Unexpected marketplace request: ${endpoint}`)
    })
    if (delayed === "files") await page.route("**/api/files", async (route) => {
      expect(route.request().method()).toBe("GET")
      const response = await route.fetch()
      started.resolve()
      await held.promise
      try { await route.fulfill({ response }) } finally { finished.resolve() }
    })
    let dialog = await open(page, "Code Review")
    try {
      await dialog.getByRole("button", { name: "Enable editing", exact: true }).click()
      await started.promise
      await expect(dialog.getByRole("status")).toHaveText("Opening editable copy...")
      await expect(dialog.getByRole("button", { name: "Enable editing", exact: true })).toBeDisabled()
      if (delayed === "content") await page.keyboard.press("Escape")
      else await dialog.getByRole("button", { name: "Close skills marketplace" }).click()
      await expect(dialog).toBeHidden()
      await expect(page.getByRole("button", { name: "Purchase Skills", exact: true })).toBeFocused()
      dialog = await open(page, "Test Design")
    } finally { held.resolve() }
    await finished.promise
    await page.waitForTimeout(800)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole("heading", { name: "Test Design", exact: true })).toBeVisible()
    await expect(dialog.getByRole("status")).toHaveCount(0)
    await expect(dialog.getByRole("alert")).toHaveCount(0)
    await expect(dialog.locator("pre")).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button", { name: /^skill-/ })).toHaveCount(0)
    await expect(readFile(path.join(root, "skill-code-review.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(state.contentReads).toEqual(["/api/marketplace/skills/code-review/content"])
    expect(state.mutations).toEqual([])
    await state.unchanged()
  })
}
