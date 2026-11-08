import { afterEach, describe, expect, it, vi } from "vitest"
import { publicPath } from "./deployment"

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

describe("deployment paths", () => {
  it.each(["/", "/paypal/skills-marketplace/"])("keeps requests and navigation inside %s", (base) => {
    vi.stubEnv("BASE_URL", base)
    expect(publicPath()).toBe(base)
    expect(publicPath("api/config")).toBe(`${base}api/config`)
    expect(publicPath("/api/files/a%20b.md?view=log")).toBe(`${base}api/files/a%20b.md?view=log`)
    expect(publicPath("assets/index.js")).toBe(`${base}assets/index.js`)
  })
})

describe("deployment auth", () => {
  it.each([undefined, "0", "true"])("retains workspace bearer auth for %s", async (value) => {
    vi.stubEnv("VITE_SPEC_GATEWAY_AUTH", value)
    const { apiHeaders, gatewayAuth } = await import("./deployment")
    expect(gatewayAuth).toBe(false)
    expect(apiHeaders("test-only-token")).toEqual({ "Content-Type": "application/json", Authorization: "Bearer test-only-token" })
  })

  it("never overrides browser Authorization in gateway mode, even with a stale token", async () => {
    vi.stubEnv("VITE_SPEC_GATEWAY_AUTH", "1")
    const { apiHeaders, gatewayAuth } = await import("./deployment")
    expect(gatewayAuth).toBe(true)
    for (const token of ["", "stale-test-token"]) {
      expect(apiHeaders(token)).toEqual({ "Content-Type": "application/json" })
      expect(new Headers(apiHeaders(token)).has("Authorization")).toBe(false)
    }
  })
})
