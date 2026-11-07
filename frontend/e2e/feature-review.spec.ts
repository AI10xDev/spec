import { test, expect } from "@playwright/test"
import type { Page, Route } from "@playwright/test"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ReviewOutput } from "../src/feature-review-export"

let server: ChildProcess
let directory: string
let url: string
const saved = "Review the documented features without running this spec.\n"
const retained = "Existing output must remain unchanged.\n"
const unsaved = "Unsaved editor content must not enter a feature review.\n"
const repositoryUrl = "https://github.com/example/project"
const competitorUrls = ["https://github.com/example/competitor", "https://github.com/example/alternative"]
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4XmNQCKj4f+LOh/8AE5cFe63xRWwAAAAASUVORK5CYII="
const fixture = (illustrated = false): ReviewOutput => ({
  report: {
    title: "Repository feature review",
    summary: "A concise research summary",
    features: [{ name: "Editor", detail: "Documented editing workflow", sources: [1] }],
    findings: [
      { title: "Traceability", detail: "Evidence tied to commits", strength: true, sources: [1, 2] },
      { title: "Coverage gap", detail: "Runtime behavior was not tested", strength: false, sources: [1] },
    ],
    comparison: [{ aspect: "Editing", project: "Integrated", competitors: "Separate", sources: [1, 2] }],
    limitations: ["Documentation review only"],
  },
  sources: [
    { id: 1, url: `${repositoryUrl}/blob/${"a".repeat(40)}/README.md`, title: "Project README", revision: "a".repeat(40), accessed: "1794052800" },
    { id: 2, url: `${competitorUrls[0]}/blob/${"b".repeat(40)}/README.md`, title: "Competitor README", revision: "b".repeat(40), accessed: "1794052860" },
  ],
  warnings: illustrated ? [] : ["GPT-image is unavailable; the report uses a built-in workflow diagram"],
  imageDataUrl: illustrated ? image : null,
})

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "spec-feature-review-e2e-"))
  server = spawn(path.resolve("../backend/target/debug/spec"), [], {
    cwd: path.resolve("../backend"),
    // Real local backend, but no inherited provider credentials or execution configuration.
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

async function workspace(page: Page, post: (route: Route) => Promise<void>, imageConfigured = false) {
  await writeFile(path.join(directory, "foo.md"), saved)
  await writeFile(path.join(directory, "foo.md.out"), retained)
  const mutations: { path: string; method: string; body: unknown }[] = []
  const errors: string[] = []
  const dialogs: string[] = []
  const external: string[] = []
  let statusReads = 0
  page.on("request", (request) => {
    const address = new URL(request.url())
    if (address.protocol.startsWith("http") && address.origin !== new URL(url).origin) external.push(request.url())
    if (address.pathname.startsWith("/api/") && request.method() !== "GET") {
      mutations.push({ path: address.pathname, method: request.method(), body: request.postData() ? request.postDataJSON() : null })
    }
  })
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss() })
  // Only these two provider-facing requests are mocked; all other traffic stays real.
  await page.route("**/api/feature-review", (route) => {
    if (route.request().method() === "GET") {
      statusReads++
      return route.fulfill({ json: { imageConfigured } })
    }
    if (route.request().method() === "POST") return post(route)
    return route.continue()
  })
  const response = await page.goto(url)
  await page.getByRole("tabpanel").getByRole("button", { name: /foo\.md(?:\s|$)/ }).click()
  const editor = page.getByRole("textbox", { name: "Edit foo.md", exact: true })
  await expect(editor).toHaveValue(saved)
  // Isolate review writes from the editor's normal 500 ms focused-window autosave.
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  await editor.fill(unsaved)
  return {
    mutations,
    csp: response!.headers()["content-security-policy"],
    async unchanged() {
      await expect(editor).toHaveValue(unsaved)
      await expect(page.locator(".editor-pane .badge")).toHaveText("Unsaved")
      await expect(page.getByRole("button", { name: "Current file: foo.md", exact: true })).toHaveAttribute("aria-pressed", "true")
      await expect(page.getByRole("button", { name: "Performance output", exact: true })).toHaveAttribute("aria-pressed", "false")
      expect(await readFile(path.join(directory, "foo.md"), "utf8")).toBe(saved)
      expect(await readFile(path.join(directory, "foo.md.out"), "utf8")).toBe(retained)
      expect(mutations.filter((request) => request.path !== "/api/feature-review" || request.method !== "POST")).toEqual([])
      expect(statusReads).toBeGreaterThan(0)
      expect(errors).toEqual([])
      expect(dialogs).toEqual([])
      expect(external).toEqual([])
    },
  }
}

