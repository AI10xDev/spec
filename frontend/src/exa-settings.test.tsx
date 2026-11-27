import { describe, expect, it } from "vitest"
import { exaDomains } from "./exa-settings"

describe("Exa domain form", () => {
  it("normalizes and deduplicates plain DNS names", () => {
    expect(exaDomains(" EXAMPLE.org, docs.example.org\nexample.org xn--bcher-kva.example", "include")).toEqual(["example.org", "docs.example.org", "xn--bcher-kva.example"])
    expect(exaDomains("ignored stale domain", "any")).toEqual([])
    expect(exaDomains("example.org", "exclude")).toEqual(["example.org"])
  })
  it.each(["", "https://example.org", "user@example.org", "*.example.org", "example.org/path", "example.org:443", "127.0.0.1", "[::1]", "localhost", "a..com", "-x.com", "x-.com", "x.123", "x.é", "x.com.", `${"x".repeat(64)}.com`, Array.from({ length: 21 }, (_, i) => `d${i}.org`).join(",")])("rejects invalid or unbounded lists: %s", (domains) => {
    expect(exaDomains(domains, "include")).toBeNull()
  })
})
