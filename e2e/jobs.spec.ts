import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type KiteRun } from "./fixtures"

// Bulk extraction in a real Chrome, on a maps-like page: 45 cards in a panel that scrolls on its own, fed by a JSON API,
// whose phone, website and address are only on each place's own page (built by JavaScript).

const SPEC = {
  list: { items: '[role="feed"] > div.card', fields: { name: "h3.title", link: "a.place-link@href", category: ".category" }, more: "scroll" },
  detail: { link: "link", fields: { phone: '[data-item-id^="phone"]', website: '[data-item-id="authority"]@href', address: '[data-item-id="address"]' }, wait: "h1", concurrency: 4 },
}

const csvRows = (file: string) => readFileSync(file, "utf8").trimEnd().split("\n")

async function waitJob(kite: (...a: string[]) => Promise<KiteRun>, id: string, until: (st: { state: string; rows: number }) => boolean, ms = 60_000) {
  const t0 = Date.now()
  for (;;) {
    const r = await kite("--json", "job", "status", id)
    const st = (JSON.parse(r.stdout) as { status: { state: string; rows: number } | null }).status
    if (st && until(st)) return st
    if (Date.now() - t0 > ms) throw new Error(`job ${id} did not get there: ${r.stdout}`)
    await new Promise((res) => setTimeout(res, 500))
  }
}

test.describe("bulk extraction", () => {
  test("probe finds the cards' selectors, the panel scrolling and the JSON API behind them", async ({ kite, torture }) => {
    await kite("tab", "new", `${torture}/places`)
    const r = await kite("probe")
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('items: "#panel > div.card"')
    expect(r.stdout).not.toContain('"card":"."')
    expect(r.stdout).toMatch(/fields: \{.*"title":"[^"]*h3\.title"/)
    expect(r.stdout).toContain("detail link column: link")
    expect(r.stdout).toContain("more: scroll the panel")
    expect(r.stdout).toMatch(/network JSON: GET http:\/\/127\.0\.0\.1:\d+\/api\/places\?page=1 \(200, \d+ KB\) at results: 15 records, holds \d+\/\d+ visible values/)
    expect(r.stdout).toContain("suggest: the records come from GET")
  })

  test("a script collects the panel, reads every place's page in background tabs and saves 45 full rows", async ({ kite, kiteStdin, kiteHome, torture, context, result }) => {
    await kite("tab", "new", `${torture}/places`)
    const file = join(kiteHome, "places.csv")
    const code = `
      const cards = await collect({ items: ${JSON.stringify(SPEC.list.items)}, fields: ${JSON.stringify(SPEC.list.fields)}, more: "scroll", id: "link" })
      await readEach(cards, { phone: '[data-item-id^="phone"]', address: '[data-item-id="address"]' }, { wait: "h1", concurrency: 4, emit: true })`
    const r = await kiteStdin(code, "script", "-", "--save", file, "--id", "link")
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain("collect: 45 rows")
    expect(r.stdout).toContain("readEach: 45 read")
    const lines = csvRows(file)
    expect(lines[0]).toBe("name,link,category,phone,address")
    expect(lines).toHaveLength(46)
    expect(lines).toContain(`Warehouse 45,${torture}/place-detail?id=45,Logistics,0836 000045,"45 Dock Road, Hubli"`)
    const page = context.pages().find((p) => p.url().endsWith("/places"))!
    expect(await result(page)).toBe("undefined")
  })

  test("a spec dry-runs to 3 rows, then runs as a job in its own window and writes all 45", async ({ kite, kiteHome, torture }) => {
    const specFile = join(kiteHome, "places.json")
    writeFileSync(specFile, JSON.stringify({ ...SPEC, start: `${torture}/places` }))
    const dry = await kite("job", "start", "--spec", specFile, "--dry-run")
    expect(dry.code, dry.stdout + dry.stderr).toBe(0)
    expect(dry.stdout.match(/^row: /gm)).toHaveLength(3)
    expect(dry.stdout).toContain('"phone":"0836 000001"')

    const out = join(kiteHome, "all.csv")
    const r = await kite("--json", "job", "start", "--spec", specFile, "--save", out)
    expect(r.code, r.stderr).toBe(0)
    const def = JSON.parse(r.stdout) as { id: string; window: string; rowId: string }
    expect(def.window).toBe("front")
    expect(def.rowId).toBe("link")
    const st = await waitJob(kite, def.id, (s) => s.state !== "running")
    expect(st).toMatchObject({ state: "done", rows: 45 })
    const lines = csvRows(out)
    expect(lines[0]).toBe("name,link,category,phone,website,address")
    expect(lines).toHaveLength(46)
    expect(new Set(lines).size).toBe(46)
    const status = await kite("job", "status", def.id)
    expect(status.stdout).toContain(`job ${def.id}: done, 45 rows`)
  })

  test("a stopped job keeps its rows and a resume finishes without repeating any", async ({ kite, kiteHome, torture }) => {
    const specFile = join(kiteHome, "slow.json")
    writeFileSync(specFile, JSON.stringify({ ...SPEC, start: `${torture}/places`, detail: { ...SPEC.detail, concurrency: 1, delayMs: 400 } }))
    const r = await kite("--json", "job", "start", "--spec", specFile)
    const { id } = JSON.parse(r.stdout) as { id: string }
    await waitJob(kite, id, (s) => s.rows >= 5)
    expect((await kite("job", "stop", id)).stdout).toContain(`stopping ${id}`)
    const stopped = await waitJob(kite, id, (s) => s.state !== "running")
    expect(stopped.state).toBe("stopped")
    expect(stopped.rows).toBeGreaterThanOrEqual(5)
    expect(stopped.rows).toBeLessThan(45)

    expect((await kite("job", "resume", id)).code).toBe(0)
    const done = await waitJob(kite, id, (s) => s.state !== "running", 90_000)
    expect(done, (await kite("job", "status", id)).stdout).toMatchObject({ state: "done", rows: 45 })
    const rows = readFileSync(join(kiteHome, "jobs", id, "rows.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as { link: string })
    expect(rows).toHaveLength(45)
    expect(new Set(rows.map((x) => x.link)).size).toBe(45)
  })

  test("an api spec pages the JSON endpoint in a background tab; saved as a recipe it runs on a schedule", async ({ kite, kiteHome, torture }) => {
    const specFile = join(kiteHome, "api.json")
    writeFileSync(specFile, JSON.stringify({ start: `${torture}/places`, api: { url: "/api/places?page={page}", rows: "results", fields: { id: "id", name: "name", rating: "rating" }, pages: 10 }, id: "id" }))
    const r = await kite("--json", "job", "start", "--spec", specFile, "--save-as", "warehouses")
    expect(r.code, r.stderr).toBe(0)
    const def = JSON.parse(r.stdout) as { id: string; window: string }
    expect(def.window).toBe("background")
    expect(await waitJob(kite, def.id, (s) => s.state !== "running")).toMatchObject({ state: "done", rows: 45 })

    expect((await kite("job", "recipes")).stdout).toContain("warehouses  spec")
    const add = await kite("schedule", "add-job", "warehouses", "--every", "1d")
    expect(add.code, add.stderr).toBe(0)
    const run = await kite("schedule", "run", "warehouses")
    expect(run.code, run.stdout + run.stderr).toBe(0)
    expect(run.stdout).toMatch(/^✓ done: 45 rows saved to .*exports\/warehouses\/.*\.csv/)
    const again = await kite("schedule", "run", "warehouses")
    expect(again.stdout).toContain("45 rows (0 new)")
  })
})
