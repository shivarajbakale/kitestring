import { describe, expect, it } from "vitest"
import { echoEntry, findEcho, normEcho } from "../src/record.js"

describe("recording echoes", () => {
  it("normalizes like the plan builder: case-folded, whitespace collapsed", () => {
    expect(normEcho("  Kite   PRO ")).toBe("kite pro")
  })

  it("finds a value inside other text by hash, never storing the value", () => {
    const e = echoEntry("Kite Pro", "store_title", "s1")!
    expect(JSON.stringify(e)).not.toMatch(/kite/i)
    expect(findEcho("Preview kite  pro now", [e], "s1")?.param).toBe("store_title")
    expect(findEcho("Preview", [e], "s1")).toBeUndefined()
  })

  it("prefers the longest echo and ignores values under 3 characters", () => {
    expect(echoEntry("ab", "x", "s1")).toBeUndefined()
    const short = echoEntry("Ada", "first", "s1")!
    const long = echoEntry("Ada Lovelace", "full", "s1")!
    expect(findEcho("Hello Ada Lovelace", [short, long], "s1")?.param).toBe("full")
    expect(findEcho("Hello Ada", [short, long], "s1")?.param).toBe("first")
  })

  it("is salted: another recording's salt neither reproduces nor matches the hash", () => {
    const a = echoEntry("Kite Pro", "t", "salt-a")!
    expect(echoEntry("Kite Pro", "t", "salt-b")!.h).not.toBe(a.h)
    expect(findEcho("Kite Pro", [a], "salt-b")).toBeUndefined()
  })
})
