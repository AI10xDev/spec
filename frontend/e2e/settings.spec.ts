import { test, expect, type Page } from "@playwright/test"
import { createServer, type ViteDevServer } from "vite"

let server: ViteDevServer
let url: string
const secret = "test-only-not-a-real-provider-key"
const environment = { provider: "azure", model: "environment-deployment", endpoint: "https://example.openai.azure.com", apiVersion: "2024-10-21", hasApiKey: true, source: "environment" }

test.beforeAll(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } })
  await server.listen()
  url = server.resolvedUrls!.local[0]
})
test.afterAll(async () => { await server?.close() })

async function workspace(page: Page) {
  const state = {
    profile: { ...environment }, reset: { ...environment },
    loadError: false, saveError: false, resetError: false, configError: false,
    loading: null as Promise<void> | null, saving: null as Promise<void> | null,
    chat: false, configReads: 0, fileWrites: 0, builds: 0,
    writes: [] as { method: string; body: Record<string, unknown> }[],
    responses: [] as unknown[], console: [] as string[],
  }
  page.on("console", (message) => state.console.push(message.text()))
  page.on("pageerror", (error) => state.console.push(error.message))
  await page.context().route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    const method = route.request().method()
    let body: unknown = null
    let status = 200
    if (path === "/api/settings") {
      if (method === "GET") {
        await state.loading
        if (state.loadError) { status = 503; body = { error: "unavailable" } }
        else body = state.profile
      } else {
        const payload = route.request().postDataJSON() as Record<string, unknown>
        state.writes.push({ method, body: payload })
        await state.saving
        if (method === "PUT" && state.saveError || method === "DELETE" && state.resetError) {
          status = 400
          body = { error: `Never render raw credential errors: ${secret}` }
        } else {
          state.profile = method === "DELETE" ? { ...state.reset } : {
            provider: String(payload.provider), model: String(payload.model), endpoint: String(payload.endpoint), apiVersion: String(payload.apiVersion),
            hasApiKey: payload.apiKey !== undefined ? !!payload.apiKey : state.profile.hasApiKey && payload.provider === state.profile.provider && payload.endpoint === state.profile.endpoint,
            source: "settings",
          }
          state.chat = state.profile.source !== "none"
          body = state.profile
          state.responses.push(body)
        }
      }
    } else if (path === "/api/config") {
      state.configReads++
      status = state.configError ? 503 : 200
      body = { execution: true, completion: state.chat, chat: state.chat, realtime: false, azureRealtime: false }
    } else if (path === "/api/files") body = [{ name: "draft.md", modified: 0, bytes: 8 }, { name: "other.md", modified: 0, bytes: 5 }]
    else if (path === "/api/files/draft.md" || path === "/api/files/other.md") {
      if (method === "PUT") state.fileWrites++
      body = { name: path.split("/").at(-1), content: method === "PUT" ? route.request().postDataJSON().content : "Original", revision: "revision-1" }
    } else if (path === "/api/repository") body = { connected: false, dirty: false, directory: null, model: "example" }
    else if (path === "/api/runs") { state.builds++; body = { id: "run-1" } }
    else if (path === "/api/agent") body = { content: "", revision: null }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
  })
  await page.goto(`${url}#token=test-workspace-token`)
  await page.getByRole("tabpanel").getByRole("button", { name: /draft.md/ }).click()
  await expect(page.getByRole("textbox", { name: "Edit draft.md" })).toHaveValue("Original")
  return state
}

async function settings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await expect(page.getByRole("heading", { name: "AI settings" })).toBeFocused()
  await expect(page.getByLabel("Provider", { exact: true })).toBeVisible()
}

