import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { startTorture } from "../server.js"

const expected = readFileSync(fileURLToPath(new URL("../expected.md", import.meta.url)), "utf8")
const pages = [...expected.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1])
pages.push("navigating-link-done")

let site: Awaited<ReturnType<typeof startTorture>>
beforeAll(async () => {
  site = await startTorture(0)
})
afterAll(async () => {
  await site.close()
})

describe("torture server", () => {
  it("lists 12 pages in expected.md plus the navigation target", () => {
    expect(pages).toHaveLength(13)
  })
  it.each(pages)("serves /%s with 200", async (name) => {
    const res = await fetch(`${site.url}/${name}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("__result")
  })
  it("returns 204 for analytics", async () => {
    expect((await fetch(`${site.url}/analytics/x`)).status).toBe(204)
  })
  it("returns 404 for unknown pages", async () => {
    expect((await fetch(`${site.url}/nope`)).status).toBe(404)
  })
})
