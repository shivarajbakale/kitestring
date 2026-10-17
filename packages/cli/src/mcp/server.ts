import { readFileSync } from "node:fs"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { TOOLS, runTool } from "./tools.js"

function version(): string {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version
  } catch {
    return "0.0.0"
  }
}

/** Serves MCP over stdio until stdin closes. stdout is protocol only; diagnostics go to stderr. */
export async function serveMcp(): Promise<void> {
  const session = process.env.KITE_SESSION || "agent"
  const server = new McpServer({ name: "kitestring", version: version() })
  for (const def of TOOLS) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.shape }, (args: unknown) => runTool(def, args, session))
  }
  const closed = new Promise<void>((resolve) => {
    process.stdin.on("close", resolve)
    process.stdin.on("end", resolve)
  })
  await server.connect(new StdioServerTransport())
  await closed
}
