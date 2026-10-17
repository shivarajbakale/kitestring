import { Command, CommanderError } from "commander"
import { parseTarget, type ActionResult, type Method } from "@bx/protocol"
import { BxError, call } from "./client/rpc-client.js"
import { formatResult } from "./client/format.js"
import { installHost } from "./install/host-manifest.js"
import { bxHome } from "./paths.js"

interface Globals {
  session?: string
  json?: boolean
}

class UsageError extends Error {}

function human(method: Method, result: unknown): string {
  const r = result as any
  switch (method) {
    case "page.snapshot":
      return String(r?.text ?? "")
    case "tab.new":
    case "tab.use":
    case "tab.close":
      return r && r.id !== undefined ? `tab ${r.id} ${r.url ?? ""}`.trimEnd() : "ok"
    case "tab.list": {
      const tabs: any[] = Array.isArray(r) ? r : (r?.tabs ?? [])
      return tabs.map((t) => `tab ${t.id} ${t.url ?? ""}`.trimEnd()).join("\n")
    }
    case "status":
      return typeof r === "string" ? r : JSON.stringify(r, null, 2)
    default:
      return r && typeof r === "object" && "status" in r ? formatResult(r as ActionResult) : JSON.stringify(r)
  }
}

export async function main(argv: string[]): Promise<number> {
  let exitCode = 0
  const program = new Command()
  program
    .name("bx")
    .description("Control your real Chrome from the command line")
    .option("--session <name>", "session name (env BX_SESSION)")
    .option("--json", "print raw result JSON")
    .exitOverride()
    .configureOutput({ writeErr: () => {}, outputError: () => {} })

  const run = async (method: Method, params: Record<string, unknown>): Promise<void> => {
    const g = program.opts<Globals>()
    const session = g.session || process.env.BX_SESSION || "default"
    const result = await call(method, params, { session })
    if (g.json) process.stdout.write(JSON.stringify(result) + "\n")
    else process.stdout.write(human(method, result) + "\n")
    if (result && typeof result === "object" && "status" in result && (result as any).status !== "done") exitCode = 1
  }

  program.command("status").action(() => run("status", {}))

  const tab = program.command("tab").description("manage tabs")
  tab.command("new [url]").action((url?: string) => run("tab.new", url ? { url } : {}))
  tab.command("list").action(() => run("tab.list", {}))
  tab.command("use <id>").action((id: string) => run("tab.use", { id: tabId(id) }))
  tab.command("close [id]").action((id?: string) => run("tab.close", id ? { id: tabId(id) } : {}))

  program.command("goto <url>").action((url: string) => run("page.goto", { url }))
  program
    .command("snapshot")
    .option("--full", "full snapshot")
    .option("--scope <ref>", "limit to ref")
    .action((o: { full?: boolean; scope?: string }) =>
      run("page.snapshot", { full: !!o.full, ...(o.scope ? { scope: o.scope } : {}) }),
    )
  program
    .command("click <target>")
    .option("--within <name>")
    .option("--role <role>")
    .action((t: string, o: { within?: string; role?: string }) => run("act.click", { target: parseTarget(t, o) }))
  program
    .command("fill <target> <text>")
    .option("--within <name>")
    .option("--role <role>")
    .action((t: string, text: string, o: { within?: string; role?: string }) =>
      run("act.fill", { target: parseTarget(t, o), text }),
    )
  program.command("press <key>").action((key: string) => run("act.press", { key }))
  program
    .command("select <target> <value>")
    .option("--within <name>")
    .option("--role <role>")
    .action((t: string, value: string, o: { within?: string; role?: string }) =>
      run("act.select", { target: parseTarget(t, o), value }),
    )
  program.command("scroll <direction> [px]").action((dir: string, px?: string) => {
    if (dir !== "up" && dir !== "down") throw new UsageError("scroll direction must be up or down")
    const n = px === undefined ? undefined : Number(px)
    if (n !== undefined && !Number.isFinite(n)) throw new UsageError("px must be a number")
    return run("act.scroll", { direction: dir, ...(n !== undefined ? { px: n } : {}) })
  })
  program
    .command("install-host")
    .option("--browser <browser>", "chrome|chromium", "chrome")
    .option("--user-data-dir <dir>")
    .option("--extension-id <id>")
    .action((o: { browser: string; userDataDir?: string; extensionId?: string }) => {
      if (o.browser !== "chrome" && o.browser !== "chromium") throw new UsageError("--browser must be chrome or chromium")
      if (!o.extensionId) throw new UsageError("--extension-id is required")
      const r = installHost({
        browser: o.browser,
        userDataDir: o.userDataDir,
        extensionId: o.extensionId,
        bxHome: bxHome(),
      })
      if (program.opts<Globals>().json) process.stdout.write(JSON.stringify(r) + "\n")
      else process.stdout.write(`installed native host manifest: ${r.manifestPath}\nwrapper: ${r.wrapperPath}\n`)
    })

  try {
    await program.parseAsync(argv, { from: "user" })
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.exitCode === 0) return 0 // help/version
      process.stderr.write(`bx: ${e.message.replace(/^error: /, "")}\n`)
      return 2
    }
    if (e instanceof UsageError) {
      process.stderr.write(`bx: ${e.message}\n`)
      return 2
    }
    if (e instanceof BxError) {
      if (e.code === "RESTRICTED") {
        const m = e.message.match(/https?:\/\/\S+|chrome[-a-z]*:\/\/\S*/i)
        const url = m ? m[0].replace(/[).,;]+$/, "") : undefined
        process.stderr.write(
          `bx: restricted page${url ? ` (${url})` : ""} — browser blocks extensions here\n`,
        )
        return 1
      }
      process.stderr.write(`bx: ${e.message}\n`)
      return e.code === "NOT_CONNECTED" ? 2 : 1
    }
    process.stderr.write(`bx: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
  return exitCode
}

function tabId(s: string): number {
  const n = Number(s)
  if (!Number.isInteger(n)) throw new UsageError(`invalid tab id: ${s}`)
  return n
}
