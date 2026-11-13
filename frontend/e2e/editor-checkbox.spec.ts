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

// Inspect rendered pixels rather than trusting computed gradients on an invisible input.
for (const width of [1440, 390]) {
  for (const forcedColors of ["none", "active"] as const) {
    for (const available of [true, false]) {
      test(`checkbox has a visible outline (${width}, ${forcedColors}, available=${available})`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ forcedColors })
        const checkbox = await workspace(page, available)
        if (available) await expect(checkbox).toBeEnabled()
        else await expect(checkbox).toBeDisabled()
        for (const checked of available ? [false, true] : [false]) {
          if (available) await checkbox.setChecked(checked)
          await page.getByRole("textbox", { name: "Edit draft.md" }).focus()
          await checkbox.scrollIntoViewIfNeeded()
          const box = (await checkbox.boundingBox())!
          expect(box.width).toBeGreaterThanOrEqual(16)
          expect(box.height).toBeGreaterThanOrEqual(16)
          expect(box.x).toBeGreaterThanOrEqual(0)
          expect(box.x + box.width).toBeLessThanOrEqual(width)
          expect(box.y).toBeGreaterThanOrEqual(0)
          expect(box.y + box.height).toBeLessThanOrEqual(900)
          const image = await page.screenshot({
            path: testInfo.outputPath(`checkbox-${checked}.png`),
            clip: { x: Math.floor(box.x) - 2, y: Math.floor(box.y) - 2, width: Math.ceil(box.width) + 4, height: Math.ceil(box.height) + 4 },
            scale: "css",
          })
          const edges = await page.evaluate(async (base64) => {
            const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
            const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }))
            const canvas = document.createElement("canvas")
            canvas.width = bitmap.width
            canvas.height = bitmap.height
            const context = canvas.getContext("2d")!
            context.drawImage(bitmap, 0, 0)
            bitmap.close()
            const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height)
            function luminance(x: number, y: number) {
              const offset = (y * width + x) * 4
              const rgb = [data[offset], data[offset + 1], data[offset + 2]].map((value) => {
                const s = value / 255
                return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
              })
              return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
            }
            const background = luminance(0, 0)
            const counts = { top: 0, bottom: 0, left: 0, right: 0 }
            for (let y = 2; y < height - 2; y++) {
              for (let x = 2; x < width - 2; x++) {
                const pixel = luminance(x, y)
                const contrast = (Math.max(pixel, background) + 0.05) / (Math.min(pixel, background) + 0.05)
                if (contrast < 3) continue
                if (y < 5) counts.top++
                if (y >= height - 5) counts.bottom++
                if (x < 5) counts.left++
                if (x >= width - 5) counts.right++
              }
            }
            return counts
          }, image.toString("base64"))
          // Every edge needs visible pixels, even when disabled or in high contrast.
          for (const [edge, pixels] of Object.entries(edges)) {
            expect(pixels, `${edge} outline pixels at >= 3:1 contrast, checked=${checked}`).toBeGreaterThanOrEqual(4)
          }
        }
      })
    }
  }
}

const gradient = "linear-gradient(rgb(255, 112, 112), rgb(112, 157, 255))"

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
    await expect(checkbox).toHaveCSS("opacity", forcedColors === "active" ? "1" : "0.75")
    // Attempt a real pointer click even though Playwright knows the control is disabled.
    await page.locator(".completion-controls label").click({ force: true })
    await expect(checkbox).not.toBeChecked()
    await page.getByRole("textbox", { name: "Edit draft.md" }).focus()
    await page.keyboard.press("Shift+Tab")
    await expect(checkbox).not.toBeFocused()
  })
}
