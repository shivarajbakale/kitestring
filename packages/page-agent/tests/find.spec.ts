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
    const f = (window as unknown as { __bxAgent: Agent }).__bxAgent.find({ text: "Save", within: "Plain" }, "click")
    return { f, id: f.kind === "found" ? (window as unknown as { __bxAgent: Agent }).__bxAgent.resolve(f.ref)?.id : null }
  })
  expect(r.f.kind).toBe("found")
  expect(r.id).toBe("s")
  expect((r.f as { line: string }).line).toMatch(/^button "Save" \[@e[0-9a-z]{5}\]$/)
})

test("two Apply buttons ambiguous; within narrows", async ({ fixture }) => {
  const page = await fixture("find.html")
  const amb = await page.evaluate(() => (window as unknown as { __bxAgent: Agent }).__bxAgent.find({ text: "Apply" }, "click"))
  expect(amb.kind).toBe("ambiguous")
  expect((amb as { candidates: unknown[] }).candidates).toHaveLength(2)
  const id = await page.evaluate(() => {
    const f = (window as unknown as { __bxAgent: Agent }).__bxAgent.find({ text: "Apply", within: "Profile" }, "click")
    return f.kind === "found" ? (window as unknown as { __bxAgent: Agent }).__bxAgent.resolve(f.ref)?.id : f.kind
  })
  expect(id).toBe("pb")
  const nf = await page.evaluate(() => (window as unknown as { __bxAgent: Agent }).__bxAgent.find({ text: "Apply", within: "Nope" }, "click"))
  expect(nf.kind).toBe("not_found")
})

test("odd whitespace and case", async ({ fixture }) => {
  const page = await fixture("find.html")
  const id = await page.evaluate(() => {
    const f = (window as unknown as { __bxAgent: Agent }).__bxAgent.find({ text: "  save changes " }, "click")
    return f.kind === "found" ? (window as unknown as { __bxAgent: Agent }).__bxAgent.resolve(f.ref)?.id : f.kind
  })
  expect(id).toBe("sc")
})

test("fill Email finds the input, not the link", async ({ fixture }) => {
  const page = await fixture("find.html")
  const id = await page.evaluate(() => {
    const f = (window as unknown as { __bxAgent: Agent }).__bxAgent.find({ text: "Email" }, "fill")
    return f.kind === "found" ? (window as unknown as { __bxAgent: Agent }).__bxAgent.resolve(f.ref)?.id : f.kind
  })
  expect(id).toBe("em")
})

test("icon-only buttons by aria-label and title", async ({ fixture }) => {
  const page = await fixture("find.html")
  const ids = await page.evaluate(() =>
    ["Delete item", "Settings"].map((text) => {
      const f = (window as unknown as { __bxAgent: Agent }).__bxAgent.find({ text }, "click")
      return f.kind === "found" ? (window as unknown as { __bxAgent: Agent }).__bxAgent.resolve(f.ref)?.id : f.kind
    })
  )
  expect(ids).toEqual(["del", "set"])
})

test("contenteditable is fill-able; role option narrows", async ({ fixture }) => {
  const page = await fixture("find.html")
  const r = await page.evaluate(() => {
    const a = (window as unknown as { __bxAgent: Agent }).__bxAgent.find({ text: "Notes" }, "fill")
    const b = (window as unknown as { __bxAgent: Agent }).__bxAgent.find({ text: "Email", role: "link" }, "click")
    return [
      a.kind === "found" ? (window as unknown as { __bxAgent: Agent }).__bxAgent.resolve(a.ref)?.id : a.kind,
      b.kind === "found" ? (window as unknown as { __bxAgent: Agent }).__bxAgent.resolve(b.ref)?.textContent : b.kind
    ]
  })
  expect(r).toEqual(["ce", "Email us"])
})

test("ref target matches resolve; unknown is not_found", async ({ fixture }) => {
  const page = await fixture("find.html")
  const r = await page.evaluate(() => {
    const f = (window as unknown as { __bxAgent: Agent }).__bxAgent.find({ text: "Save changes" }, "click")
    if (f.kind !== "found") return null
    const g = (window as unknown as { __bxAgent: Agent }).__bxAgent.find({ ref: f.ref }, "fill")
    return { same: g.kind === "found" && g.ref === f.ref && (window as unknown as { __bxAgent: Agent }).__bxAgent.resolve(f.ref)?.id === "sc" }
  })
  expect(r?.same).toBe(true)
  const nf = await page.evaluate(() => [
    (window as unknown as { __bxAgent: Agent }).__bxAgent.find({ ref: "@e00000" }, "click").kind,
    (window as unknown as { __bxAgent: Agent }).__bxAgent.find({ text: "Nonexistent" }, "click").kind
  ])
  expect(nf).toEqual(["not_found", "not_found"])
})
