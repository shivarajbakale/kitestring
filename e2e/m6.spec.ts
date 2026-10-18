import { expect, test } from "./fixtures"

const FORM = [
  { action: "fill", target: "Name", value: "Ada" },
  { action: "fill", target: "Email", value: "ada@x.io" },
  { action: "click", target: "Submit" },
]

test.describe("action cache", () => {
  test("a repeat run of basic-form is served from the cache; stats and clear work", async ({ kite, kiteStdin, context, torture, result }) => {
    const url = `${torture}/basic-form`
    const run = async () => {
      expect((await kite("goto", url)).code).toBe(0) // a fresh page load each time
      const r = await kiteStdin(JSON.stringify(FORM), "--json", "batch", "-")
      const res = JSON.parse(r.stdout)
      expect(res.ok, r.stdout + r.stderr).toBe(true)
      expect(await result(context.pages().find((p) => p.url().startsWith(url))!)).toBe("submitted:Ada:ada@x.io")
      return res.steps as { status: string; cached?: boolean }[]
    }
    expect((await kite("tab", "new", url)).code).toBe(0)

    const first = await run()
    expect(first.map((s) => s.cached)).toEqual([undefined, undefined, undefined])

    const second = await run()
    expect(second.map((s) => s.status)).toEqual(["done", "done", "done"])
    expect(second.map((s) => s.cached)).toEqual([true, true, true])

    const stats = JSON.parse((await kite("--json", "cache", "stats")).stdout)
    expect(stats.entries).toBeGreaterThanOrEqual(3)
    expect(stats.hits).toBeGreaterThanOrEqual(3)
    expect((await kite("cache", "stats")).stdout).toMatch(/\d+ cached elements? on 1 site/)

    expect(JSON.parse((await kite("--json", "cache", "clear")).stdout).cleared).toBeGreaterThanOrEqual(3)
    expect(JSON.parse((await kite("--json", "cache", "stats")).stdout).entries).toBe(0)

    const third = await run()
    expect(third.map((s) => s.cached)).toEqual([undefined, undefined, undefined])
  })

  test("cache clear --site only removes that origin", async ({ kite, kiteStdin, torture }) => {
    await kite("tab", "new", `${torture}/basic-form`)
    await kiteStdin(JSON.stringify(FORM), "--json", "batch", "-")
    const before = JSON.parse((await kite("--json", "cache", "stats")).stdout).entries
    expect(before).toBeGreaterThanOrEqual(3)
    expect(JSON.parse((await kite("--json", "cache", "clear", "--site", "https://elsewhere.test")).stdout).cleared).toBe(0)
    expect(JSON.parse((await kite("--json", "cache", "stats")).stdout).entries).toBe(before)
    const own = new URL(torture).origin
    expect(JSON.parse((await kite("--json", "cache", "clear", "--site", own)).stdout).cleared).toBe(before)
  })
})
