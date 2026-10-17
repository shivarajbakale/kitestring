import { test, expect } from "./harness"

interface Agent {
  waitQuiet(): Promise<{ quiet: boolean; waitedMs: number }>
}

test("style mutations are ignored", async ({ fixture }) => {
  const page = await fixture("quiet.html")
  const r = await page.evaluate(async () => {
    const m = document.getElementById("m")!
    let n = 0
    const t = setInterval(() => (m.style.opacity = String(n++ % 2)), 50)
    const res = await (window as unknown as { __kiteAgent: Agent }).__kiteAgent.waitQuiet()
    clearInterval(t)
    return res
  })
  expect(r.quiet).toBe(true)
  expect(r.waitedMs).toBeLessThan(1000)
})

test("continuous node additions keep waiting until they stop", async ({ fixture }) => {
  const page = await fixture("quiet.html")
  const r = await page.evaluate(async () => {
    const m = document.getElementById("m")!
    const start = performance.now()
    const t = setInterval(() => {
      m.appendChild(document.createElement("p"))
      if (performance.now() - start >= 2000) clearInterval(t)
    }, 100)
    return (window as unknown as { __kiteAgent: Agent }).__kiteAgent.waitQuiet()
  })
  expect(r.quiet).toBe(true)
  expect(r.waitedMs).toBeGreaterThanOrEqual(2000)
})

test("visible progressbar blocks until removed", async ({ fixture }) => {
  const page = await fixture("quiet.html")
  const r = await page.evaluate(async () => {
    const m = document.getElementById("m")!
    const bar = document.createElement("div")
    bar.setAttribute("role", "progressbar")
    bar.style.width = "50px"
    bar.style.height = "10px"
    m.appendChild(bar)
    setTimeout(() => bar.remove(), 1000)
    return (window as unknown as { __kiteAgent: Agent }).__kiteAgent.waitQuiet()
  })
  expect(r.quiet).toBe(true)
  expect(r.waitedMs).toBeGreaterThanOrEqual(1000)
})

test("hidden aria-busy does not block", async ({ fixture }) => {
  const page = await fixture("quiet.html")
  const r = await page.evaluate(async () => {
    const d = document.createElement("div")
    d.setAttribute("aria-busy", "true")
    d.style.display = "none"
    document.getElementById("m")!.appendChild(d)
    return (window as unknown as { __kiteAgent: Agent }).__kiteAgent.waitQuiet()
  })
  expect(r.quiet).toBe(true)
  expect(r.waitedMs).toBeLessThan(1000)
})
