import { test, expect } from "./harness"

type FR =
  | { kind: "found"; ref: string; line: string }
  | { kind: "ambiguous"; candidates: { ref: string; line: string; score: number }[] }
  | { kind: "not_found" }
type T = { ref: string } | { text: string; within?: string; role?: string }

interface Agent {
  find(t: T, intent: "click" | "fill" | "select"): FR
  resolve(ref: string): Element | null
}

test("exact name beats contains", async ({ fixture }) => {
  const page = await fixture("find.html")
  const r = await page.evaluate(() => {
    const f = (window as unknown as { __kiteAgent: Agent }).__kiteAgent.find({ text: "Save", within: "Plain" }, "click")
    return { f, id: f.kind === "found" ? (window as unknown as { __kiteAgent: Agent }).__kiteAgent.resolve(f.ref)?.id : null }
  })
  expect(r.f.kind).toBe("found")
  expect(r.id).toBe("s")
  expect((r.f as { line: string }).line).toMatch(/^button "Save" \[@e[0-9a-z]{5}\]$/)
})

test("two Apply buttons ambiguous; within narrows", async ({ fixture }) => {
  const page = await fixture("find.html")
  const amb = await page.evaluate(() => (window as unknown as { __kiteAgent: Agent }).__kiteAgent.find({ text: "Apply" }, "click"))
  expect(amb.kind).toBe("ambiguous")
  expect((amb as { candidates: unknown[] }).candidates).toHaveLength(2)
  const id = await page.evaluate(() => {
    const f = (window as unknown as { __kiteAgent: Agent }).__kiteAgent.find({ text: "Apply", within: "Profile" }, "click")
    return f.kind === "found" ? (window as unknown as { __kiteAgent: Agent }).__kiteAgent.resolve(f.ref)?.id : f.kind
  })
  expect(id).toBe("pb")
  const nf = await page.evaluate(() => (window as unknown as { __kiteAgent: Agent }).__kiteAgent.find({ text: "Apply", within: "Nope" }, "click"))
  expect(nf.kind).toBe("not_found")
})

test("odd whitespace and case", async ({ fixture }) => {
  const page = await fixture("find.html")
  const id = await page.evaluate(() => {
    const f = (window as unknown as { __kiteAgent: Agent }).__kiteAgent.find({ text: "  save changes " }, "click")
    return f.kind === "found" ? (window as unknown as { __kiteAgent: Agent }).__kiteAgent.resolve(f.ref)?.id : f.kind
  })
  expect(id).toBe("sc")
})

test("fill Email finds the input, not the link", async ({ fixture }) => {
  const page = await fixture("find.html")
  const id = await page.evaluate(() => {
    const f = (window as unknown as { __kiteAgent: Agent }).__kiteAgent.find({ text: "Email" }, "fill")
    return f.kind === "found" ? (window as unknown as { __kiteAgent: Agent }).__kiteAgent.resolve(f.ref)?.id : f.kind
  })
  expect(id).toBe("em")
})

test("icon-only buttons by aria-label and title", async ({ fixture }) => {
  const page = await fixture("find.html")
  const ids = await page.evaluate(() =>
    ["Delete item", "Settings"].map((text) => {
      const f = (window as unknown as { __kiteAgent: Agent }).__kiteAgent.find({ text }, "click")
      return f.kind === "found" ? (window as unknown as { __kiteAgent: Agent }).__kiteAgent.resolve(f.ref)?.id : f.kind
    })
  )
  expect(ids).toEqual(["del", "set"])
})

test("contenteditable is fill-able; role option narrows", async ({ fixture }) => {
  const page = await fixture("find.html")
  const r = await page.evaluate(() => {
    const a = (window as unknown as { __kiteAgent: Agent }).__kiteAgent.find({ text: "Notes" }, "fill")
    const b = (window as unknown as { __kiteAgent: Agent }).__kiteAgent.find({ text: "Email", role: "link" }, "click")
    return [
      a.kind === "found" ? (window as unknown as { __kiteAgent: Agent }).__kiteAgent.resolve(a.ref)?.id : a.kind,
      b.kind === "found" ? (window as unknown as { __kiteAgent: Agent }).__kiteAgent.resolve(b.ref)?.textContent : b.kind
    ]
  })
  expect(r).toEqual(["ce", "Email us"])
})

