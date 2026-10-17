import { test, expect } from "./harness"

declare global {
  interface Window {
    __kiteAgent: {
      snapshot(opts?: { full?: boolean; scope?: string; maxLines?: number }): string
      resolve(ref: string): Element | null
    }
    rerender(): void
  }
}

const REF_RE = /^@e[0-9a-z]{5}$/

test("snapshot of form fixture", async ({ fixture }) => {
  const page = await fixture("snapshot.html")
  const snap = await page.evaluate(() => window.__kiteAgent.snapshot())
  expect(snap.split("\n")[0]).toMatch(/^page "Checkout" file:\/\/.*snapshot\.html$/)
  expect(snap).toContain('textbox "Email" [@e')
  expect(snap).toContain('button "Continue" [@e')
  expect(snap).toMatch(/button "Continue" \[@e[0-9a-z]{5}\].* disabled/)
  expect(snap).toContain("checked")
  expect(snap).toContain("expanded")
  expect(snap).toContain('value="a@b.co"')
  expect(snap).not.toContain("Secret")
  expect(snap).toMatch(/^main$/m)
  expect(snap).toMatch(/^ {2}heading "Shipping address"$/m)
})

test("every ref matches REF_RE", async ({ fixture }) => {
  const page = await fixture("snapshot.html")
  const snap = await page.evaluate(() => window.__kiteAgent.snapshot({ full: true }))
  const refs = [...snap.matchAll(/\[(@e[^\]]*)\]/g)].map((m) => m[1])
  expect(refs.length).toBeGreaterThan(3)
  for (const r of refs) expect(r).toMatch(REF_RE)
  expect(new Set(refs).size).toBe(refs.length)
})

test("long list collapses", async ({ fixture }) => {
  const page = await fixture("snapshot.html")
  const snap = await page.evaluate(() => window.__kiteAgent.snapshot())
  expect(snap).toContain("(50 items)")
  expect(snap).toContain("+47")
  expect(snap).toContain("Item 0")
  expect(snap).not.toContain("Item 10")
})

test("below the fold only with full", async ({ fixture }) => {
  const page = await fixture("snapshot.html")
  const def = await page.evaluate(() => window.__kiteAgent.snapshot())
  const full = await page.evaluate(() => window.__kiteAgent.snapshot({ full: true }))
  expect(def).not.toContain("Far below")
  expect(full).toContain("Far below")
})

test("maxLines truncates", async ({ fixture }) => {
  const page = await fixture("snapshot.html")
  const snap = await page.evaluate(() => window.__kiteAgent.snapshot({ maxLines: 4 }))
  const lines = snap.split("\n")
  expect(lines.length).toBe(5)
  expect(lines[4]).toMatch(/^… \+\d+ more lines$/)
})

test("scope limits to subtree", async ({ fixture }) => {
  const page = await fixture("snapshot.html")
  const snap = await page.evaluate(() => {
    const full = window.__kiteAgent.snapshot()
    const ref = /textbox "Email" \[(@e\w+)\]/.exec(full)![1]
    return window.__kiteAgent.snapshot({ scope: ref })
  })
  expect(snap).toContain('textbox "Email"')
  expect(snap).not.toContain("Continue")
})

test("refs survive re-render and resolve to new node", async ({ fixture }) => {
  const page = await fixture("rerender.html")
  const grab = () =>
    page.evaluate(() => {
      const s = window.__kiteAgent.snapshot()
      return /button "Pick me" \[(@e\w+)\]/.exec(s)![1]
    })
  const before = await grab()
  await page.evaluate(() => {
    ;(window as any).__old = window.__kiteAgent.resolve((/button "Pick me" \[(@e\w+)\]/.exec(window.__kiteAgent.snapshot())!)[1])
  })
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.rerender())
  const after = await grab()
  expect(after).toBe(before)
  const ok = await page.evaluate((ref) => {
    const el = window.__kiteAgent.resolve(ref)
    return !!el && el.isConnected && el !== (window as any).__old && el.textContent === "Pick me"
  }, before)
  expect(ok).toBe(true)
  // resolve works even without a fresh snapshot after re-render
  await page.evaluate(() => window.rerender())
  const ok2 = await page.evaluate((ref) => window.__kiteAgent.resolve(ref)?.isConnected === true, before)
  expect(ok2).toBe(true)
})

test("interactive elements inside headings are kept", async ({ fixture }) => {
  const page = await fixture("fixes.html")
  const snap = await page.evaluate(() => window.__kiteAgent.snapshot())
  expect(snap).toMatch(/^ {2}heading "Product"\n {4}link "Product" \[@e[0-9a-z]{5}\]$/m)
})

test("password values are masked", async ({ fixture }) => {
  const page = await fixture("fixes.html")
  const snap = await page.evaluate(() => window.__kiteAgent.snapshot())
  expect(snap).not.toContain("hunter2")
  expect(snap).toContain('textbox "Secret pw"')
  expect(snap).toContain('value="••••"')
  expect(snap).toMatch(/"Empty pw" \[@e\w+\] value=""/)
})

test("scope on off-screen element implies full", async ({ fixture }) => {
  const page = await fixture("fixes.html")
  const snap = await page.evaluate(() => {
    const full = window.__kiteAgent.snapshot({ full: true })
    const ref = /button "Deep button" \[(@e\w+)\]/.exec(full)![1]
    return window.__kiteAgent.snapshot({ scope: ref })
  })
  expect(snap).toContain('button "Deep button"')
})

test("fieldset disabled marks descendants disabled", async ({ fixture }) => {
  const page = await fixture("fixes.html")
  const snap = await page.evaluate(() => window.__kiteAgent.snapshot())
  expect(snap).toMatch(/"In fieldset" \[@e\w+\] value="" disabled/)
})