test("navigation preserves mounted dirty editors, selection, undo and workspace shortcuts", async ({ page }) => {
  const state = await workspace(page)
  await page.getByRole("tabpanel").getByRole("button", { name: /other.md/ }).click()
  await page.getByRole("textbox", { name: "Edit other.md" }).fill("Independent dirty buffer")
  await page.getByRole("navigation", { name: "Editor tabs" }).getByRole("button", { name: "draft.md", exact: true }).click()
  const editor = page.getByRole("textbox", { name: "Edit draft.md" })
  await editor.press("Control+End")
  await editor.pressSequentially(" dirty")
  await editor.press("Shift+ArrowLeft")
  const original = await editor.elementHandle()
  const selection = await editor.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])
  await page.getByRole("tab", { name: /Open tabs/ }).click()
  await page.getByLabel("Filter files").fill("draft")
  await settings(page)
  await expect(editor).toBeHidden()
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
  await expect(page.getByRole("navigation", { name: "Editor tabs" })).toBeHidden()
  await page.getByLabel("Deployment name").fill("settings-edit")
  await page.getByLabel("Deployment name").press("Control+s")
  await page.getByRole("button", { name: "Settings", exact: true }).focus()
  await page.keyboard.press("Control+Enter")
  expect(state.fileWrites).toBe(0)
  expect(state.builds).toBe(0)
  await page.getByRole("button", { name: "Back to workspace" }).click()
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused()
  await expect(editor).toHaveValue("Original dirty")
  await expect(page.locator('textarea[aria-label="Edit other.md"]')).toHaveValue("Independent dirty buffer")
  expect(await editor.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual(selection)
  await expect(page.getByLabel("Filter files")).toHaveValue("draft")
  await expect(page.getByRole("tab", { name: /Open tabs/ })).toHaveAttribute("aria-selected", "true")
  await editor.press("Control+z")
  await expect(editor).toHaveValue("Original")
  await editor.press("Control+Shift+z")
  await expect(editor).toHaveValue("Original dirty")
  await editor.press("Control+s")
  await expect.poll(() => state.fileWrites).toBe(1)
  await expect(page.getByRole("button", { name: "Save & run" })).toBeEnabled()
  page.once("dialog", (dialog) => dialog.accept())
  await editor.press("Control+Enter")
  await expect.poll(() => state.builds).toBe(1)
})

for (const [provider, name] of Object.entries({ azure: "Azure OpenAI", openai: "Standalone OpenAI", claude: "Claude API", openrouter: "OpenRouter", huggingface: "Local Hugging Face" })) {
  test(`saves ${name} using the redacted API contract`, async ({ page }) => {
    const state = await workspace(page)
    await settings(page)
    await page.getByLabel("Provider", { exact: true }).selectOption(provider)
    await expect(page.getByLabel("Provider", { exact: true }).locator("option:checked")).toHaveText(name)
    if (provider === "azure") {
      await page.getByLabel("Deployment name").fill("test-deployment")
      await page.getByLabel("Azure resource endpoint").fill("https://test.openai.azure.com")
      await expect(page.getByLabel("API version")).toHaveValue("2024-10-21")
    } else {
      if (provider === "claude") await expect(page.getByLabel("API version")).toHaveValue("")
      else await expect(page.getByLabel("API version")).toHaveCount(0)
      await expect(page.getByLabel("API base URL")).not.toHaveValue("")
      if (provider === "huggingface") {
        await page.getByLabel("Model ID").fill("local-served-model")
        await expect(page.getByText(/There is no automatic model download/)).toBeVisible()
        await expect(page.getByText(/refers to each execution host/)).toBeVisible()
      } else await expect(page.getByLabel("Model ID")).not.toHaveValue("")
    }
    const key = page.getByLabel(/^API key/)
    await expect(key).toHaveAttribute("type", "password")
    if (provider !== "huggingface") await key.fill(secret)
    const reads = state.configReads
    await page.getByRole("button", { name: "Save settings", exact: true }).click()
    await expect(page.getByRole("status")).toContainText("Settings saved")
    await expect(key).toHaveValue("")
    await expect.poll(() => state.configReads).toBeGreaterThan(reads)
    expect(state.writes).toHaveLength(1)
    expect(state.writes[0]).toMatchObject({ method: "PUT", body: { provider, apiVersion: provider === "azure" ? "2024-10-21" : "" } })
    expect(state.writes[0].body.apiKey).toBe(provider === "huggingface" ? undefined : secret)
    expect(JSON.stringify(state.responses)).not.toContain(secret)
    expect(state.responses[0]).not.toHaveProperty("apiKey")
    expect(state.console.join("\n")).not.toContain(secret)
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(secret)
    await expect(page.locator("body")).not.toContainText(secret)
    await page.getByRole("button", { name: "Back to workspace" }).click()
    await settings(page)
    await expect(key).toHaveValue("")
    await expect(page.getByLabel("Provider", { exact: true })).toHaveValue(provider)
  })
}

