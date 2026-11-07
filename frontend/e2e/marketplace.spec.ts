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

async function workspace(page: Page, mock?: (route: Route) => Promise<void>) {
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
  if (mock) await page.route("**/api/marketplace{,/**}", mock)
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
  await page.getByRole("button", { name: "Skills", exact: true }).click()
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
    expect(await dialog.textContent()).not.toContain(instruction)
  }
  expect(state.contentReads).toEqual([])
  expect(state.mutations).toEqual([])
  await dialog.getByRole("navigation").getByRole("button", { name: /Code Review/ }).click()
  await dialog.getByRole("button", { name: "Simulate purchase (no charge)", exact: true }).click()
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
    await expect(dialog.getByRole("button", { name: "Simulate purchase", exact: false })).toHaveCount(0)
    await dialog.getByRole("button", { name: "Display full contents", exact: true }).click()
    await expect(dialog.locator("pre")).toContainText(instruction)
  }
  expect(state.mutations).toEqual([{ path: "/api/marketplace/orders", method: "POST", body: { skillId: "code-review" } }])
  expect(state.contentReads).toHaveLength(3)
  await page.keyboard.press("Escape")
  await state.unchanged()
})

test("Skills topbar modal traps focus, restores Escape focus, and blocks run shortcuts without editor changes", async ({ page }) => {
  const state = await workspace(page)
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  const editor = page.getByRole("textbox", { name: "Edit foo.md", exact: true })
  await editor.fill(unsaved)
  const opener = page.locator(".topbar").getByRole("button", { name: "Skills", exact: true })
  await expect(opener).toHaveAttribute("aria-haspopup", "dialog")
  const dialog = await open(page, "Code Review")
  expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(true)
  const close = dialog.getByRole("button", { name: "Close skills marketplace" })
  const buy = dialog.getByRole("button", { name: "Simulate purchase (no charge)", exact: true })
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
  await dialog.getByRole("button", { name: "Buy with PayPal (sandbox)", exact: true }).click()
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
  await page.keyboard.press("Escape")
  dialog = await open(page, "Code Review")
  await expect(dialog).toContainText("ORDER-ONE")
  await expect(dialog.getByRole("button", { name: /Buy with PayPal/ })).toHaveCount(0)
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

test("explicit live purchase uses a safe PayPal new-tab link and never captures automatically", async ({ page }) => {
  const state = await workspace(page, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: catalog(skills, "live") })
    return route.fulfill({ json: { ...order("live"), purchased: false } })
  })
  const dialog = await open(page, "Test Design")
  await expect(dialog).toContainText("PAYPAL LIVE / REAL PAYMENTS")
  expect(state.mutations).toEqual([])
  await dialog.getByRole("button", { name: "Buy with PayPal", exact: true }).click()
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
    await dialog.getByRole("button", { name: "Buy with PayPal (sandbox)", exact: true }).click()
    await expect.poll(() => created).toBe(true)
    await expect(dialog.getByRole("status")).toHaveText("Preparing PayPal order...")
    await expect(dialog.getByRole("button", { name: "Buy with PayPal (sandbox)", exact: true })).toBeDisabled()
    await dialog.getByRole("button", { name: "Close skills marketplace" }).click()
    dialog = await open(page, "Code Review")
    await expect(dialog.getByRole("button", { name: "Check payment", exact: true })).toBeEnabled()
  } finally { held.resolve() }
  await finished.promise
  await expect(dialog.getByRole("status")).toHaveCount(0)
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
    await expect(dialog.getByRole("button", { name: /Buy with PayPal/ })).toHaveCount(0)
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
    for (const control of [dialog.getByRole("link", { name: /Continue to PayPal/ }), dialog.getByRole("button", { name: "Check payment", exact: true })]) {
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
