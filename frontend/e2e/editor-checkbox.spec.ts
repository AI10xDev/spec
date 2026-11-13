import { test, expect, type Page } from "@playwright/test"
import { createServer, type ViteDevServer } from "vite"

let server: ViteDevServer
let url: string

test.beforeAll(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } })
  await server.listen()
  url = server.resolvedUrls!.local[0]
})
test.afterAll(async () => { await server?.close() })

async function workspace(page: Page, available = true) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    let body: unknown = null
    if (path === "/api/config") body = { execution: false, completion: available }
    else if (path === "/api/files") body = [{ name: "draft.md", modified: 0, bytes: 8 }]
    else if (path === "/api/files/draft.md") body = { name: "draft.md", content: "Original", revision: "1" }
    else if (path === "/api/repository") body = { connected: false, dirty: false, directory: null, model: "fixture" }
    await route.fulfill({ json: body })
  })
  await page.goto(`${url}#token=checkbox-fixture`)
  await page.getByRole("tabpanel").getByRole("button", { name: /draft.md/ }).click()
  return page.getByRole("checkbox", { name: "Trailing completions" })
}

const gradient = "linear-gradient(rgb(198, 40, 40), rgb(27, 78, 245))"

for (const forcedColors of ["none", "active"] as const) {
  test(`editor checkbox preserves label, keyboard, focus and state (${forcedColors})`, async ({ page }, testInfo) => {
    await page.emulateMedia({ forcedColors })
    const checkbox = await workspace(page)
    await expect(checkbox).toBeEnabled()
    await checkbox.check()
    await expect(checkbox).toBeChecked()
    await expect(checkbox).toHaveCSS("appearance", forcedColors === "active" ? "auto" : "none")
    await expect(checkbox).toHaveCSS("background-image", forcedColors === "active" ? "none" : gradient)
    if (forcedColors === "none") {
      expect(await checkbox.evaluate((node) => getComputedStyle(node, "::before").visibility)).toBe("visible")
    } else {
      expect(await checkbox.evaluate((node) => getComputedStyle(node, "::before").content)).toBe("none")
    }
    // Label click must continue to activate the real input.
    await page.locator(".completion-controls label").click()
    await expect(checkbox).not.toBeChecked()
    if (forcedColors === "none") {
      expect(await checkbox.evaluate((node) => getComputedStyle(node, "::before").visibility)).toBe("hidden")
      expect(await checkbox.evaluate((node) => getComputedStyle(node).backgroundImage)).toContain(gradient)
    }
    await page.getByRole("textbox", { name: "Edit draft.md" }).focus()
    await page.keyboard.press("Shift+Tab")
    await expect(checkbox).toBeFocused()
    await expect(checkbox).toHaveCSS("outline-style", "solid")
    await expect(checkbox).toHaveCSS("outline-width", "2px")
    await expect(checkbox).toHaveCSS("outline-offset", "2px")
    await page.keyboard.press("Space")
    await expect(checkbox).toBeChecked()
    await page.screenshot({ path: testInfo.outputPath(`checkbox-${forcedColors}.png`) })
    await page.keyboard.press("Space")
    await expect(checkbox).not.toBeChecked()
  })

  test(`unconfigured editor checkbox stays disabled (${forcedColors})`, async ({ page }) => {
    await page.emulateMedia({ forcedColors })
    const checkbox = await workspace(page, false)
    await expect(checkbox).toBeDisabled()
    await expect(checkbox).not.toBeChecked()
    await expect(checkbox).toHaveCSS("cursor", "not-allowed")
    await expect(checkbox).toHaveCSS("opacity", forcedColors === "active" ? "1" : "0.45")
    // Attempt a real pointer click even though Playwright knows the control is disabled.
    await page.locator(".completion-controls label").click({ force: true })
    await expect(checkbox).not.toBeChecked()
    await page.getByRole("textbox", { name: "Edit draft.md" }).focus()
    await page.keyboard.press("Shift+Tab")
    await expect(checkbox).not.toBeFocused()
  })
}
