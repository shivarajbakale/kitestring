// Time-to-done benchmark. Every mode is scripted: no model is called and nothing costs credits.
// Agent thinking time is NOT simulated: the numbers are what Kitestring and the browser spend, per task.
//
//   pnpm bench            run and print the table
//   pnpm bench --write    also write docs/bench.md
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { cpus, platform, release, arch, tmpdir } from "node:os"
import { join } from "node:path"
import { startTorture } from "../torture/server.ts"
import { launchWithExtension, makeKiteHome, ROOT, runKite, type KiteRun } from "../../e2e/launch.ts"
import { TASKS, type BenchStep } from "./tasks.ts"

const REPS = 3
const MODES = [
  { id: 1, name: "single actions" },
  { id: 2, name: "one batch per page" },
  { id: 3, name: "plan replay, cold cache" },
  { id: 4, name: "plan replay, warm cache" },
] as const

interface Cell {
  task: string
  mode: number
  wallMs: number
  browserMs: number
  calls: number
  cached: number
  /** Set when a replay stopped before the end (not at a risky halt): the numbers are then not comparable. */
  stopped?: string
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

async function main(): Promise<void> {
  const write = process.argv.includes("--write")
  const kiteHome = makeKiteHome()
  const files = mkdtempSync(join(tmpdir(), "kitebench-"))
  for (const f of ["kite.zip", "s1.png", "icon.png"]) writeFileSync(join(files, f), f)
  const torture = await startTorture(0)
  const { context, close } = await launchWithExtension(kiteHome)
  const kite = (...args: string[]): Promise<KiteRun> => runKite(kiteHome, {}, args)
  const ok = (r: KiteRun, what: string, codes = [0]): KiteRun => {
    if (!codes.includes(r.code ?? -1)) throw new Error(`${what} failed (exit ${r.code}): ${r.stdout}${r.stderr}`)
    return r
  }
  const cells: Cell[] = []
  try {
    for (const task of TASKS) {
      const url = torture.url + task.path
      ok(await kite("tab", "new", url), "tab new")
      const activity = async (): Promise<{ id: number; method: string; ms: number }[]> => {
        const r = ok(await kite("--json", "activity", "--limit", "500"), "activity")
        const v = JSON.parse(r.stdout) as unknown
        return (Array.isArray(v) ? v : (v as { entries: unknown[] }).entries) as { id: number; method: string; ms: number }[]
      }
      const lastActivityId = async () => Math.max(0, ...(await activity()).map((e) => e.id))
      const activitySince = async (id: number) => (await activity()).filter((e) => e.id > id && e.method.startsWith("act."))
      const batchOf = (page: BenchStep[]) => page.map(stepJson)
      function stepJson(s: BenchStep): Record<string, unknown> {
        return {
          action: s.action,
          target: s.target,
          ...(s.role ? { role: s.role } : {}),
          ...(s.value !== undefined ? { value: s.value } : {}),
          ...(s.file ? { files: [join(files, s.file)] } : {}),
        }
      }
      const reset = async () => {
        ok(await kite("goto", url), "goto")
        ok(await kite("cache", "clear"), "cache clear")
        ok(await kite("memory", "discard"), "memory discard")
      }
      const verify = async (what: string) => {
        const page = context.pages().find((p) => p.url().startsWith(torture.url + "/"))
        if (!page) throw new Error(`${what}: no torture page`)
        // navigations settle before the batch returns, but give the final page a moment to run its script
        const deadline = Date.now() + 3000
        for (;;) {
          const result = String(await page.evaluate(() => (window as unknown as { __result?: unknown }).__result).catch(() => "undefined"))
          if (task.done({ url: page.url(), result })) return
          if (Date.now() > deadline) throw new Error(`${what}: ${task.name} did not reach its end (${page.url()} ${result})`)
          await new Promise((r) => setTimeout(r, 50))
        }
      }

      // setup: the scripted first run (one batch per page), then the plan every replay uses
      await reset()
      for (const page of task.pages) {
        ok(await runKite(kiteHome, {}, ["batch", "-"], JSON.stringify(batchOf(page))), `${task.name} setup batch`)
      }
      await verify("setup")
      const saved = JSON.parse(ok(await kite("--json", "memory", "save", task.intent), "memory save").stdout) as {
        id: string
        params: { name: string }[]
      }
      const values = task.pages.flat().filter((s) => s.action !== "click").map((s) => (s.file ? join(files, s.file) : s.value!))
      if (values.length !== saved.params.length) {
        throw new Error(`${task.name}: plan has ${saved.params.length} params, the task has ${values.length} values`)
      }
      const paramArgs = saved.params.flatMap((p, i) => ["--param", `${p.name}=${values[i]}`])
      const flat = task.pages.flat()

      const once = async (mode: number): Promise<Omit<Cell, "task" | "mode">> => {
        if (mode === 4) {
          ok(await kite("goto", url), "goto")
          ok(await kite("memory", "discard"), "memory discard")
        } else await reset()
        let wallMs = 0
        let browserMs = 0
        let calls = 0
        let cached = 0
        if (mode === 1) {
          const before = await lastActivityId()
          for (const s of flat) {
            const args = ["--json", s.action, s.target, ...(s.action === "fill" || s.action === "select" ? [s.value!] : []), ...(s.action === "upload" ? [join(files, s.file!)] : []), ...(s.role ? ["--role", s.role] : [])]
            const r = ok(await kite(...args), `${task.name} ${s.action} ${s.target}`)
            wallMs += r.ms
            calls++
          }
          // a single action's result carries no ms: sum the extension's own record of the calls made
          browserMs = (await activitySince(before)).reduce((n, e) => n + e.ms, 0)
        } else if (mode === 2) {
          for (const page of task.pages) {
            const r = ok(await runKite(kiteHome, {}, ["--json", "batch", "-"], JSON.stringify(batchOf(page))), `${task.name} batch`)
            wallMs += r.ms
            browserMs += (JSON.parse(r.stdout) as { steps: { ms: number }[] }).steps.reduce((n, s) => n + s.ms, 0)
            calls++
          }
        } else {
          // exit 3: the plan ended at a risky halt, the expected end. Exit 1: it stopped early (reported below).
          const r = ok(await kite("--json", "run", saved.id, ...paramArgs), `${task.name} run`, [0, 1, 3])
          const res = JSON.parse(r.stdout) as { ok: boolean; ms: number; cached?: number; stoppedAt?: { reason: string; detail: string } }
          if (!res.ok && res.stoppedAt?.reason !== "risky") {
            const at = res.stoppedAt as unknown as { batch: number; step: number; reason: string; detail: string }
            return { wallMs: r.ms, browserMs: res.ms, calls: 1, cached: res.cached ?? 0, stopped: `batch ${at.batch + 1} step ${at.step + 1}: ${at.reason}, ${at.detail}` }
          }
          wallMs = r.ms
          browserMs = res.ms
          cached = res.cached ?? 0
          calls = 1
        }
        await verify(`mode ${mode}`)
        return { wallMs, browserMs, calls, cached }
      }

      for (const m of MODES) {
        if (m.id === 4) await once(4) // warm the cache; not timed
        const reps: Omit<Cell, "task" | "mode">[] = []
        for (let i = 0; i < REPS; i++) {
          reps.push(await once(m.id))
          if (reps.at(-1)!.stopped) break
        }
        const cell: Cell = {
          task: task.name,
          mode: m.id,
          wallMs: median(reps.map((r) => r.wallMs)),
          browserMs: median(reps.map((r) => r.browserMs)),
          calls: reps[0]!.calls,
          cached: median(reps.map((r) => r.cached)),
          ...(reps.some((r) => r.stopped) ? { stopped: reps.find((r) => r.stopped)!.stopped } : {}),
        }
        cells.push(cell)
        process.stderr.write(`${task.name} / ${m.name}: ${cell.stopped ? `replay stopped at ${cell.stopped}` : `${cell.wallMs} ms`}\n`)
      }
      ok(await kite("tab", "close"), "tab close")
    }
  } finally {
    await close().catch(() => undefined)
    await torture.close()
    rmSync(files, { recursive: true, force: true })
    rmSync(kiteHome, { recursive: true, force: true })
  }

  const table = render(cells)
  const stops = cells.filter((c) => c.stopped).map((c) => `- ${c.task}, mode ${c.mode}: the replay stopped at ${c.stopped}`)
  process.stdout.write(table + (stops.length ? "\n\n" + stops.join("\n") : "") + "\n")
  if (write) {
    const cpu = cpus()
    const machine = `${cpu[0]?.model.trim() ?? "unknown CPU"}, ${cpu.length} cores, ${platform()} ${release()} ${arch()}`
    const doc = [
      "# Time-to-done benchmark",
      "",
      `Date: ${new Date().toISOString().slice(0, 10)}  `,
      `Machine: ${machine}  `,
      `Node: ${process.version}`,
      "",
      "Four torture-site tasks, each run four ways. Every mode is scripted: no model is called and nothing costs credits.",
      "**Agent thinking time is not simulated.** The numbers are what Kitestring and Chrome spend; a real agent also spends model time on",
      "every tool call, so the `tool calls` column is the lever that matters most in practice.",
      "",
      table,
      ...(stops.length ? ["", ...stops] : []),
      "",
      "- Wall ms: median of 3 runs, measured around the `kite` processes (start-up included) and nothing else.",
      "- Browser ms: mode 2 sums the steps' own `ms`; mode 1 sums the extension's activity-log `ms` for its calls. Modes 3-4 report the replay's own total (`ms` in `kite run --json`), which also includes its RPC round trips.",
      "- Tool calls: what an agent would make. Mode 1 one per step, mode 2 one per page, modes 3-4 one `kite run`.",
      "- Cached: steps the action cache served (modes 3-4; mode 3 starts cold, so only repeats within a run hit).",
      "- `multi-page-checkout` ends on the review page, one click short of the risky \"Place order\"; the agent makes that click itself.",
      "- Each repetition starts from a fresh page load and a cleared cache, except mode 4, which keeps the cache warmed by one untimed run.",
      "",
      "Reproduce: `pnpm build && pnpm bench --write`.",
      "",
    ].join("\n")
    mkdirSync(join(ROOT, "docs"), { recursive: true })
    writeFileSync(join(ROOT, "docs", "bench.md"), doc)
    process.stderr.write("wrote docs/bench.md\n")
  }
}

function render(cells: Cell[]): string {
  const rows = ["| Task | Mode | Wall ms | Browser ms | Tool calls | Cached |", "| --- | --- | ---: | ---: | ---: | ---: |"]
  for (const c of cells) {
    const mode = MODES.find((m) => m.id === c.mode)!
    if (c.stopped) {
      rows.push(`| ${c.task} | ${c.mode} ${mode.name} | stopped | stopped | 1 | ${c.cached} |`)
      continue
    }
    rows.push(`| ${c.task} | ${c.mode} ${mode.name} | ${c.wallMs} | ${c.browserMs} | ${c.calls} | ${c.mode >= 3 ? c.cached : "-"} |`)
  }
  return rows.join("\n")
}

main().catch((e) => {
  process.stderr.write(`bench failed: ${e instanceof Error ? e.stack : e}\n`)
  process.exit(1)
})
