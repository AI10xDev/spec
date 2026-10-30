import { test, expect } from "@playwright/test"
import type { Page } from "@playwright/test"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

let server: ChildProcess
let directory: string
let url: string
const record = (metrics: Record<string, number>) => JSON.stringify({ event: "eval", metrics })

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "spec-review-analytics-"))
  await writeFile(path.join(directory, "foo.md"), "Review measured quality.\n")
  await writeFile(path.join(directory, "foo.md.eval"), JSON.stringify({ version: 1, kind: "eval", spec: "foo.md", checks: [{ name: "Quality", metric: "quality", aggregate: "last", operator: ">=", threshold: 0.9 }] }))
  server = spawn(path.resolve("../backend/target/debug/spec"), [], {
    cwd: path.resolve("../backend"),
    // Never inherit provider exports, SSH configuration or the real user's home.
    env: { HOME: directory, PATH: "/usr/bin:/bin", SPEC_WORKSPACE: directory, SPEC_PORT: "0", SPEC_UI_DIR: path.resolve("dist"), SPEC_AI_ENV_FILE: "/dev/null" },
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

test.afterAll(async () => {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => server.kill("SIGKILL"), 10_000)
      server.once("exit", () => { clearTimeout(timeout); resolve() })
      server.kill("SIGTERM")
    })
  }
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function dashboard(page: Page, output: string) {
  const mutations: string[] = []
  await page.route("**/api/**", (route) => {
    const request = route.request()
    if (new URL(request.url()).pathname === "/api/analytics" && request.method() === "POST") {
      return route.fulfill({ json: { report: { id: "11111111-1111-4111-8111-111111111111", name: "foo.md", status: "completed", output, truncated: false, recoverable: false, continuable: false }, runs: [], warnings: [] } })
    }
    if (request.method() === "GET") return route.continue()
    mutations.push(request.url())
    return route.fulfill({ status: 500, json: { error: "Unexpected mutation" } })
  })
  await page.goto(url)
  await page.getByRole("button", { name: "Analytics", exact: true }).click()
  const chooser = page.getByRole("dialog")
  await chooser.getByLabel("Spec to analyse", { exact: true }).selectOption("foo.md")
  await chooser.getByLabel("Evaluation spec (.eval, optional)").selectOption("foo.md.eval")
  await chooser.getByRole("button", { name: "Open analytics", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Analytics: foo.md", exact: true })
  await expect(dialog).toBeVisible()
  expect(mutations).toEqual([])
  return dialog
}

test("quoted examples cannot create a passing check or replace the last observation", async ({ page }) => {
  const example = `Example only:\n\`\`\`json\n${record({ quality: 1 })}\n\`\`\`\n\n    ${record({ quality: 1 })}\n`
  let dialog = await dashboard(page, example)
  await expect(dialog.getByRole("row", { name: /Quality/ }).getByRole("cell")).toHaveText(["No data", ">= 0.9", "inconclusive"])
  await expect(dialog.locator(".metric-chart")).toHaveCount(0)
  await dialog.getByRole("button", { name: "Close analytics", exact: true }).click()
  dialog = await dashboard(page, `${example}\n${record({ quality: 0.5 })}\n${example}`)
  await expect(dialog.getByRole("row", { name: /Quality/ }).getByRole("cell")).toHaveText(["0.5", ">= 0.9", "fail"])
  await expect(dialog.locator(".metric-chart")).toContainText("1 samples")
})

test("container fences and invisible terminal events cannot hide a later failing observation", async ({ page }) => {
  const event = record({ quality: 1 })
  const example = [
    `- \`\`\`json\n  ${event}\n  \`\`\``,
    `1. Outer\n   - ~~~json\n     ${event}\n     ~~~`,
    `> \`\`\`json\n> ${event}`,
    `Example \`\`\n${event}\n\`\` end.`,
    `<!-- comment -->\n\t${event}`,
    `[example]: /example\n    ${event}`,
    `\x1b]0;title\n${event}\nERROR WARNING\n\x07`,
    `\x1bP\n${event}\n\x1b\\`,
    `\x1b]8;;https://example.test\x1b\\\`\`\`json\x1b]8;;\x1b\\\n${event}\n\`\`\``,
    `- \`\`\`json\n  ${event}`,
  ].join("\n\n")
  let dialog = await dashboard(page, example)
  await expect(dialog.getByRole("row", { name: /Quality/ }).getByRole("cell")).toHaveText(["No data", ">= 0.9", "inconclusive"])
  await expect(dialog.locator(".metric-chart")).toHaveCount(0)
  await dialog.getByRole("button", { name: "Close analytics", exact: true }).click()
  dialog = await dashboard(page, `${example}\n\n${record({ quality: 0.5 })}  `)
  await expect(dialog.getByRole("row", { name: /Quality/ }).getByRole("cell")).toHaveText(["0.5", ">= 0.9", "fail"])
  await expect(dialog.locator(".metric-chart")).toContainText("1 samples")
})

for (const colorScheme of ["light", "dark"] as const) {
  test(`forced-colors ${colorScheme} charts render contrasting system-colored labels, axes, series, dots and bars`, async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active", colorScheme })
    const dialog = await dashboard(page, [record({ quality: 0.5, latency_ms: 10 }), record({ quality: 1 }), "ERROR", "WARNING"].join("\n"))
    const colors = await dialog.evaluate((element) => {
      const probe = document.createElement("span")
      probe.style.color = "CanvasText"
      probe.style.backgroundColor = "Canvas"
      element.append(probe)
      const system = { foreground: getComputedStyle(probe).color, background: getComputedStyle(probe).backgroundColor }
      probe.remove()
      const luminance = (color: string) => {
        const channels = color.match(/^rgb\((\d+), (\d+), (\d+)\)$/)
        if (!channels) throw new Error(`Expected opaque RGB color: ${color}`)
        return channels.slice(1).map(Number).map((value) => value / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
      }
      const samples = [
        ["svg text", "fill", 4.5], [".chart-axis", "stroke", 3], [".chart-line", "stroke", 3], [".chart-dot", "fill", 3], [".diagnostic-chart rect", "fill", 3],
      ] as const
      return samples.map(([selector, property, minimum]) => ({
        selector, minimum, system,
        rendered: [...element.querySelectorAll(selector)].map((graphic) => {
          const style = getComputedStyle(graphic)
          let parent: Element | null = graphic
          let background = "rgba(0, 0, 0, 0)"
          while (parent && /^rgba\([^)]*, 0\)$/.test(background)) {
            background = getComputedStyle(parent).backgroundColor
            parent = parent.parentElement
          }
          const foreground = style[property]
          const levels = [luminance(foreground), luminance(background)].sort((a, b) => a - b)
          return { foreground, background, opacity: style.opacity, contrast: (levels[1] + 0.05) / (levels[0] + 0.05) }
        }),
      }))
    })
    const evidence = test.info().outputPath(`forced-colors-${colorScheme}.json`)
    await writeFile(evidence, JSON.stringify(colors, null, 2))
    await test.info().attach(`forced-colors-${colorScheme}`, { path: evidence, contentType: "application/json" })
    for (const { selector, minimum, system, rendered } of colors) {
      expect(rendered.length, selector).toBeGreaterThan(0)
      expect(system.background).toBe(colorScheme === "light" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)")
      for (const sample of rendered) {
        expect(sample.foreground, selector).toBe(system.foreground)
        expect(sample.background, selector).toBe(system.background)
        expect(sample.opacity, selector).toBe("1")
        expect(sample.contrast, `${selector}: ${JSON.stringify(sample)}`).toBeGreaterThanOrEqual(minimum)
      }
    }
  })
}
