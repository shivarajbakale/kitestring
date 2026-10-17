import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Command, CommanderError } from "commander"
import { EXTENSION_ID, parseTarget, type Method, type ScreenshotResult } from "@kitestring/protocol"
import { KiteError, call } from "./client/rpc-client.js"
import { human } from "./client/human.js"
import { installHost, legacyNotices } from "./install/host-manifest.js"
import { kiteHome } from "./paths.js"
import { AGENTS, parseAgents } from "./init/agents.js"

interface Globals {
  session?: string
  json?: boolean
}

class UsageError extends Error {}

export async function main(argv: string[]): Promise<number> {
  let exitCode = 0
  const program = new Command()
  program
    .name("kite")
    .description("Control your real Chrome from the command line")
    .option("--session <name>", "session name (env KITE_SESSION)")
    .option("--json", "print raw result JSON")
    .exitOverride()
    .configureOutput({ writeErr: () => {}, outputError: () => {} })

  const run = async (method: Method, params: Record<string, unknown>): Promise<void> => {
    const g = program.opts<Globals>()
    const session = g.session || process.env.KITE_SESSION || "default"
    const result = await call(method, params, { session })
    if (g.json) process.stdout.write(JSON.stringify(result) + "\n")
    else process.stdout.write(human(method, result) + "\n")
    if (result && typeof result === "object" && "status" in result && (result as any).status !== "done") exitCode = 1
  }

  program
    .command("mcp")
    .description("serve MCP over stdio (session from KITE_SESSION, default agent)")
    .action(async () => {
      const { serveMcp } = await import("./mcp/server.js")
      await serveMcp()
    })

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
  const limitOpt = (n: string): number => {
    if (!/^[1-9]\d*$/.test(n)) throw new UsageError(`--limit must be a positive integer: ${n}`)
    return Number(n)
  }
  program
    .command("console")
    .description("console messages and uncaught errors of the active tab")
    .option("--errors", "only errors")
    .option("--limit <n>", "how many entries (newest)", "50")
    .option("--clear", "empty the buffer after reading")
    .action((o: { errors?: boolean; limit: string; clear?: boolean }) =>
      run("page.console", { level: o.errors ? "error" : "all", limit: limitOpt(o.limit), clear: !!o.clear }),
    )
  program
    .command("network")
    .description("network requests of the active tab")
    .option("--failed", "only failed requests (status >= 400 or no response)")
    .option("--filter <s>", "only URLs containing this text")
    .option("--limit <n>", "how many entries (newest)", "50")
    .option("--clear", "empty the buffer after reading")
    .action((o: { failed?: boolean; filter?: string; limit: string; clear?: boolean }) =>
      run("page.network", {
        failed: !!o.failed,
        ...(o.filter ? { filter: o.filter } : {}),
        limit: limitOpt(o.limit),
        clear: !!o.clear,
      }),
    )
  program
    .command("screenshot")
    .description("PNG of the active tab; prints the file path")
    .option("--full", "the whole page, not just the viewport")
    .option("--ref <ref>", "only this element (@e…)")
    .option("-o, --output <file>", "where to write it (default $KITE_HOME/shots/<timestamp>.png)")
    .action(async (o: { full?: boolean; ref?: string; output?: string }) => {
      const g = program.opts<Globals>()
      const session = g.session || process.env.KITE_SESSION || "default"
      const r = (await call("page.screenshot", { full: !!o.full, ...(o.ref ? { ref: o.ref } : {}) }, { session })) as ScreenshotResult
      const file = resolve(o.output ?? join(kiteHome(), "shots", `${new Date().toISOString().replace(/:/g, "-")}.png`))
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, Buffer.from(r.data, "base64"))
      if (g.json) process.stdout.write(JSON.stringify({ path: file, mime: r.mime, width: r.width, height: r.height }) + "\n")
      else process.stdout.write(file + "\n")
    })
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
    if (px !== undefined && !/^[1-9]\d*$/.test(px)) throw new UsageError(`px must be a positive integer: ${px}`)
    const n = px === undefined ? undefined : Number(px)
    return run("act.scroll", { direction: dir, ...(n !== undefined ? { px: n } : {}) })
  })
  program
    .command("pause [reason]")
    .description("stop all agents from acting until resumed")
    .action((reason?: string) => run("control.pause", reason ? { reason } : {}))
  program.command("resume").description("let agents act again").action(() => run("control.resume", {}))
  program
    .command("activity")
    .description("recent agent actions, newest first")
    .option("--limit <n>", "how many entries", "200")
    .action((o: { limit: string }) => {
      if (!/^[1-9]\d*$/.test(o.limit)) throw new UsageError(`--limit must be a positive integer: ${o.limit}`)
      return run("activity.list", { limit: Number(o.limit) })
    })
  program
    .command("install-host")
    .option("--browser <browser>", "chrome|chromium", "chrome")
    .option("--user-data-dir <dir>")
    .option("--extension-id <id>", "extension id allowed to connect", EXTENSION_ID)
    .action((o: { browser: string; userDataDir?: string; extensionId: string }) => {
      if (o.browser !== "chrome" && o.browser !== "chromium") throw new UsageError("--browser must be chrome or chromium")
      const r = installHost({
        browser: o.browser,
        userDataDir: o.userDataDir,
        extensionId: o.extensionId,
        kiteHome: kiteHome(),
      })
      if (program.opts<Globals>().json) process.stdout.write(JSON.stringify(r) + "\n")
      else {
        process.stdout.write(`installed native host manifest: ${r.manifestPath}\nwrapper: ${r.wrapperPath}\n`)
        for (const line of legacyNotices(r)) process.stdout.write(line + "\n")
      }
    })

  program
    .command("doctor")
    .description("check the install end to end (read-only); prints fix hints for anything failing")
    .action(async () => {
      const { runDoctor, formatChecks } = await import("./doctor/doctor.js")
      const checks = await runDoctor({ home: homedir(), env: process.env })
      if (program.opts<Globals>().json) process.stdout.write(JSON.stringify(checks) + "\n")
      else process.stdout.write(formatChecks(checks) + "\n")
      if (checks.some((c) => !c.ok)) exitCode = 1
    })

  const initOpts = (o: { agents?: string; dryRun?: boolean; yes?: boolean }) => {
    let agents
    try {
      agents = o.agents === undefined ? undefined : parseAgents(o.agents)
    } catch (e) {
      throw new UsageError((e as Error).message)
    }
    return {
      home: homedir(),
      env: process.env,
      agents,
      dryRun: !!o.dryRun,
      yes: !!o.yes,
      tty: !!(process.stdin.isTTY && process.stdout.isTTY),
      confirm: askYesNo,
      out: (s: string) => void process.stdout.write(s + "\n"),
      err: (s: string) => void process.stderr.write(`kite: ${s}\n`),
    }
  }
  program
    .command("init")
    .description("register the kitestring MCP server with your agents, install skills and the native host")
    .option("--agents <list>", `comma-separated subset of ${AGENTS.join(",")}`)
    .option("--dry-run", "print the plan and write nothing")
    .option("--yes", "apply without asking")
    .action(async (o: { agents?: string; dryRun?: boolean; yes?: boolean }) => {
      const { runInit } = await import("./init/init.js")
      exitCode = await runInit(initOpts(o))
    })
  program
    .command("uninstall-agents")
    .description("remove what kite init added to your agents (MCP entries, skills, symlinks)")
    .option("--agents <list>", `comma-separated subset of ${AGENTS.join(",")}`)
    .option("--dry-run", "print the plan and write nothing")
    .option("--yes", "apply without asking")
    .action(async (o: { agents?: string; dryRun?: boolean; yes?: boolean }) => {
      const { runUninstall } = await import("./init/init.js")
      exitCode = await runUninstall(initOpts(o))
    })

  try {
    await program.parseAsync(argv, { from: "user" })
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.exitCode === 0) return 0 // help/version
      process.stderr.write(`kite: ${e.message.replace(/^error: /, "")}\n`)
      return 2
    }
    if (e instanceof UsageError) {
      process.stderr.write(`kite: ${e.message}\n`)
      return 2
    }
    if (e instanceof KiteError) {
      if (program.opts<Globals>().json) {
        process.stdout.write(JSON.stringify({ error: { code: e.code, message: e.message } }) + "\n")
      }
      // RESTRICTED: the extension's message already names the page ("restricted page (<url>) — …").
      const hint = e.code === "RESTRICTED" && e.message.includes("(about:blank)") ? " (blank tab — run kite goto <url>)" : ""
      process.stderr.write(`kite: ${e.message}${hint}\n`)
      return e.code === "NOT_CONNECTED" ? 2 : 1
    }
    process.stderr.write(`kite: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
  return exitCode
}

async function askYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises")
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim())
  } finally {
    rl.close()
  }
}

function tabId(s: string): number {
  const n = Number(s)
  if (!Number.isInteger(n)) throw new UsageError(`invalid tab id: ${s}`)
  return n
}