test("ref target matches resolve; unknown is not_found", async ({ fixture }) => {
  const page = await fixture("find.html")
  const r = await page.evaluate(() => {
    const f = (window as unknown as { __kiteAgent: Agent }).__kiteAgent.find({ text: "Save changes" }, "click")
    if (f.kind !== "found") return null
    const g = (window as unknown as { __kiteAgent: Agent }).__kiteAgent.find({ ref: f.ref }, "fill")
    return { same: g.kind === "found" && g.ref === f.ref && (window as unknown as { __kiteAgent: Agent }).__kiteAgent.resolve(f.ref)?.id === "sc" }
  })
  expect(r?.same).toBe(true)
  const nf = await page.evaluate(() => [
    (window as unknown as { __kiteAgent: Agent }).__kiteAgent.find({ ref: "@e00000" }, "click").kind,
    (window as unknown as { __kiteAgent: Agent }).__kiteAgent.find({ text: "Nonexistent" }, "click").kind
  ])
  expect(nf).toEqual(["not_found", "not_found"])
})

test("within picks the innermost scope, not an ancestor containing the heading", async ({ fixture }) => {
  const page = await fixture("find-wrap.html")
  const id = await page.evaluate(() => {
    const f = (window as unknown as { __kiteAgent: Agent }).__kiteAgent.find({ text: "Apply", within: "Profile" }, "click")
    return f.kind === "found" ? (window as unknown as { __kiteAgent: Agent }).__kiteAgent.resolve(f.ref)?.id : f.kind
  })
  expect(id).toBe("pb")
})

test("contenteditable host only; children are not textboxes", async ({ fixture }) => {
  const page = await fixture("find-ce.html")
  const r = await page.evaluate(() => {
    const a = (window as unknown as { __kiteAgent: Agent & { snapshot(): string } }).__kiteAgent
    const f = a.find({ text: "Notes" }, "fill")
    return { id: f.kind === "found" ? a.resolve(f.ref)?.id : f.kind, snap: a.snapshot() }
  })
  expect(r.id).toBe("ce")
  expect(r.snap.match(/textbox/g)).toHaveLength(1)
})

test("ambiguous capped at 3, sorted desc", async ({ fixture }) => {
  const page = await fixture("find-many.html")
  const r = await page.evaluate(() => (window as unknown as { __kiteAgent: Agent }).__kiteAgent.find({ text: "Apply" }, "click"))
  expect(r.kind).toBe("ambiguous")
  const c = (r as { candidates: { score: number }[] }).candidates
  expect(c).toHaveLength(3)
  expect(c[0].score).toBeGreaterThanOrEqual(c[2].score)
})

test("found carries role, name and the nearest named scope", async ({ fixture }) => {
  const page = await fixture("find.html")
  const r = await page.evaluate(() => {
    const a = (window as unknown as { __kiteAgent: Agent }).__kiteAgent
    return [a.find({ text: "Apply", within: "Billing" }, "click"), a.find({ text: "Save changes" }, "click"), a.find({ text: "Save", within: "Plain" }, "click")]
  })
  expect(r[0]).toMatchObject({ kind: "found", role: "button", name: "Apply", within: "Billing" })
  expect(r[1]).toMatchObject({ kind: "found", role: "button", name: "Save changes" })
  expect((r[1] as { within?: string }).within).toBeUndefined()
  expect(r[2]).toMatchObject({ role: "button", name: "Save", within: "Plain" })
})

test("hasText is a case-folded substring of the visible text", async ({ fixture }) => {
  const page = await fixture("find.html")
  const r = await page.evaluate(() => {
    const a = (window as unknown as { __kiteAgent: { hasText(t: string): boolean } }).__kiteAgent
    return [a.hasText("profile"), a.hasText("BILLING"), a.hasText("nope")]
  })
  expect(r).toEqual([true, true, false])
})

test("within falls back to an outer scope when the innermost one does not hold the target", async ({ fixture }) => {
  const page = await fixture("find-outer-scope.html")
  const r = await page.evaluate(() => {
    const a = (window as unknown as { __kiteAgent: Agent }).__kiteAgent
    const f = a.find({ text: "Privacy", within: "Store listing" }, "click")
    const inner = a.find({ text: "Title", within: "Store listing" }, "fill")
    return { id: f.kind === "found" ? a.resolve(f.ref)?.id : f.kind, inner: inner.kind === "found" ? a.resolve(inner.ref)?.id : inner.kind }
  })
  expect(r).toEqual({ id: "t2", inner: "ft" })
})

test("an ambiguous match in the innermost scope never falls through to an outer scope", async ({ fixture }) => {
  const page = await fixture("find-outer-scope.html")
  const r = await page.evaluate(() => (window as unknown as { __kiteAgent: Agent }).__kiteAgent.find({ text: "Help", within: "Store listing" }, "click"))
  expect(r.kind).toBe("ambiguous")
  expect((r as { candidates: unknown[] }).candidates).toHaveLength(2)
})
