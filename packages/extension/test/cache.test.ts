import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Locator } from "@kitestring/protocol"
import * as cache from "../background/cache"

let store: Record<string, unknown>
let set: ReturnType<typeof vi.fn>

const loc = (n: number | string): Locator => ({ ref: `@e${n}`, role: "button", name: `B${n}`, landmarkPath: ["main"], cssPath: `#b${n}`, nth: 0 })

beforeEach(() => {
  vi.useFakeTimers()
  store = {}
  set = vi.fn(async (o: Record<string, unknown>) => Object.assign(store, o))
  ;(globalThis as { chrome?: unknown }).chrome = {
    storage: { local: { get: vi.fn(async (k: string) => (k in store ? { [k]: store[k] } : {})), set } },
  }
  cache.resetForTest()
})
afterEach(() => vi.useRealTimers())

describe("cacheKey", () => {
  it("is origin + path pattern + normalized text + role + within", () => {
    const k = cache.cacheKey("https://a.test/items/42?x=1", { text: "  Save  ", role: "button", within: "Profile" })
    expect(k).toBe(["https://a.test", "/items/*", "save", "button", "profile"].join("\n"))
  })
  it("same route, different id, same key", () => {
    const t = { text: "Save" }
    expect(cache.cacheKey("https://a.test/items/1", t)).toBe(cache.cacheKey("https://a.test/items/2", t))
  })
  it("ref targets and unusable urls have no key", () => {
    expect(cache.cacheKey("https://a.test/", { ref: "@e00001" })).toBe("")
    expect(cache.cacheKey("not a url", { text: "x" })).toBe("")
  })
})

describe("cache", () => {
  it("returns a hint without the usage counters and counts the hit", () => {
    cache.remember("k", loc(1))
    expect(cache.getHint("k")).toEqual(loc(1))
    cache.getHint("k")
    expect(cache.getHint("missing")).toBeUndefined()
    expect(cache.stats()).toEqual({ entries: 1, hits: 2, sites: 1 })
  })

  it("overwriting keeps the hit count", () => {
    cache.remember("k", loc(1))
    cache.getHint("k")
    cache.remember("k", loc(2))
    expect(cache.getHint("k")).toEqual(loc(2))
    expect(cache.stats().hits).toBe(2)
  })

  it("evicts the least recently used entry at 5_001", () => {
    for (let i = 0; i < 5_000; i++) cache.remember(`o\n/\n${i}\n\n`, loc(i))
    cache.getHint("o\n/\n0\n\n") // 0 is now the most recently used; 1 is the oldest
    cache.remember("o\n/\nnew\n\n", loc("new"))
    expect(cache.stats().entries).toBe(5_000)
    expect(cache.getHint("o\n/\n1\n\n")).toBeUndefined()
    expect(cache.getHint("o\n/\n0\n\n")).toBeDefined()
    expect(cache.getHint("o\n/\nnew\n\n")).toBeDefined()
  })

  it("coalesces writes within 5 s into one", async () => {
    cache.remember("a\n/\nx\n\n", loc(1))
    await vi.advanceTimersByTimeAsync(2_000)
    cache.remember("a\n/\ny\n\n", loc(2))
    cache.getHint("a\n/\nx\n\n")
    await vi.advanceTimersByTimeAsync(2_900)
    expect(set).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(set).toHaveBeenCalledTimes(1)
    expect((store["kite.cache"] as unknown[]).length).toBe(2)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(set).toHaveBeenCalledTimes(1)
  })

  it("loads what was persisted; entries remembered before the load win", async () => {
    store["kite.cache"] = [
      ["a\n/\nx\n\n", { ...loc("old"), hits: 3, lastUsed: 1 }],
      ["a\n/\nz\n\n", { ...loc("z"), hits: 0, lastUsed: 1 }],
    ]
    cache.remember("a\n/\nx\n\n", loc("new"))
    await cache.ready()
    expect(cache.getHint("a\n/\nx\n\n")).toEqual(loc("new"))
    expect(cache.getHint("a\n/\nz\n\n")).toEqual(loc("z"))
  })

  it("clear(site) removes only that origin and persists at once", async () => {
    cache.remember("https://a.test\n/\nx\n\n", loc(1))
    cache.remember("https://a.test\n/p\ny\n\n", loc(2))
    cache.remember("https://b.test\n/\nx\n\n", loc(3))
    expect(cache.clear("https://a.test")).toBe(2)
    expect(cache.stats()).toMatchObject({ entries: 1, sites: 1 })
    await cache.flush()
    expect((store["kite.cache"] as [string, unknown][]).map(([k]) => k)).toEqual(["https://b.test\n/\nx\n\n"])
    expect(cache.clear()).toBe(1)
    expect(cache.stats().entries).toBe(0)
  })
})