test("retains a key only for the same provider and endpoint and clears abandoned keys", async ({ page }) => {
  const state = await workspace(page)
  await settings(page)
  await page.getByLabel("Deployment name").fill("another-deployment")
  await page.getByRole("button", { name: "Save settings", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("Settings saved")
  expect(state.writes[0].body).not.toHaveProperty("apiKey")
  await page.getByLabel("Azure resource endpoint").fill("https://other.openai.azure.com")
  await page.getByRole("button", { name: "Save settings", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("same provider and endpoint")
  expect(state.writes).toHaveLength(1)
  await page.getByLabel("API key").fill(secret)
  await page.getByLabel("Provider", { exact: true }).selectOption("openai")
  await expect(page.getByLabel("API key")).toHaveValue("")
  await page.getByRole("button", { name: "Save settings", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Enter an API key")
  expect(state.writes).toHaveLength(1)
  await page.getByLabel("API key").fill(secret)
  await page.getByRole("button", { name: "Back to workspace" }).click()
  await settings(page)
  await expect(page.getByLabel("API key")).toHaveValue("")
})

test("local keys are retained by omission, replaced, and removed only explicitly", async ({ page }) => {
  const state = await workspace(page)
  state.profile = { provider: "huggingface", model: "local-model", endpoint: "http://127.0.0.1:8000/v1", apiVersion: "", hasApiKey: true, source: "settings" }
  await settings(page)
  const save = page.getByRole("button", { name: "Save settings", exact: true })
  const remove = page.getByRole("checkbox", { name: "Remove configured API key on save" })
  const key = page.getByLabel(/^API key/)
  await expect(remove).not.toBeChecked()
  await save.click()
  await expect(page.getByRole("status")).toContainText("Settings saved")
  expect(state.writes[0].body).not.toHaveProperty("apiKey")
  expect(state.profile.hasApiKey).toBe(true)

  await key.fill(secret)
  await save.click()
  await expect(key).toHaveValue("")
  expect(state.writes[1].body.apiKey).toBe(secret)
  expect(state.profile.hasApiKey).toBe(true)

  await remove.check()
  await expect(key).toBeDisabled()
  expect(state.writes).toHaveLength(2)
  state.saveError = true
  await save.click()
  await expect(page.getByRole("alert")).toContainText("Could not save settings")
  expect(state.writes[2].body.apiKey).toBe("")
  expect(state.profile.hasApiKey).toBe(true)
  await expect(remove).toBeChecked()
  state.saveError = false
  await save.click()
  await expect(remove).toHaveCount(0)
  expect(state.writes[3].body.apiKey).toBe("")
  expect(state.profile.hasApiKey).toBe(false)
  await expect(key).toBeEnabled()
  await page.getByRole("button", { name: "Back to workspace" }).click()
  await settings(page)
  await expect(page.getByText("Local Hugging Face / No key configured", { exact: true })).toBeVisible()
  await save.click()
  await expect(page.getByRole("status")).toContainText("Settings saved")
  expect(state.writes[4].body).not.toHaveProperty("apiKey")
  expect(state.profile.hasApiKey).toBe(false)
})

test("local key removal can be cancelled and does not follow endpoint or provider changes", async ({ page }) => {
  const state = await workspace(page)
  state.profile = { provider: "huggingface", model: "local-model", endpoint: "http://127.0.0.1:8000/v1", apiVersion: "", hasApiKey: true, source: "settings" }
  await settings(page)
  const remove = page.getByRole("checkbox", { name: "Remove configured API key on save" })
  await remove.check()
  await remove.uncheck()
  await expect(page.getByLabel(/^API key/)).toBeEnabled()
  await page.getByRole("button", { name: "Save settings", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("Settings saved")
  expect(state.writes[0].body).not.toHaveProperty("apiKey")
  await remove.check()
  await page.getByLabel("API base URL").fill("http://localhost:9000/v1")
  await expect(remove).toHaveCount(0)
  await page.getByLabel("API base URL").fill(state.profile.endpoint)
  await expect(remove).not.toBeChecked()
  await remove.check()
  await page.getByLabel("Provider", { exact: true }).selectOption("openai")
  await expect(remove).toHaveCount(0)
  await page.getByLabel("Provider", { exact: true }).selectOption("huggingface")
  await expect(remove).not.toBeChecked()
})

for (const suffix of ["/openai/v1", "/openai/v1/", "/openai/v1/responses", "/openai/v1/responses/"]) {
  test(`Azure ${suffix} allows a blank version but a legacy root requires one`, async ({ page }) => {
    const state = await workspace(page)
    state.profile = { ...environment, endpoint: environment.endpoint + suffix, apiVersion: "", source: "settings" }
    await settings(page)
    const version = page.getByLabel("API version")
    const endpoint = page.getByLabel("Azure resource endpoint")
    const save = page.getByRole("button", { name: "Save settings", exact: true })
    await expect(version).toHaveValue("")
    await expect(version).toHaveJSProperty("required", false)
    await save.click()
    await expect(page.getByRole("status")).toContainText("Settings saved")
    expect(state.writes[0].body.apiVersion).toBe("")
    await endpoint.fill(environment.endpoint + "/")
    await page.getByLabel("API key").fill(secret)
    await expect(version).toHaveJSProperty("required", true)
    await save.click()
    await expect(version).toBeFocused()
    expect(state.writes).toHaveLength(1)
    await version.fill("2024-10-21")
    await save.click()
    await expect(page.getByLabel("API key")).toHaveValue("")
    expect(state.writes[1].body.apiVersion).toBe("2024-10-21")
  })
}

test("Claude exposes and preserves its optional version until explicitly edited or cleared", async ({ page }) => {
  const state = await workspace(page)
  state.profile = { provider: "claude", model: "claude-sonnet-4-5", endpoint: "https://api.anthropic.com", apiVersion: "2023-06-01", hasApiKey: true, source: "settings" }
  await settings(page)
  const version = page.getByLabel("API version")
  const save = page.getByRole("button", { name: "Save settings", exact: true })
  await expect(version).toHaveValue("2023-06-01")
  await expect(version).toHaveJSProperty("required", false)
  await page.getByLabel("Model ID").fill("another-claude-model")
  await save.click()
  await expect(page.getByRole("status")).toContainText("Settings saved")
  expect(state.writes[0].body.apiVersion).toBe("2023-06-01")
  expect(state.writes[0].body).not.toHaveProperty("apiKey")
  await version.fill("2024-01-01")
  await save.click()
  await expect.poll(() => state.profile.apiVersion).toBe("2024-01-01")
  await page.getByRole("button", { name: "Back to workspace" }).click()
  await settings(page)
  await expect(version).toHaveValue("2024-01-01")
  await version.fill("")
  await save.click()
  await expect.poll(() => state.profile.apiVersion).toBe("")
  expect(state.writes[2].body.apiVersion).toBe("")
  await page.getByRole("button", { name: "Back to workspace" }).click()
  await settings(page)
  await expect(version).toHaveValue("")
})

test("loading and save failures are retryable without rendering secret-bearing errors", async ({ page }) => {
  const state = await workspace(page)
  state.loadError = true
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Could not load settings")
  await expect(page.getByRole("button", { name: "Save settings", exact: true })).toHaveCount(0)
  state.loadError = false
  await page.getByRole("button", { name: "Retry loading settings" }).click()
  await expect(page.getByLabel("Provider", { exact: true })).toBeVisible()
  await page.getByLabel("API key").fill(secret)
  state.saveError = true
  await page.getByRole("button", { name: "Save settings", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Could not save settings")
  await expect(page.getByLabel("API key")).toHaveValue(secret)
  await expect(page.locator("body")).not.toContainText(secret)
  expect(state.console.join("\n")).not.toContain(secret)
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(secret)
  state.saveError = false
  state.configError = true
  await page.getByRole("button", { name: "Save settings", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("Settings saved")
  await expect(page.getByRole("alert")).toContainText("capability refresh failed")
  await expect(page.getByLabel("API key")).toHaveValue("")
})

test("pending loads and saves expose progress and prevent duplicate mutations", async ({ page }) => {
  const state = await workspace(page)
  let loaded!: () => void
  state.loading = new Promise<void>((resolve) => { loaded = resolve })
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("Loading settings...")
  await expect(page.getByRole("form", { name: "AI settings" })).toHaveCount(0)
  loaded()
  await expect(page.getByLabel("Provider", { exact: true })).toBeVisible()
  let saved!: () => void
  state.saving = new Promise<void>((resolve) => { saved = resolve })
  await page.getByRole("button", { name: "Save settings", exact: true }).click()
  await expect(page.getByRole("button", { name: "Applying..." })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Back to workspace" })).toBeDisabled()
  await expect(page.getByLabel("Provider", { exact: true })).toBeDisabled()
  await page.getByRole("form", { name: "AI settings" }).evaluate((form: HTMLFormElement) => form.requestSubmit())
  await expect.poll(() => state.writes.length).toBe(1)
  saved()
  await expect(page.getByRole("status")).toContainText("Settings saved")
  await expect(page.getByRole("button", { name: "Back to workspace" })).toBeEnabled()
  expect(state.writes).toHaveLength(1)
})

test("reset uses DELETE with an empty body, handles errors and reports environment fallback", async ({ page }) => {
  const state = await workspace(page)
  state.profile.source = "settings"
  await settings(page)
  const reset = page.getByRole("button", { name: "Reset to environment" })
  page.once("dialog", (dialog) => dialog.dismiss())
  await reset.click()
  expect(state.writes).toHaveLength(0)
  state.resetError = true
  page.once("dialog", (dialog) => dialog.accept())
  await reset.click()
  await expect(page.getByRole("alert")).toContainText("Could not reset settings")
  await expect(reset).toBeEnabled()
  state.resetError = false
  page.once("dialog", (dialog) => dialog.accept())
  await reset.click()
  await expect(page.getByRole("status")).toContainText("Server environment configuration is now active")
  await expect(reset).toBeDisabled()
  expect(state.writes.at(-1)).toEqual({ method: "DELETE", body: {} })
  await page.getByRole("button", { name: "Save settings", exact: true }).click()
  await expect(reset).toBeEnabled()
  state.reset = { ...environment, model: "", endpoint: "", hasApiKey: false, source: "none" }
  page.once("dialog", (dialog) => dialog.accept())
  await reset.click()
  await expect(page.getByRole("status")).toContainText("No environment AI configuration is available")
  await expect(page.getByText("None", { exact: true })).toBeVisible()
})

test("settings are usable at 320px with keyboard navigation and no hidden workspace focus", async ({ page }, testInfo) => {
  await workspace(page)
  await page.setViewportSize({ width: 320, height: 740 })
  await settings(page)
  await page.keyboard.press("Tab")
  await expect(page.getByLabel("Provider", { exact: true })).toBeFocused()
  await page.getByLabel("Provider", { exact: true }).selectOption("huggingface")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole("button", { name: "Save settings", exact: true }).scrollIntoViewIfNeeded()
  await expect(page.getByRole("button", { name: "Save settings", exact: true })).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath("settings-mobile.png"), fullPage: true })
})

test("an existing chat popup refreshes capabilities on focus without losing its context", async ({ page }) => {
  const state = await workspace(page)
  const popupPromise = page.waitForEvent("popup")
  await page.getByRole("button", { name: "Open session chat" }).click()
  const popup = await popupPromise
  await expect(popup.getByLabel("Your question")).toBeDisabled()
  await page.bringToFront()
  await settings(page)
  await page.getByRole("button", { name: "Save settings", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("Settings saved")
  const reads = state.configReads
  await popup.bringToFront()
  // Headless window managers do not consistently dispatch native focus events.
  await popup.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect.poll(() => state.configReads).toBeGreaterThan(reads)
  await expect(popup.getByLabel("Your question")).toBeEnabled()
  await expect(popup.getByRole("heading", { name: "draft.md", exact: true })).toBeVisible()
  await popup.close()
})
