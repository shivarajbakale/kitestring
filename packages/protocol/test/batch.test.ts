import { describe, expect, it } from "vitest"
import { clampBudget, parseBatchParams } from "../src/index.js"

describe("parseBatchParams", () => {
  it("parses a valid batch and normalises string targets", () => {
    const p = parseBatchParams({
      steps: [
        { action: "goto", url: "https://example.com" },
        { action: "click", target: "Save" },
        { action: "click", target: "@e1k2d9" },
        { action: "fill", target: "Name", value: "x", within: "Profile", role: "textbox" },
      ],
      allow_domains: ["example.org"],
      budget_ms: 12_000,
    })
    expect(p.steps).toHaveLength(4)
    expect(p.steps[1]).toMatchObject({ action: "click", target: { text: "Save" } })
    expect(p.steps[2]).toMatchObject({ target: { ref: "@e1k2d9" } })
    expect(p.steps[3]).toMatchObject({ target: { text: "Name", within: "Profile", role: "textbox" } })
    expect(p.allow_domains).toEqual(["example.org"])
    expect(p.budget_ms).toBe(12_000)
  })
  it("rejects more than 50 steps", () => {
    const steps = Array.from({ length: 51 }, () => ({ action: "press", key: "Enter" }))
    expect(() => parseBatchParams({ steps })).toThrow(/at most 50 steps/)
  })
  it("rejects an empty batch", () => {
    expect(() => parseBatchParams({ steps: [] })).toThrow(/steps/)
  })
  it("requires a value for fill, with a path-qualified message", () => {
    expect(() => parseBatchParams({ steps: [{ action: "fill", target: "Name" }] })).toThrow(/steps\[0\]\.value: required for fill/)
  })
  it("rejects upload with no files", () => {
    expect(() => parseBatchParams({ steps: [{ action: "upload", target: "Drop", files: [] }] })).toThrow(/steps\[0\]\.files/)
  })
  it("rejects an unknown action", () => {
    expect(() => parseBatchParams({ steps: [{ action: "teleport" }] })).toThrow(/steps\[0\]/)
  })
  it("rejects a wait over 10000", () => {
    expect(() => parseBatchParams({ steps: [{ action: "click", target: "A", wait: 20000 }] })).toThrow(/at most 10000/)
  })
  it("accepts wait step with expect, and switch_tab", () => {
    const p = parseBatchParams({
      steps: [
        { action: "wait", ms: 500, expect: { text: "Done" } },
        { action: "switch_tab", to: "new" },
        { action: "switch_tab", to: 7 },
      ],
    })
    expect(p.steps).toHaveLength(3)
  })
})

describe("clampBudget", () => {
  it("defaults and clamps", () => {
    expect(clampBudget()).toBe(40000)
    expect(clampBudget(1000)).toBe(5000)
    expect(clampBudget(99999)).toBe(40000)
    expect(clampBudget(12000)).toBe(12000)
  })
})
