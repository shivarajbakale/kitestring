import { describe, expect, it } from "vitest"
import { paramName, slug } from "../src/plan.js"

describe("slug / paramName", () => {
  it("makes kebab slugs", () => {
    expect(slug("Publish a Store Listing!")).toBe("publish-a-store-listing")
    expect(slug("  ???  ")).toBe("plan")
    expect(slug("x".repeat(100)).length).toBe(48)
  })
  it("names params from the target text", () => {
    expect(paramName("Store title")).toBe("store_title")
    expect(paramName("Café")).toBe("cafe")
    expect(paramName("***")).toBe("value")
  })
})
