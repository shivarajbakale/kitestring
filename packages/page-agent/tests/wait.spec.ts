import { test, expect } from "./harness"

type Cond = Record<string, unknown>
interface Agent {
  waitFor(cond: Cond, ms: number): Promise<{ ok: boolean; seen?: string }>
}
type W = { __kiteAgent: Agent }
const wait = (page: import("@playwright/test").Page, cond: Cond, ms: number) =>
  page.evaluate(([c, m]) => (window as unknown as W).__kiteAgent.waitFor(c as Cond, m as number), [cond, ms] as const)
const later = (page: import("@playwright/test").Page, ms: number, fn: string) =>
  page.evaluate(([m, f]) => void setTimeout(() => new Function(f as string)(), m as number), [ms, fn] as const)

test("a selector that becomes visible resolves as soon as it does", async ({ fixture }) => {
  const page = await fixture("receipt.html")
  await later(page, 300, `const a = document.createElement("article"); a.textContent = "post"; document.getElementById("feed").appendChild(a)`)
  const t0 = Date.now()
  expect(await wait(page, { selector: "article" }, 3_000)).toEqual({ ok: true })
  expect(Date.now() - t0).toBeLessThan(1_000)
})

test("selector states: hidden and detached", async ({ fixture }) => {
  const page = await fixture("receipt.html")
  await later(page, 200, `document.getElementById("go").style.display = "none"`)
  expect(await wait(page, { selector: "#go", state: "hidden" }, 2_000)).toEqual({ ok: true })
  await later(page, 200, `document.getElementById("go").remove()`)
  expect(await wait(page, { selector: "#go", state: "detached" }, 2_000)).toEqual({ ok: true })
})

test("count waits for enough items, and a timeout says how many there were", async ({ fixture }) => {
  const page = await fixture("receipt.html")
  await page.evaluate(() => {
    let n = 0
    const t = setInterval(() => {
      document.getElementById("feed")!.appendChild(document.createElement("article"))
      if (++n === 5) clearInterval(t)
    }, 50)
  })
  expect(await wait(page, { count: { selector: "article", min: 5 } }, 3_000)).toEqual({ ok: true })
  expect(await wait(page, { count: { selector: "article", min: 9 } }, 200)).toEqual({ ok: false, seen: '5 of 9 "article"' })
})

test("text within a section ignores the same text elsewhere on the page", async ({ fixture }) => {
  const page = await fixture("receipt.html")
  // "@" is already in the sidebar: a page-wide wait passes at once, a Feed-scoped one waits for the post.
  expect(await wait(page, { text: "@" }, 0)).toEqual({ ok: true })
  expect((await wait(page, { text: "@", within: "Feed" }, 100)).ok).toBe(false)
  await later(page, 200, `document.getElementById("feed").textContent = "@ada posted"`)
  expect(await wait(page, { text: "@", within: "Feed" }, 2_000)).toEqual({ ok: true })
})

test("text gone, and a /regex/", async ({ fixture }) => {
  const page = await fixture("receipt.html")
  await later(page, 200, `document.querySelector("aside").remove()`)
  expect(await wait(page, { text: "@sidebar", gone: true }, 2_000)).toEqual({ ok: true })
  await later(page, 100, `document.getElementById("out").textContent = "Order #4521 placed"`)
  expect(await wait(page, { text: "/order #\\d+/" }, 2_000)).toEqual({ ok: true })
})

test("a target appears", async ({ fixture }) => {
  const page = await fixture("receipt.html")
  await later(page, 200, `const b = document.createElement("button"); b.textContent = "Load more"; document.body.appendChild(b)`)
  expect(await wait(page, { target: { text: "Load more" } }, 2_000)).toEqual({ ok: true })
})

test("a bad selector fails at once", async ({ fixture }) => {
  const page = await fixture("receipt.html")
  await expect(wait(page, { selector: "[[" }, 2_000)).rejects.toThrow()
})
