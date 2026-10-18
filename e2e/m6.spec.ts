import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
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

/** Every file under `dir` (recursively) whose text contains any of `needles`. */
function filesContaining(dir: string, needles: string[]): string[] {
  const hits: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && needles.some((n) => readFileSync(p, "utf8").includes(n))) hits.push(p)
    }
  }
  if (existsSync(dir)) walk(dir)
  return hits
}

test.describe("record a task once, replay it as a skill", () => {
  test("recording basic-form gives a skill with no values whose kite batch block and plan replay the form", async ({
    kite,
    kiteEnv,
    kiteStdin,
    kiteHome,
    context,
    torture,
    result,
  }) => {
    const home = mkdtempSync(join(tmpdir(), "kitehome-"))
    try {
      const url = `${torture}/basic-form`
      const page = () => context.pages().find((p) => p.url().startsWith(url))!
      expect((await kite("tab", "new", url)).code).toBe(0)
      const start = await kiteEnv({ HOME: home }, "record", "start", "--name", "ada-signup")
      expect(start.code, start.stdout + start.stderr).toBe(0)

      // agents do not act in a tab that is being recorded
      const agent = await kite("click", "Submit")
      expect(agent.code).not.toBe(0)
      expect(agent.stderr).toMatch(/record/)

      // the human does the task
      await page().getByLabel("Name").fill("Ada")
      await page().getByLabel("Email").fill("ada@x.io")
      await page().getByRole("button", { name: "Submit" }).click()
      expect(await result(page())).toBe("submitted:Ada:ada@x.io")

      const stop = await kiteEnv({ HOME: home }, "record", "stop")
      expect(stop.code, stop.stdout + stop.stderr).toBe(0)
      const skill = join(home, ".agents", "skills", "kite-ada-signup", "SKILL.md")
      const md = readFileSync(skill, "utf8")
      expect(md).toContain("name: kite-ada-signup")
      expect(md).not.toMatch(/Ada\b|ada@x\.io/)
      expect(existsSync(join(home, ".claude", "skills", "kite-ada-signup"))).toBe(true)
      expect(filesContaining(kiteHome, ["ada@x.io"])).toEqual([])

      // the fallback: the skill's kite batch JSON with values substituted completes the form
      const at = md.indexOf("```json")
      const block = md.slice(at + 7, md.indexOf("```", at + 7))
      const filled = block.replaceAll("{{name}}", "Grace").replaceAll("{{email}}", "grace@x.io")
      expect((await kite("goto", url)).code).toBe(0)
      const b = await kiteStdin(filled, "--json", "batch", "-")
      expect(JSON.parse(b.stdout).ok, b.stdout + b.stderr).toBe(true)
      expect(await result(page())).toBe("submitted:Grace:grace@x.io")

      // the first choice: kite run on the stored plan
      expect((await kite("goto", url)).code).toBe(0)
      const run = await kite("run", "ada-signup", "--param", "name=Lin", "--param", "email=lin@x.io")
      expect(run.code, run.stdout + run.stderr).toBe(0)
      expect(await result(page())).toBe("submitted:Lin:lin@x.io")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("recording a login form: the password and one-time code never reach disk (Review Focus 4)", async ({
    kite,
    kiteEnv,
    kiteHome,
    context,
    torture,
    result,
  }) => {
    const home = mkdtempSync(join(tmpdir(), "kitehome-"))
    try {
      const url = `${torture}/login`
      const page = () => context.pages().find((p) => p.url().startsWith(url))!
      expect((await kite("tab", "new", url)).code).toBe(0)
      expect((await kiteEnv({ HOME: home }, "record", "start", "--name", "sign-in")).code).toBe(0)
      await page().getByLabel("Username").fill("ada")
      await page().getByLabel("Password").fill("hunter2-Secret")
      await page().getByLabel("One-time code").fill("918273")
      await page().getByRole("button", { name: "Sign in" }).click()
      expect(await result(page())).toBe("signed-in:ada:ok")
      const stop = await kiteEnv({ HOME: home }, "record", "stop")
      expect(stop.code, stop.stdout + stop.stderr).toBe(0)
      expect(stop.stdout + stop.stderr).not.toMatch(/hunter2|918273/)

      const md = readFileSync(join(home, ".agents", "skills", "kite-sign-in", "SKILL.md"), "utf8")
      expect(md).toContain("--secret password=…")
      expect(md).toContain("--secret one_time_code=…")
      expect(filesContaining(home, ["hunter2", "918273"])).toEqual([])
      expect(filesContaining(kiteHome, ["hunter2", "918273"])).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("filling a password or one-time-code field never adds its locator to the action cache (T1-5)", async ({ kite, torture }) => {
    expect((await kite("tab", "new", `${torture}/login`)).code).toBe(0)
    const entries = async () => JSON.parse((await kite("--json", "cache", "stats")).stdout).entries as number
    const before = await entries()
    expect((await kite("fill", "Password", "hunter2-Secret")).code).toBe(0)
    expect((await kite("fill", "One-time code", "918273")).code).toBe(0)
    expect(await entries()).toBe(before)
    // a plain field is cached, so the count above is a real check
    expect((await kite("fill", "Username", "ada")).code).toBe(0)
    expect(await entries()).toBe(before + 1)
  })
})
