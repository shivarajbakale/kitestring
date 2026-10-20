import { describe, expect, it } from "vitest"
import type { BatchResult, Method } from "@kitestring/protocol"
import { KiteError } from "../src/client/rpc-client.js"
import { formatScript, runScript } from "../src/script/run.js"

const ok: BatchResult = { ok: true, steps: [{ i: 0, action: "click", status: "done", ms: 3 }], diff: { added: [], removed: [] }, page: "" }

function fake(answer: (method: Method, params: Record<string, unknown>) => unknown = () => ok) {
  const sent: { method: Method; params: Record<string, unknown> }[] = []
  return {
    sent,
    opts: {
      call: async (method: Method, params: Record<string, unknown>) => {
        sent.push({ method, params })
        return answer(method, params)
      },
      timeoutMs: 10_000,
      resolveFiles: (files: string[]) => files.map((f) => `/abs/${f}`),
    },
  }
}

describe("runScript", () => {
  it("runs actions as one-step batches that do not wait for idle, and returns the script's value", async () => {
    const f = fake((m) => (m === "page.snapshot" ? { text: 'button "Save" [@e00001]' } : ok))
    const r = await runScript(
      `await goto("https://example.com")
       await fill("Email", "a@b.c", { within: "Sign in" })
       await click("Save", { expect: { text: "Saved" } })
       return await snapshot()`,
      f.opts,
    )
    expect(r.error).toBeUndefined()
    expect(r.value).toBe('button "Save" [@e00001]')
    expect(r.calls).toBe(4)
    expect(f.sent.map((c) => c.method)).toEqual(["act.batch", "act.batch", "act.batch", "page.snapshot"])
    expect(f.sent[1]!.params).toMatchObject({ steps: [{ action: "fill", target: "Email", value: "a@b.c", within: "Sign in" }], wait_idle: "never" })
    expect(f.sent[2]!.params.steps).toEqual([{ action: "click", target: "Save", expect: { text: "Saved" } }])
    expect(f.sent[2]!.params.budget_ms).toBeLessThanOrEqual(10_000)
  })

  it("throws a halted step into the script, which can catch it and branch", async () => {
    const f = fake(() => ({
      ok: false,
      steps: [{ i: 0, action: "click", status: "ambiguous", ms: 1 }],
      halted: { index: 0, reason: "ambiguous", detail: '2 elements match "Edit"' },
      next: 0,
      candidates: [{ ref: "@e00001", line: 'button "Edit" [@e00001]', score: 1 }],
      diff: { added: [], removed: [] },
      page: "",
    }))
    const r = await runScript(`try { await click("Edit") } catch (e) { return { code: e.code, message: e.message, candidates: e.candidates } }`, f.opts)
    expect(JSON.parse(r.value!)).toEqual({ code: "AMBIGUOUS", message: 'click: 2 elements match "Edit"', candidates: ['button "Edit" [@e00001]'] })
  })

  it("sends a function to evaluate as an expression calling it with its argument", async () => {
    const f = fake((m, p) => (m === "page.eval" ? { value: { got: p.expression } } : ok))
    const r = await runScript(`return await evaluate((n) => document.title.length + n, 2)`, f.opts)
    const expr = JSON.parse(r.value!).got as string
    expect(expr).toMatch(/^\(\(n\) => document\.title\.length \+ n\)\(2\)$/)
  })

  it("vets upload paths in the parent", async () => {
    const f = fake()
    await runScript(`await upload("Attach", ["a.pdf"])`, f.opts)
    expect(f.sent[0]!.params.steps).toEqual([{ action: "upload", target: "Attach", files: ["/abs/a.pdf"] }])
  })

  it("rejects unknown options before calling the browser", async () => {
    const f = fake()
    const r = await runScript(`await click("Save", { force: true })`, f.opts)
    expect(r.error).toMatch(/^BAD_REQUEST: unknown option force/)
    expect(f.sent).toEqual([])
  })

  it("keeps console output and reports the script's own errors with their line", async () => {
    const r = await runScript(`console.log("rows", [1, 2])\nconst x = 1\nnull.boom`, fake().opts)
    expect(r.logs).toEqual(["rows [ 1, 2 ]"])
    expect(r.error).toMatch(/^TypeError: .*\(line 3\)$/)
    expect(formatScript(r)).toMatch(/rows \[ 1, 2 \]\nerror: TypeError: .*\n\(0 browser calls, \d+ ms\)$/)
  })

  it("reports a syntax error", async () => {
    const r = await runScript(`await click("a"`, fake().opts)
    expect(r.error).toMatch(/^SyntaxError: /)
  })

  it("gives the script no files, subprocesses or environment", async () => {
    const r = await runScript(
      `const out = {}
       try { require("node:fs").readFileSync("/etc/hosts", "utf8"); out.fs = "read" } catch (e) { out.fs = e.code || e.name }
       try { require("node:child_process").execSync("echo hi"); out.exec = "ran" } catch (e) { out.exec = e.code || e.name }
       out.env = ["HOME", "PATH", "USER", "KITE_SESSION"].filter((k) => k in process.env)
       return out`,
      fake().opts,
    )
    const out = JSON.parse(r.value!)
    expect(out.fs).not.toBe("read")
    expect(out.exec).not.toBe("ran")
    expect(out.env).toEqual([])
  })

  it("kills a script that runs past its deadline", async () => {
    const f = fake()
    const r = await runScript(`console.log("start"); while (true) {}`, { ...f.opts, timeoutMs: 1_500 })
    expect(r.timedOut).toBe(true)
    expect(r.error).toBe("TIMEOUT: script ran past 1500 ms")
    expect(r.logs).toEqual(["start"])
  })

  it("names a call error's code once", async () => {
    const f = fake(() => {
      throw new KiteError("NO_TAB", 'NO_TAB: session "s" has no active tab')
    })
    const r = await runScript(`await snapshot()`, f.opts)
    expect(r.error).toBe('NO_TAB: session "s" has no active tab')
  })

  it("waitFor sends the condition to page.wait, a function as its source, and returns its value", async () => {
    const f = fake((m) => (m === "page.wait" ? { ms: 12, value: 5 } : ok))
    const r = await runScript(
      `const a = await waitFor({ count: { selector: "article", min: 5 } }, { timeout: 3000 })
       const b = await waitFor({ fn: (n) => document.querySelectorAll("article").length >= n && 5, arg: 5 })
       return [a, b]`,
      f.opts,
    )
    expect(JSON.parse(r.value!)).toEqual([5, 5])
    expect(f.sent[0]).toEqual({ method: "page.wait", params: { cond: { count: { selector: "article", min: 5 } }, timeout_ms: 3000 } })
    const cond = f.sent[1]!.params.cond as { fn: string; arg: number }
    expect(cond.arg).toBe(5)
    expect(cond.fn).toMatch(/^\(n\) => document\.querySelectorAll\("article"\)\.length >= n && 5$/)
    // never past the script's own deadline
    expect(f.sent[1]!.params.timeout_ms).toBeLessThanOrEqual(10_000)
  })

  it("waitFor rejects a missing condition or a bad timeout before calling the browser", async () => {
    const f = fake()
    expect((await runScript(`await waitFor()`, f.opts)).error).toMatch(/^BAD_REQUEST: waitFor needs a condition/)
    expect((await runScript(`await waitFor({ text: "a" }, { timeout: -1 })`, f.opts)).error).toMatch(/^BAD_REQUEST: waitFor timeout/)
    expect(f.sent).toEqual([])
  })

  it("goto passes waitUntil as the step's wait_until", async () => {
    const f = fake()
    await runScript(`await goto("https://x.example/", { waitUntil: "domcontentloaded" })`, f.opts)
    expect(f.sent[0]!.params.steps).toEqual([{ action: "goto", url: "https://x.example/", wait_until: "domcontentloaded" }])
    expect((await runScript(`await goto("https://x.example/", { waitUntil: "soon" })`, f.opts)).error).toMatch(/^BAD_REQUEST: goto waitUntil/)
  })
})
