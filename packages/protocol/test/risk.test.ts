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
  it("folds non-breaking spaces and catches the remaining keywords", () => {
    for (const n of ["Place\u00a0order", "Pay\u00a0now", "Remove account", "Transfer funds", "Publish", "Publish app"]) {
      expect(isRisky(n), n).toBe(true)
    }
    for (const n of ["Remove", "Account settings", "Transferred items", "Published apps"]) {
      expect(isRisky(n), n).toBe(false)
    }
  })
})