async function open(page: Page) {
  await page.getByRole("button", { name: "Feature review", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Feature review", exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

test("button adjoins Performance output; modal owns focus, blocks run shortcuts and restores focus", async ({ page }) => {
  const state = await workspace(page, (route) => route.fulfill({ json: fixture() }))
  const button = page.getByRole("button", { name: "Feature review", exact: true })
  const performance = page.getByRole("button", { name: "Performance output", exact: true })
  expect(await performance.evaluate((element) => element.nextElementSibling?.textContent)).toBe("Feature review")
  const left = (await performance.boundingBox())!
  const right = (await button.boundingBox())!
  expect(left.x + left.width).toBeLessThanOrEqual(right.x)
  expect(left.y).toBe(right.y)
  const dialog = await open(page)
  expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(true)
  const close = dialog.getByRole("button", { name: "Close feature review" })
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  await close.focus()
  await page.keyboard.press("Tab")
  await expect(dialog.getByLabel("Repository GIT URL", { exact: true })).toBeFocused()
  await page.keyboard.press("Shift+Tab")
  await expect(close).toBeFocused()
  await page.getByRole("textbox", { name: "Edit foo.md", exact: true, includeHidden: true }).evaluate((element: HTMLElement) => element.focus())
  await expect(close).toBeFocused()
  await dialog.getByLabel("Competitor GIT URLs", { exact: false }).fill(competitorUrls[0])
  await page.keyboard.press("Control+Enter")
  await page.keyboard.press("Meta+Enter")
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(button).toBeFocused()
  await (await open(page)).getByRole("button", { name: "Close feature review" }).click()
  await expect(button).toBeFocused()
  expect(state.mutations).toEqual([])
  await state.unchanged()
})

test("validates inputs, submits exactly once while busy, and preserves inputs for an error retry", async ({ page }) => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let attempts = 0
  const state = await workspace(page, async (route) => {
    if (++attempts === 1) {
      await held
      await route.fulfill({ status: 502, json: { error: "Research provider temporarily unavailable" } })
    } else await route.fulfill({ json: fixture() })
  })
  const dialog = await open(page)
  const repository = dialog.getByLabel("Repository GIT URL", { exact: true })
  const competitors = dialog.getByLabel("Competitor GIT URLs", { exact: false })
  const illustrate = dialog.getByRole("checkbox")
  const generate = dialog.getByRole("button", { name: "Generate feature report", exact: true })
  await expect(illustrate).toBeChecked()
  await generate.click()
  expect(await repository.evaluate((element: HTMLInputElement) => element.validity.valueMissing)).toBe(true)
  await repository.fill("not-a-url")
  await competitors.fill(competitorUrls[0])
  await generate.click()
  expect(await repository.evaluate((element: HTMLInputElement) => element.validity.typeMismatch)).toBe(true)
  await repository.fill(repositoryUrl)
  for (const value of [" \n ", [...competitorUrls, "https://github.com/example/third", "https://github.com/example/fourth"].join("\n")]) {
    await competitors.fill(value)
    await generate.click()
    await expect(dialog.getByRole("alert")).toHaveText("Provide one to three competitor repository URLs, one per line.")
  }
  expect(state.mutations).toEqual([])
  await competitors.fill(`  ${competitorUrls[0]}  \n\n ${competitorUrls[1]} \n`)
  await illustrate.uncheck()
  try {
    await generate.click()
    await expect.poll(() => attempts).toBe(1)
    await expect(dialog.locator("form")).toHaveAttribute("aria-busy", "true")
    for (const control of [repository, competitors, illustrate, dialog.getByRole("button", { name: "Researching and generating report...", exact: true })]) await expect(control).toBeDisabled()
    // Exercise the in-flight guard even if another submit event arrives after disabling the button.
    await dialog.locator("form").evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit() })
    await page.keyboard.press("Control+Enter")
    expect(attempts).toBe(1)
  } finally { release() }
  await expect(dialog.getByRole("alert")).toHaveText("Research provider temporarily unavailable")
  await expect(dialog.locator("form")).toHaveAttribute("aria-busy", "false")
  await expect(repository).toHaveValue(repositoryUrl)
  await expect(competitors).toHaveValue(`  ${competitorUrls[0]}  \n\n ${competitorUrls[1]} \n`)
  await expect(illustrate).not.toBeChecked()
  await expect(generate).toBeEnabled()
  await generate.click()
  const result = page.getByRole("dialog", { name: fixture().report.title, exact: true })
  await expect(result.getByRole("heading", { name: fixture().report.title, exact: true })).toBeFocused()
  await expect(result.getByRole("alert")).toHaveCount(0)
  expect(attempts).toBe(2)
  expect(state.mutations).toEqual(Array.from({ length: 2 }, () => ({ path: "/api/feature-review", method: "POST", body: { repositoryUrl, competitorUrls, illustrate: false } })))
  await page.keyboard.press("Escape")
  await state.unchanged()
})

