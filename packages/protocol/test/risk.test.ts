import { describe, expect, it } from "vitest"
import { isRisky } from "../src/index.js"

describe("isRisky", () => {
  it("flags risky names", () => {
    for (const n of ["Place order", "Submit for review", "  PAY now ", "Delete", "Place  order"]) {
      expect(isRisky(n), n).toBe(true)
    }
  })
  it("does not flag whole-word near misses", () => {
    for (const n of ["Display settings", "Sender name", "Save draft", "Checkout"]) {
      expect(isRisky(n), n).toBe(false)
    }
  })
})
