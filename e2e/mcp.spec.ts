import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { expect, test } from "./fixtures"

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli", "dist", "bin.js")

test("MCP client completes the torture basic-form", async ({ kiteHome, context, torture, result }) => {
  const client = new Client({ name: "e2e", version: "0" })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [BIN, "mcp"],
      env: { ...(process.env as Record<string, string>), KITE_HOME: kiteHome, KITE_SESSION: "mcp" },
    }),
  )
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const r: any = await client.callTool({ name, arguments: args })
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
      return r.content[0].text as string
    }
    const url = `${torture}/basic-form`
    await call("browser_tab_new", { url })
    expect(await call("browser_snapshot", {})).toContain("Basic form")
    await call("browser_fill", { target: "Name", text: "Ada" })
    await call("browser_fill", { target: "Email", text: "ada@x.io" })
    expect(await call("browser_click", { target: "Submit" })).toMatch(/^✓ done/)
    const page = context.pages().find((p) => p.url() === url)
    if (!page) throw new Error("no basic-form page")
    expect(await result(page)).toBe("submitted:Ada:ada@x.io")
  } finally {
    await client.close()
  }
})

test("MCP agent probes a maps-like page, dry-runs a spec, and runs it as a job to 45 full rows", async ({ kiteHome, context, torture }) => {
  void context // the browser is up and connected
  test.setTimeout(120_000)
  const client = new Client({ name: "e2e", version: "0" })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [BIN, "mcp"],
      env: { ...(process.env as Record<string, string>), KITE_HOME: kiteHome, KITE_SESSION: "mcp" },
    }),
  )
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const r: any = await client.callTool({ name, arguments: args })
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
      return r.content[0].text as string
    }
    await call("browser_tab_new", { url: `${torture}/places` })
    const probe = await call("browser_probe", {})
    expect(probe).toContain('items: "#panel > div.card"')
    expect(probe).toContain("network JSON: GET")
    const spec = {
      list: { items: "#panel > div.card", fields: { name: "h3.title", link: "a.place-link@href" }, more: "scroll" },
      detail: { fields: { phone: '[data-item-id^="phone"]' }, wait: "h1" },
    }
    const dry = await call("browser_job_start", { spec, dry_run: true })
    expect(dry).toContain("3 rows × 3 columns")
    expect(dry).toContain("Warehouse 1,")
    const started = await call("browser_job_start", { spec, save: join(kiteHome, "places.csv") })
    const id = /^started job (\S+) on /.exec(started)![1]!
    let status = ""
    for (let i = 0; i < 120 && !/: (done|error|stopped),/.test(status); i++) {
      await new Promise((r) => setTimeout(r, 500))
      status = await call("browser_job_status", { id })
    }
    expect(status).toContain(`job ${id}: done, 45 rows`)
    expect(await call("browser_job_status", {})).toContain(`${id}: done, 45 rows`)
    expect(readFileSync(join(kiteHome, "places.csv"), "utf8").trimEnd().split("\n")).toHaveLength(46)
  } finally {
    await client.close()
  }
})
