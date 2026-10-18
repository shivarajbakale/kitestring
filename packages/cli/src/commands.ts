import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Command, CommanderError } from "commander"
import { EXTENSION_ID, RECORD_NAME_RE, parseTarget, type BatchResult, type Method, type Recording, type ScreenshotResult, type Step } from "@kitestring/protocol"
import { KiteError, call } from "./client/rpc-client.js"
import { human } from "./client/human.js"
import { withoutStartUrl } from "./client/format.js"
import { installHost, legacyNotices } from "./install/host-manifest.js"
import { kiteHome } from "./paths.js"
import { resolveUploads } from "./upload-guard.js"
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

  const sessionName = (): string => program.opts<Globals>().session || process.env.KITE_SESSION || "default"
  /** Calls, prints, sets the exit code, and hands back the result. */
  const send = async (method: Method, params: Record<string, unknown>): Promise<unknown> => {
    const g = program.opts<Globals>()
    const session = sessionName()
    const result = await call(method, params, { session })
    if (g.json) process.stdout.write(JSON.stringify(method === "act.batch" ? withoutStartUrl(result) : result) + "\n")
    else process.stdout.write(human(method, result) + "\n")
    if (result && typeof result === "object" && "status" in result && (result as any).status !== "done") exitCode = 1
    // A batch has no single status: it is ok or halted.
    if (method === "act.batch" && !(result as { ok?: boolean } | null)?.ok) exitCode = 1
    return result
  }
  const run = async (method: Method, params: Record<string, unknown>): Promise<void> => void (await send(method, params))

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
  program
    .command("upload <target> <files...>")
    .description("put files into a file input (or the file chooser a button opens)")
    .option("--within <name>")
    .option("--role <role>")
    .action((t: string, files: string[], o: { within?: string; role?: string }) =>
      run("act.upload", {
        target: parseTarget(t, o),
        files: resolveUploads(files, { cwd: process.cwd(), home: homedir(), kiteHome: kiteHome(), env: process.env }),
      }),
    )
  const collect = (v: string, prev: string[]): string[] => [...prev, v]
  program
    .command("batch <file>")
    .description("run steps from a JSON file (or - for stdin) under one tab lock: a Step[] or {steps, allow_domains?, budget_ms?}")
    .option("--budget <ms>", "time budget in ms (5000..40000; default 40000)")
    .option("--allow-domain <domain>", "also allow this registrable domain (repeatable)", collect, [] as string[])
    .action(async (file: string, o: { budget?: string; allowDomain: string[] }) => {
      if (o.budget !== undefined && !/^[1-9]\d*$/.test(o.budget)) throw new UsageError(`--budget must be a positive integer (ms): ${o.budget}`)
      const params = batchParams(file === "-" ? await readStdin() : readFileSync(file, "utf8"))
      if (o.budget !== undefined) params.budget_ms = Number(o.budget)
      if (o.allowDomain.length) params.allow_domains = [...((params.allow_domains as string[] | undefined) ?? []), ...o.allowDomain]
      const guard = { cwd: process.cwd(), home: homedir(), kiteHome: kiteHome(), env: process.env }
      for (const step of params.steps as { action?: unknown; files?: unknown }[]) {
        if (step && typeof step === "object" && step.action === "upload" && Array.isArray(step.files)) {
          try {
            step.files = resolveUploads(step.files as string[], guard)
          } catch (e) {
            // A batch has no single failing command: name the code in the message.
            if (e instanceof KiteError) throw new KiteError(e.code, `${e.code}: ${e.message}`)
            throw e
          }
        }
      }
      const result = (await send("act.batch", params)) as BatchResult
      // Journal the agent's ok steps for `kite memory save` (no values). Memory never fails the batch.
      if (Array.isArray(result?.steps)) {
        const { appendPending } = await import("./memory/pending.js")
        const note = appendPending(kiteHome(), sessionName(), result.startUrl ?? "", params.steps as Step[], result)
        if (note) process.stderr.write(`kite: ${note}\n`)
      }
    })
  program
    .command("run <plan>")
    .description("replay a saved plan with its parameters; stops at the first problem and leaves the page for you")
    .option("--param <name=value>", "a parameter value (repeatable)", collect, [] as string[])
    .option("--secret <name=value>", "a parameter value that is never printed (repeatable)", collect, [] as string[])
    .option("--dry-run", "print the filled batches (secrets as ••••) and send nothing")
    .action(async (id: string, o: { param: string[]; secret: string[]; dryRun?: boolean }) => {
      const { planById } = await import("./memory/store.js")
      const { runPlan } = await import("./memory/replay.js")
      const { discardPending, recordReplayStop } = await import("./memory/pending.js")
      const { formatReplay } = await import("./client/format.js")
      const json = !!program.opts<Globals>().json
      let stored
      try {
        stored = planById(kiteHome(), id)
      } catch (e) {
        throw new UsageError((e as Error).message)
      }
      const values: Record<string, string> = {}
      const secretNames = new Set<string>()
      for (const [list, secret] of [[o.param, false], [o.secret, true]] as const) {
        for (const kv of list) {
          const m = /^([^=]+)=(.*)$/s.exec(kv)
          if (!m) throw new UsageError(`expected name=value: ${kv}`)
          if (Object.hasOwn(values, m[1]!)) throw new UsageError(`parameter given twice: ${m[1]}`)
          values[m[1]!] = m[2]!
          if (secret) secretNames.add(m[1]!)
        }
      }
      const slug = stored.id.split("/")[1]!
      const session = sessionName()
      let r
      try {
        r = await runPlan(stored.plan, values, {
          call: (method, params) => call(method, params, { session }),
          out: (line) => void (json ? process.stderr : process.stdout).write(line + "\n"),
          dryRun: !!o.dryRun,
          secretNames,
          // a replay starts a new task memory; a stop makes it the takeover of this plan (saving updates the plan)
          onStart: () => void discardPending(kiteHome(), session),
          onStop: (at) => recordReplayStop(kiteHome(), session, stored.id, stored.plan, at, values, secretNames),
        })
      } catch (e) {
        if (e instanceof KiteError && e.code === "BAD_REQUEST" && /^unknown parameter/.test(e.message)) throw new UsageError(e.message)
        throw e
      }
      if (json) process.stdout.write(JSON.stringify(r.result ? { ...r, result: withoutStartUrl(r.result) } : r) + "\n")
      if (r.missing) {
        if (!json) process.stderr.write(`kite: ${formatReplay(slug, r)}\n`)
        exitCode = 2
        return
      }
      if (o.dryRun) {
        if (!json) process.stdout.write(`dry run: ${r.batches} batch${r.batches === 1 ? "" : "es"}, nothing sent\n`)
        return
      }
      if (!json) process.stdout.write(formatReplay(slug, r) + "\n")
      if (!r.ok) exitCode = r.stoppedAt?.reason === "risky" ? 3 : 1
    })
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
  const cacheCmd = program.command("cache").description("the action cache that lets repeat runs skip searching for elements")
  cacheCmd.command("stats").action(() => run("cache.stats", {}))
  cacheCmd
    .command("clear")
    .option("--site <origin>", "only this origin, e.g. https://example.com")
    .action((o: { site?: string }) => {
      if (o.site !== undefined && !/^https?:\/\/[^/\s]+$/.test(o.site)) {
        throw new UsageError(`--site must be an origin like https://example.com: ${o.site}`)
      }
      return run("cache.clear", o.site ? { site: o.site } : {})
    })
  const recordCmd = program.command("record").description("record a task you do in Chrome once; replay it as a skill")
  recordCmd
    .command("start")
    .description("record your clicks and typing in this session's tab (values become parameters; secrets are never kept)")
    .requiredOption("--name <slug>", "the skill's name, e.g. ada-signup (skill kite-<slug>, plan <slug>)")
    .action(async (o: { name: string }) => {
      const { checkSkillTarget } = await import("./record/write-skill.js")
      if (!RECORD_NAME_RE.test(o.name)) throw new UsageError(`--name must be a lowercase slug like ada-signup: ${o.name}`)
      const r = (await call("record.start", { name: o.name }, { session: sessionName() })) as { name: string; tab: number; url: string }
      if (program.opts<Globals>().json) return void process.stdout.write(JSON.stringify(r) + "\n")
      process.stdout.write(`recording ${r.name} in tab ${r.tab} (${r.url}): do the task in Chrome, then run kite record stop\n`)
      try {
        checkSkillTarget(homedir(), o.name, false)
      } catch {
        process.stderr.write(`kite: skill kite-${o.name} already exists: kite record stop --force will replace it (backed up)\n`)
      }
    })
  recordCmd
    .command("stop")
    .description("stop recording and write the skill (~/.agents/skills/kite-<name>) and its plan")
    .option("--force", "replace an existing kite-<name> skill (the old folder is backed up) and a same-named plan's steps")
    .action(async (o: { force?: boolean }) => {
      const { prepareSkill, writeSkill } = await import("./record/write-skill.js")
      const force = !!o.force
      const session = { session: sessionName() }
      // Validate before consuming anything: on a refusal the recording goes on, so --force can still save it.
      const peek = (await call("record.stop", { peek: true }, session)) as Recording
      try {
        prepareSkill(homedir(), peek, { force })
      } catch (e) {
        throw new UsageError(`${(e as Error).message} (still recording)`)
      }
      // Write from the peek, and only then end the recording: a failed write leaves it in the browser to save again.
      let r
      try {
        r = writeSkill(homedir(), peek, { force })
      } catch (e) {
        throw new Error(`${(e as Error).message} (still recording: fix that and run kite record stop again)`)
      }
      const rec = peek
      const ended = (await call("record.stop", {}, session)) as Recording
      const late = ended.steps.length - peek.steps.length
      if (late > 0) process.stderr.write(`kite: warning: ${late} step${late === 1 ? "" : "s"} made while stopping ${late === 1 ? "was" : "were"} not saved\n`)
      for (const what of rec.skipped ?? []) {
        // a field's name comes from the page: no terminal control characters
        process.stderr.write(`kite: warning: not recorded: ${printable(what)} (set it by hand when replaying)\n`)
      }
      const names = paramsLine(rec)
      if (program.opts<Globals>().json) {
        return void process.stdout.write(JSON.stringify({ ...r, steps: rec.steps.length, skipped: rec.skipped ?? [] }) + "\n")
      }
      process.stdout.write(
        `saved skill kite-${rec.name}: ${r.skillPath}\nplan ${r.planSlug} (${rec.steps.length} step${rec.steps.length === 1 ? "" : "s"}${names ? `; params: ${names}` : ""})\n`,
      )
    })
  const memoryCmd = program.command("memory").description("plans the agent saved for repeat tasks (no values are ever stored)")
  memoryCmd.command("list").action(async () => {
    const { listPlans } = await import("./memory/store.js")
    const plans = listPlans(kiteHome())
    if (program.opts<Globals>().json) return void process.stdout.write(JSON.stringify(plans.map((s) => ({ id: s.id, ...s.plan }))) + "\n")
    if (!plans.length) return void process.stdout.write("no saved plans\n")
    for (const { id, plan: p } of plans) {
      const names = p.params.map((x) => (x.secret ? `${x.name}*` : x.name)).join(", ")
      process.stdout.write(`${id}  ${p.intent}  (${p.runs} runs${names ? `; params: ${names}` : ""})\n`)
    }
  })
  memoryCmd
    .command("find <intent>")
    .description("the saved plan that best matches <intent> (exit 1 when none)")
    .option("--site <url>", "only plans for this site")
    .action(async (intent: string, o: { site?: string }) => {
      const { findAnyPlan, originSlug } = await import("./memory/store.js")
      let origin: string | undefined
      if (o.site !== undefined) {
        try {
          origin = new URL(o.site).origin
        } catch {
          throw new UsageError(`--site must be a URL like https://example.com: ${o.site}`)
        }
      }
      const hit = findAnyPlan(kiteHome(), intent, origin)
      if (program.opts<Globals>().json) process.stdout.write(JSON.stringify(hit ? { id: `${originSlug(hit.plan.origin)}/${hit.slug}`, slug: hit.slug, intent: hit.plan.intent, params: hit.plan.params, score: hit.score } : null) + "\n")
      else if (!hit) process.stdout.write("no plan\n")
      else {
        const names = hit.plan.params.map((x) => (x.secret ? `${x.name}*` : x.name)).join(", ")
        process.stdout.write(`${originSlug(hit.plan.origin)}/${hit.slug}  ${hit.plan.intent}  (score ${hit.score.toFixed(2)}${names ? `; params: ${names}` : ""})\n`)
      }
      if (!hit) exitCode = 1
    })
  memoryCmd.command("show <slug>").action(async (id: string) => {
    const { planById } = await import("./memory/store.js")
    let stored
    try {
      stored = planById(kiteHome(), id)
    } catch (e) {
      throw new UsageError((e as Error).message)
    }
    process.stdout.write(JSON.stringify(stored.plan, null, 2) + "\n")
  })
  memoryCmd
    .command("save <intent>")
    .description("save this session's batches since the last save as a plan for <intent>")
    .action(async (intent: string) => {
      const { savePending } = await import("./memory/pending.js")
      if (!intent.trim()) throw new UsageError("intent must not be empty")
      const { staleSkillNote } = await import("./record/write-skill.js")
      const saved = savePending(kiteHome(), sessionName(), intent.trim())
      if (!saved) throw new UsageError(`nothing to save: no batches journaled in session "${sessionName()}"`)
      if (saved.note) process.stderr.write(`kite: note: ${saved.note}\n`)
      const stale = saved.updated && staleSkillNote(homedir(), saved.id, saved.plan.origin)
      if (stale) process.stderr.write(`kite: note: ${stale}\n`)
      if (program.opts<Globals>().json) return void process.stdout.write(JSON.stringify({ id: saved.id, updated: !!saved.updated, ...saved.plan }) + "\n")
      const names = saved.plan.params.map((x) => (x.secret ? `${x.name}*` : x.name)).join(", ")
      const n = saved.plan.batches.length
      process.stdout.write(`${saved.updated ? "updated" : "saved"} plan ${saved.id} (${n} batch${n === 1 ? "" : "es"}${names ? `; params: ${names}` : ""})\n`)
    })
  memoryCmd
    .command("discard")
    .description("drop this session's batches since the last save")
    .action(async () => {
      const { discardPending } = await import("./memory/pending.js")
      process.stdout.write(discardPending(kiteHome(), sessionName()) ? "discarded pending steps\n" : "nothing pending\n")
    })
  memoryCmd.command("forget <slug>").action(async (id: string) => {
    const { forgetPlan } = await import("./memory/store.js")
    let removed: boolean
    try {
      removed = forgetPlan(kiteHome(), id)
    } catch (e) {
      throw new UsageError((e as Error).message)
    }
    if (!removed) throw new UsageError(`no such plan: ${id}`)
    process.stdout.write(`forgot ${id}\n`)
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

/** Page-derived text without control characters (an accessible name could carry terminal escapes). */
const printable = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, "")

/** Param names of a recording, secrets starred. */
function paramsLine(rec: Recording): string {
  const names = [...new Set([...JSON.stringify(rec.steps).matchAll(/\{\{([a-z0-9_]+)\}\}/g)].map((m) => m[1]!))]
  return names.map((n) => (rec.secrets.includes(n) ? `${n}*` : n)).join(", ")
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

/** A Step[] or {steps, ...}; the extension validates the steps themselves. */
function batchParams(text: string): Record<string, unknown> {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch (e) {
    throw new UsageError(`invalid batch: ${(e as Error).message}`)
  }
  if (Array.isArray(v)) return { steps: v }
  if (v && typeof v === "object" && Array.isArray((v as { steps?: unknown }).steps)) return v as Record<string, unknown>
  throw new UsageError("invalid batch: expected a JSON array of steps or an object with a steps array")
}

async function readStdin(): Promise<string> {
  let s = ""
  for await (const chunk of process.stdin) s += chunk
  return s
}

function tabId(s: string): number {
  const n = Number(s)
  if (!Number.isInteger(n)) throw new UsageError(`invalid tab id: ${s}`)
  return n
}
