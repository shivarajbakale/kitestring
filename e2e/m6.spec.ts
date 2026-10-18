import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { expect, test } from "./fixtures"

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli", "dist", "bin.js")

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

test.describe("site memory", () => {
  test("an agent's batches on multi-page-checkout become a plan that replays faster, from cache, to the same point", async ({
    kite,
    kiteStdin,
    kiteHome,
    context,
    torture,
  }) => {
    const start = `${torture}/multi-page-checkout`
    const review = () => context.pages().find((p) => p.url().endsWith("/multi-page-checkout-review"))
    expect((await kite("tab", "new", start)).code).toBe(0)

    // first run, as an agent does it: look, then one batch per page, stopping before "Place order"
    let firstMs = 0
    const step = async (r: Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>) => {
      const x = await r
      expect(x.code, x.stdout + x.stderr).toBe(0)
      firstMs += x.ms
      return x
    }
    await step(kite("snapshot"))
    await step(kiteStdin(JSON.stringify([{ action: "click", target: "Proceed to shipping" }]), "batch", "-"))
    await step(kite("snapshot"))
    const fill = [
      { action: "fill", target: "Full name", value: "Ada Lovelace" },
      { action: "fill", target: "Address", value: "12 Analytical St" },
      { action: "fill", target: "City", value: "London" },
      { action: "select", target: "Country", value: "India" },
      { action: "click", target: "Continue to payment" },
    ]
    const b2 = await step(kiteStdin(JSON.stringify(fill), "batch", "-"))
    expect(b2.stderr).not.toContain("not remembered")
    await expect.poll(() => review()?.url()).toBeTruthy()

    const saved = await kite("memory", "save", "fill the shipping form")
    expect(saved.code, saved.stderr).toBe(0)
    expect(saved.stdout).toContain("fill-the-shipping-form")
    const [plan] = JSON.parse((await kite("--json", "memory", "list")).stdout)
    expect(plan.params.map((p: { name: string }) => p.name)).toEqual(["full_name", "address", "city", "country"])
    expect(JSON.stringify(plan)).not.toMatch(/Ada|Analytical|London|India/)

    // replay on a fresh load with other values
    expect((await kite("goto", start)).code).toBe(0)
    const run = await kite(
      "--json", "run", "fill-the-shipping-form",
      "--param", "full_name=Grace Hopper", "--param", "address=1 Navy Way", "--param", "city=Arlington", "--param", "country=United States",
    )
    expect(run.code, run.stdout + run.stderr).toBe(0)
    const r = JSON.parse(run.stdout)
    expect(r).toMatchObject({ ok: true, batches: 2 })
    expect(r.cached).toBeGreaterThan(0)
    expect(run.ms).toBeLessThan(firstMs)
    await expect.poll(async () => (await review()?.textContent("body")) ?? "").toContain("Grace Hopper")
    expect(context.pages().some((p) => p.url().endsWith("/multi-page-checkout-done"))).toBe(false)
    expect(JSON.parse((await kite("--json", "memory", "list")).stdout)[0].runs).toBe(1)

    // the agent finds it over MCP by intent, and nothing for an unrelated task
    const client = new Client({ name: "e2e", version: "0" })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [BIN, "mcp"],
        env: { ...(process.env as Record<string, string>), KITE_HOME: kiteHome, KITE_SESSION: "mcp" },
      }),
    )
    try {
      const find = async (intent: string) => {
        const res: any = await client.callTool({ name: "browser_plan_find", arguments: { intent, url: start } })
        expect(res.isError, JSON.stringify(res.content)).toBeFalsy()
        return res.content[0].text as string
      }
      expect(JSON.parse(await find("fill shipping form"))).toMatchObject({ slug: "fill-the-shipping-form" })
      expect(await find("delete my account")).toBe("no plan")
    } finally {
      await client.close()
    }
  })
})
