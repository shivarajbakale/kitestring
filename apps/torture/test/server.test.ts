import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { startTorture } from "../server.js"

const expected = readFileSync(fileURLToPath(new URL("../expected.md", import.meta.url)), "utf8")
const pages = [...expected.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1])
pages.push("navigating-link-done", "new-tab-target", "oauth", "multi-page-checkout-shipping", "multi-page-checkout-review", "multi-page-checkout-done")

let site: Awaited<ReturnType<typeof startTorture>>
beforeAll(async () => {
  site = await startTorture(0)
})
afterAll(async () => {
  await site.close()
})

describe("torture server", () => {
  it("lists the pages in expected.md plus the navigation targets", () => {
    expect(pages).toHaveLength(36)
  })
  it.each(pages)("serves /%s with 200", async (name) => {
    const res = await fetch(`${site.url}/${name}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("__result")
  })
  it("/delay/<ms> answers after that long (an app bundle still downloading)", async () => {
    const t0 = Date.now()
    const res = await fetch(`${site.url}/delay/250`)
    expect(res.status).toBe(200)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(240)
  })
  it("returns 204 for analytics", async () => {
    expect((await fetch(`${site.url}/analytics/x`)).status).toBe(204)
  })
  it("/hang sends partial HTML and never finishes", async () => {
    const ac = new AbortController()
    const res = await fetch(`${site.url}/hang`, { signal: ac.signal })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain("<title>Hang</title>")
    const more = await Promise.race([reader.read().then(() => "more"), new Promise((r) => setTimeout(() => r("pending"), 300))])
    expect(more).toBe("pending")
    ac.abort()
  })
  it("/__last-result is 404 until a result is posted, then returns the last one", async () => {
    expect((await fetch(`${site.url}/__last-result`)).status).toBe(404)
    expect((await fetch(`${site.url}/__last-result`, { method: "POST", body: "submitted:Ada:ada@x.io" })).status).toBe(204)
    const res = await fetch(`${site.url}/__last-result`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("submitted:Ada:ada@x.io")
    await fetch(`${site.url}/__last-result`, { method: "POST", body: "second" })
    expect(await (await fetch(`${site.url}/__last-result`)).text()).toBe("second")
  })
  it("returns 404 for unknown pages", async () => {
    expect((await fetch(`${site.url}/nope`)).status).toBe(404)
  })
})
