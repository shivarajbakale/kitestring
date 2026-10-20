import { expect, test, type KiteRun } from "./fixtures"

// Scripts and fast steps do not wait for the page to go idle: each click checks that it landed instead, and
// waitFor waits for exactly what the next step needs. Every case here is one a fast click could get wrong.

/** The script's return value (`→ ...` line), parsed as JSON when it is JSON. */
function value(r: KiteRun): unknown {
  const m = /^→ ([\s\S]*?)\n\(\d+ browser calls?, \d+ ms\)$/m.exec(r.stdout)
  if (!m) throw new Error(`no value in:\n${r.stdout}${r.stderr}`)
  try {
    return JSON.parse(m[1]!)
  } catch {
    return m[1]
  }
}

const RESULT = `return await evaluate(() => String(window.__result))`

test.describe("fast clicks land exactly once", () => {
  test("a click before the app has started waits for it and lands once", async ({ kite, kiteStdin, torture }) => {
    expect((await kite("tab", "new", `${torture}/late-app`)).code).toBe(0)
    const r = await kiteStdin(`await click("Save")\n${RESULT}`, "script", "-")
    expect(value(r)).toBe("saved:1")
  })

  test("a button re-rendered under the pointer is clicked again, once", async ({ kite, kiteStdin, torture }) => {
    await kite("tab", "new", `${torture}/swap-on-hover`)
    const r = await kiteStdin(`await click("Pick me")\n${RESULT}`, "script", "-")
    expect(value(r)).toBe("picked:1")
  })

  test("a toggle is never clicked twice", async ({ kite, kiteStdin, torture }) => {
    await kite("tab", "new", `${torture}/toggle`)
    const r = await kiteStdin(`await click("Notifications")\n${RESULT}`, "script", "-")
    expect(value(r)).toBe("flips:1")
  })

  test("a fast batch gets the same checks", async ({ kite, kiteStdin, torture, context }) => {
    await kite("tab", "new", `${torture}/swap-on-hover`)
    const r = await kiteStdin(JSON.stringify({ steps: [{ action: "click", target: "Pick me" }, { action: "wait", ms: 0 }], wait_idle: "last" }), "batch", "-")
    expect(r.code).toBe(0)
    const page = context.pages().find((p) => p.url().endsWith("/swap-on-hover"))!
    expect(await page.evaluate(() => (window as unknown as { __result?: string }).__result)).toBe("picked:1")
  })
})

test.describe("waitFor", () => {
  test("text within a section waits for the posts, not the sidebar's '@'; count waits for all of them", async ({ kite, kiteStdin, torture }) => {
    await kite("tab", "new", `${torture}/late-list`)
    const r = await kiteStdin(
      `const t0 = Date.now()
       await waitFor({ text: "@" })
       const pageWide = Date.now() - t0
       await waitFor({ text: "@", within: "Timeline" })
       const first = await evaluate(() => document.querySelectorAll("article").length)
       await waitFor({ count: { selector: "article", min: 5 } })
       return { pageWide, first, all: await evaluate(() => document.querySelectorAll("article").length) }`,
      "script",
      "-",
    )
    const v = value(r) as { pageWide: number; first: number; all: number }
    expect(v.pageWide).toBeLessThan(300) // already on the page: why a page-wide wait is the wrong one here
    expect(v.first).toBeGreaterThanOrEqual(1)
    expect(v.all).toBe(5)
  })

  test("fn returns the function's value; a timeout says what it last saw", async ({ kite, kiteStdin, torture }) => {
    await kite("tab", "new", `${torture}/late-list`)
    const r = await kiteStdin(
      `const n = await waitFor({ fn: (min) => { const k = document.querySelectorAll("article").length; return k >= min && k }, arg: 3 })
       try {
         await waitFor({ count: { selector: "article", min: 9 } }, { timeout: 1500 })
         return "no timeout"
       } catch (e) {
         return { n, code: e.code, message: e.message }
       }`,
      "script",
      "-",
    )
    const v = value(r) as { n: number; code: string; message: string }
    expect(v.n).toBeGreaterThanOrEqual(3)
    expect(v.code).toBe("TIMEOUT")
    expect(v.message).toContain('5 of 9 "article"')
  })

  test("a wait outlives a navigation", async ({ kite, kiteStdin, torture }) => {
    await kite("tab", "new", `${torture}/navigate-later`)
    const r = await kiteStdin(`await waitFor({ text: "Arrived" })\n${RESULT}`, "script", "-")
    expect(value(r)).toBe("arrived")
  })

  test("selector states, a target, and url", async ({ kite, kiteStdin, torture }) => {
    await kite("tab", "new", `${torture}/late-list`)
    const r = await kiteStdin(
      `await waitFor({ selector: "article", state: "attached" })
       await waitFor({ target: "Notifications" }, { timeout: 300 }).catch((e) => console.log("missing:", e.code))
       await goto("${torture}/toggle", { waitUntil: "domcontentloaded" })
       await waitFor({ url: "/toggle" })
       await waitFor({ target: "Notifications" })
       await waitFor({ selector: "#nope", state: "detached" })
       return "ok"`,
      "script",
      "-",
    )
    expect(r.stdout).toContain("missing: TIMEOUT")
    expect(value(r)).toBe("ok")
  })
})
