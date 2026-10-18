import { describe, expect, it } from "vitest"
import { echoEntry, findEcho, normEcho } from "../src/record.js"

describe("recording echoes", () => {
  it("normalizes like the plan builder: case-folded, whitespace collapsed", () => {
    expect(normEcho("  Kite   PRO ")).toBe("kite pro")
  })

  it("finds a value inside other text by hash, never storing the value", () => {
    const e = echoEntry("Kite Pro", "store_title")!
    expect(JSON.stringify(e)).not.toMatch(/kite/i)
    expect(findEcho("Preview kite  pro now", [e])?.param).toBe("store_title")
    expect(findEcho("Preview", [e])).toBeUndefined()
  })

  it("prefers the longest echo and ignores values under 3 characters", () => {
    expect(echoEntry("ab", "x")).toBeUndefined()
    const short = echoEntry("Ada", "first")!
    const long = echoEntry("Ada Lovelace", "full")!
    expect(findEcho("Hello Ada Lovelace", [short, long])?.param).toBe("full")
    expect(findEcho("Hello Ada", [short, long])?.param).toBe("first")
  })
})