for (const illustrated of [false, true]) {
  test(`responsive report, citations and real downloads with ${illustrated ? "a CSP-permitted PNG" : "an image-unavailable warning"}`, async ({ page }) => {
    const output = fixture(illustrated)
    const state = await workspace(page, (route) => route.fulfill({ json: output }), illustrated)
    const dialog = await open(page)
    await expect(dialog.getByRole("status")).toContainText(illustrated ? "Azure image configuration is present" : "GPT-image is not configured")
    await dialog.getByLabel("Repository GIT URL", { exact: true }).fill(repositoryUrl)
    await dialog.getByLabel("Competitor GIT URLs", { exact: false }).fill(competitorUrls[0])
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    await dialog.getByRole("button", { name: "Generate feature report", exact: true }).click()
    const result = page.getByRole("dialog", { name: output.report.title, exact: true })
    await expect(result.getByRole("heading", { name: output.report.title, exact: true })).toBeFocused()
    for (const name of ["Feature summary", "Key strengths", "Findings", "Competitor comparison", "Feature review workflow", "Limitations", "Sources"]) {
      await expect(result.getByRole("heading", { name, exact: true })).toBeVisible()
    }
    for (const value of [output.report.summary, "Evidence tied to commits", "Runtime behavior was not tested", ...output.report.limitations]) await expect(result).toContainText(value)
    await expect(result.getByRole("table", { name: "Documented features" })).toContainText("Documented editing workflow")
    await expect(result.getByRole("table", { name: "Documentation comparison, not a benchmark" }).getByRole("cell")).toHaveText(["Integrated", "Separate [1][2]"])
    await expect(result.getByRole("list", { name: "Built-in review workflow flowchart" }).getByRole("listitem")).toHaveCount(5)
    for (const source of output.sources) {
      const citation = result.getByRole("link", { name: `Source ${source.id}`, exact: true }).first()
      await expect(citation).toHaveAttribute("href", `#review-source-${source.id}`)
      await citation.click()
      const entry = result.locator(`#review-source-${source.id}`)
      await expect(entry).toBeInViewport()
      const link = entry.getByRole("link", { name: source.title, exact: true })
      await expect(link).toHaveAttribute("href", source.url)
      await expect(link).toHaveAttribute("target", "_blank")
      await expect(link).toHaveAttribute("rel", "noreferrer")
      await expect(entry).toContainText(source.revision)
      await expect(entry).toContainText(new Date(Number(source.accessed) * 1000).toISOString())
    }
    const illustration = result.getByRole("img", { name: "GPT-image illustration of the feature review workflow" })
    if (illustrated) {
      expect(state.csp).toMatch(/(?:^|;)\s*img-src\s+'self'\s+data:\s*(?:;|$)/)
      await expect(illustration).toHaveAttribute("src", image)
      await expect.poll(() => illustration.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth === 2 && element.naturalHeight === 1)).toBe(true)
      await expect(result).toContainText("AI-generated illustration, not evidence")
    } else {
      await expect(result).toContainText(output.warnings[0])
      await expect(result).toContainText("No GPT-image illustration was generated")
      await expect(illustration).toHaveCount(0)
    }
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      expect(await result.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      for (const control of await result.locator(".review-downloads button, .review-image").all()) {
        await control.scrollIntoViewIfNeeded()
        await expect(control).toBeInViewport()
        const bounds = (await control.boundingBox())!
        expect(bounds.x).toBeGreaterThanOrEqual(0)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
      }
    }
    for (const format of ["md", "pdf"] as const) {
      const downloading = page.waitForEvent("download")
      await result.getByRole("button", { name: format === "md" ? "Download .md" : "Download PDF", exact: true }).click()
      const download = await downloading
      expect(download.suggestedFilename()).toBe(`feature-review.${format}`)
      expect(await download.failure()).toBeNull()
      const file = await download.path()
      expect(file).not.toBeNull()
      const bytes = await readFile(file!)
      const content = bytes.toString(format === "pdf" ? "latin1" : "utf8")
      expect(content.startsWith(format === "pdf" ? "%PDF-" : `# ${output.report.title}\n`)).toBe(true)
      for (const section of ["Concise Summary", "Features", "Findings", "Key Strengths", "Comparisons", "Limitations", "Warnings", "Sources", "Workflow", "Evidence Diagram", "Workflow Illustration"]) {
        expect(content).toContain(format === "md" ? `## ${section}` : `(${section})`)
      }
      for (const value of [output.report.title, output.report.summary, "Documented editing workflow", "Evidence tied to commits", "Runtime behavior was not tested", "Integrated", "Separate", "Documentation review only", "[1] [2]", ...output.sources.flatMap((source) => [source.title, source.revision, source.accessed])]) expect(content).toContain(value)
      if (!illustrated) expect(content).toContain(format === "md" ? "GPT\\-image is unavailable" : "GPT-image is unavailable")
      if (format === "md") {
        for (const source of output.sources) expect(content).toContain(source.url)
        expect(content.match(/```mermaid/g)).toHaveLength(2)
        expect(content).toContain(illustrated ? image : "Image not generated")
      } else {
        expect(content.trimEnd().endsWith("%%EOF")).toBe(true)
        const pages = content.match(/\/Type \/Page\b/g)?.length ?? 0
        expect(pages).toBeGreaterThan(0)
        for (let number = 1; number <= pages; number++) expect(content).toContain(`Page ${number} of ${pages}`)
        expect(content).toContain("Select repositories")
        expect(content).toContain("Repository sources")
        expect(content).toContain(illustrated ? "/Subtype /Image" : "Image not generated")
      }
      await expect(result.getByRole("alert")).toHaveCount(0)
    }
    expect(state.mutations).toEqual([{ path: "/api/feature-review", method: "POST", body: { repositoryUrl, competitorUrls: [competitorUrls[0]], illustrate: true } }])
    await result.getByRole("button", { name: "Review another repository", exact: true }).click()
    await expect(page.getByRole("dialog").getByLabel("Repository GIT URL", { exact: true })).toHaveValue(repositoryUrl)
    await page.keyboard.press("Escape")
    await expect(page.getByRole("button", { name: "Feature review", exact: true })).toBeFocused()
    await state.unchanged()
  })
}
