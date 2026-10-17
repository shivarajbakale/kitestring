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
