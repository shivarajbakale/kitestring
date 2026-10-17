import { describe, expect, it } from "vitest"
import type { ActionResult } from "@kitestring/protocol"
import { formatResult } from "../src/client/format.js"

const base: ActionResult = { ok: true, status: "done", diff: { added: [], removed: [] }, page: "P" }

describe("formatResult", () => {
  it("prints new tabs for a done result", () => {
    expect(formatResult({ ...base, newTabs: [12, 13] })).toBe("✓ done\n⧉ new tab 12\n⧉ new tab 13\npage: P")
  })
  it("prints errors for any status", () => {
    expect(formatResult({ ...base, errors: ["Email is required"] })).toBe("✓ done\n! Email is required\npage: P")
    expect(
      formatResult({ ...base, ok: false, status: "disabled", detail: "x", errors: ["a", "b"], newTabs: [7] }),
    ).toBe("✗ disabled: x\n⧉ new tab 7\n! a\n! b\npage: P")
  })
  it("omits empty errors and newTabs", () => {
    expect(formatResult({ ...base, errors: [], newTabs: [] })).toBe("✓ done\npage: P")
  })
})
