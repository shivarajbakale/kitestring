import { HANDOFF_REASON_MAX, HANDOFF_WAIT_MS, parseTarget, type BatchResult, type Method, type ScreenshotResult, type Step } from "@kitestring/protocol"
import { homedir } from "node:os"
import { z } from "zod"
import { KiteError, call } from "../client/rpc-client.js"
import { human } from "../client/human.js"
import { formatReplay } from "../client/format.js"
import { appendPending, discardPending, recordReplayStop, savePending } from "../memory/pending.js"
import { runPlan } from "../memory/replay.js"
import { findAnyPlan, planById } from "../memory/store.js"
import { staleSkillNote } from "../record/write-skill.js"
import { kiteHome } from "../paths.js"
import { resolveUploads } from "../upload-guard.js"

export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" }
export interface ToolResult {
  [k: string]: unknown
  content: ToolContent[]
  isError?: boolean
}

/** A tool that is one extension call. */
interface RpcTool {
  name: string
  description: string
  method: Method
  shape: z.ZodRawShape
  params: (a: any) => Record<string, unknown>
}

/** A tool Kitestring answers itself (site memory), possibly calling the extension. */
interface LocalTool {
  name: string
  description: string
  shape: z.ZodRawShape
  run: (a: any, session: string) => Promise<string>
}

type ToolDef = RpcTool | LocalTool

const target = z.string().describe("visible text of the element, or an @ref from the last snapshot")
const within = z.string().optional().describe("name of a section/dialog the element is inside")
const role = z.string().optional().describe("ARIA role to disambiguate, e.g. button")
const tgt = (a: { target: string; within?: string; role?: string }) => parseTarget(a.target, { within: a.within, role: a.role })

/**
 * Bound on one MCP tool call. Sits under the smallest agent tool timeout (Codex `tool_timeout_sec = 60`)
 * so a stuck browser surfaces kite's own `TIMEOUT: timed out waiting for the browser`, and above the
 * extension's own caps (15 s action/snapshot, page agent 30 s), including screenshots.
 * `KITE_TIMEOUT_MS` overrides it.
 */
export const MCP_TIMEOUT_MS = 45_000
function mcpTimeout(): number {
  const n = Number(process.env.KITE_TIMEOUT_MS)
  return Number.isInteger(n) && n > 0 ? n : MCP_TIMEOUT_MS
}

const LOOP = "Loop: snapshot, act by visible text or @ref, read the returned diff."

const expectSchema = z.union([z.object({ text: z.string() }), z.object({ url: z.string() })]).describe("checked after the step: page text contains {text}, or the URL contains {url} (or matches /regex/)")
const stepBase = {
  wait: z.number().min(0).max(10_000).optional().describe("ms to wait for the target to appear (max 10000)"),
  expect: expectSchema.optional(),
  if_present: z.boolean().optional().describe("target missing: skip this step and continue"),
  within,
  role,
  dialog: z.enum(["accept", "dismiss"]).optional().describe("what to do with a confirm/prompt this step opens"),
}
const batchStep = z.discriminatedUnion("action", [
  z.object({ ...stepBase, action: z.literal("goto"), url: z.string() }),
  z.object({ ...stepBase, action: z.literal("click"), target }),
  z.object({ ...stepBase, action: z.literal("fill"), target, value: z.string() }),
  z.object({ ...stepBase, action: z.literal("select"), target, value: z.string() }),
  z.object({ ...stepBase, action: z.literal("press"), key: z.string() }),
  z.object({ ...stepBase, action: z.literal("scroll"), direction: z.enum(["up", "down"]), px: z.number().int().positive().optional() }),
  z.object({ ...stepBase, action: z.literal("upload"), target, files: z.array(z.string()).min(1).describe("local file paths") }),
  z.object({ ...stepBase, action: z.literal("switch_tab"), to: z.union([z.literal("new"), z.literal("opener"), z.number().int()]) }),
  z.object({ ...stepBase, action: z.literal("wait"), ms: z.number().min(0).max(10_000).optional() }),
])

/** MCP step -> protocol Step: string targets become Target objects (the step's within/role fold in); upload paths are checked. */
function batchStepParams(s: z.infer<typeof batchStep>): Record<string, unknown> {
  const { within: w, role: r, ...rest } = s as typeof s & { within?: string; role?: string }
  const out: Record<string, unknown> = { ...rest }
  if ("target" in s) out.target = parseTarget(s.target, { within: w, role: r })
  else {
    if (w !== undefined) out.within = w
    if (r !== undefined) out.role = r
  }
  if (s.action === "upload") {
    out.files = resolveUploads(s.files, { cwd: process.cwd(), home: homedir(), kiteHome: kiteHome(), env: process.env })
  }
  return out
}

/** How long one browser_ask_human call waits: inside this call's own bound, with room for the reply. */
function askWait(): number {
  return Math.max(0, Math.min(HANDOFF_WAIT_MS, mcpTimeout() - 5_000))
}

function batchBudget(): { budget_ms?: number } {
  const n = Number(process.env.KITE_BATCH_BUDGET_MS)
  return Number.isInteger(n) && n > 0 ? { budget_ms: n } : {}
}

export const TOOLS: ToolDef[] = [
  { name: "browser_status", description: "Show whether the browser extension is connected and this session's state.", method: "status", shape: {}, params: () => ({}) },
  { name: "browser_tabs", description: "List the tabs this session owns.", method: "tab.list", shape: {}, params: () => ({}) },
  {
    name: "browser_tab_new",
    description: "Open a new tab at a URL in this session and make it active (always pass url; without it the tab is blank). Then call browser_snapshot.",
    method: "tab.new",
    shape: { url: z.string().optional() },
    params: (a) => (a.url ? { url: a.url } : {}),
  },
  { name: "browser_tab_use", description: "Make a tab of this session the active one.", method: "tab.use", shape: { id: z.number().int().nonnegative() }, params: (a) => ({ id: a.id }) },
  {
    name: "browser_tab_close",
    description: "Close a tab of this session (the active tab if no id).",
    method: "tab.close",
    shape: { id: z.number().int().nonnegative().optional() },
    params: (a) => (a.id !== undefined ? { id: a.id } : {}),
  },
  { name: "browser_goto", description: `Navigate the active tab to a URL. ${LOOP}`, method: "page.goto", shape: { url: z.string() }, params: (a) => ({ url: a.url }) },
  {
    name: "browser_snapshot",
    description: `Read the active page as text: elements with @refs. Start here. ${LOOP}`,
    method: "page.snapshot",
    shape: { full: z.boolean().optional().describe("include everything, not just the viewport"), scope: z.string().optional().describe("limit to this @ref") },
    params: (a) => ({ full: !!a.full, ...(a.scope ? { scope: a.scope } : {}) }),
  },
  {
    name: "browser_click",
    description: `Click an element by visible text or @ref. Read the returned diff to see what changed. ${LOOP}`,
    method: "act.click",
    shape: { target, within, role },
    params: (a) => ({ target: tgt(a) }),
  },
  {
    name: "browser_fill",
    description: "Type text into an input found by visible label/text or @ref. Read the returned diff.",
    method: "act.fill",
    shape: { target, text: z.string(), within },
    params: (a) => ({ target: tgt(a), text: a.text }),
  },
  {
    name: "browser_select",
    description: "Choose an option in a select found by visible text or @ref. Read the returned diff.",
    method: "act.select",
    shape: { target, value: z.string(), within, role },
    params: (a) => ({ target: tgt(a), value: a.value }),
  },
  {
    name: "browser_upload",
    description:
      "Upload local files through a file input, a button or a drop zone found by visible text or @ref. Paths are absolute or relative to the working directory; sensitive locations (~/.ssh, ~/.aws, ~/.config, .env files) are refused. Read the returned diff.",
    method: "act.upload",
    shape: { target, files: z.array(z.string()).min(1).describe("local file paths"), within, role },
    params: (a) => ({
      target: tgt(a),
      files: resolveUploads(a.files, { cwd: process.cwd(), home: homedir(), kiteHome: kiteHome(), env: process.env }),
    }),
  },
  { name: "browser_press", description: "Press a key (e.g. Enter, Escape, Tab). Read the returned diff.", method: "act.press", shape: { key: z.string() }, params: (a) => ({ key: a.key }) },
  {
    name: "browser_scroll",
    description: "Scroll the page up or down. Read the returned diff.",
    method: "act.scroll",
    shape: { direction: z.enum(["up", "down"]), px: z.number().int().positive().optional() },
    params: (a) => ({ direction: a.direction, ...(a.px !== undefined ? { px: a.px } : {}) }),
  },
  {
    name: "browser_console",
    description: "Read console messages and uncaught errors of the active tab (newest entries).",
    method: "page.console",
    shape: { level: z.enum(["all", "error"]).optional(), limit: z.number().int().positive().optional(), clear: z.boolean().optional() },
    params: (a) => ({ level: a.level ?? "all", limit: a.limit ?? 50, clear: !!a.clear }),
  },
  {
    name: "browser_network",
    description: "Read network requests of the active tab (newest entries).",
    method: "page.network",
    shape: { failed: z.boolean().optional(), filter: z.string().optional(), limit: z.number().int().positive().optional(), clear: z.boolean().optional() },
    params: (a) => ({ failed: !!a.failed, ...(a.filter ? { filter: a.filter } : {}), limit: a.limit ?? 50, clear: !!a.clear }),
  },
  {
    name: "browser_screenshot",
    description: "PNG screenshot of the active tab, whole page with full, or one element by @ref.",
    method: "page.screenshot",
    shape: { full: z.boolean().optional(), ref: z.string().optional() },
    params: (a) => ({ full: !!a.full, ...(a.ref ? { ref: a.ref } : {}) }),
  },
  {
    name: "browser_ask_human",
    description:
      "Ask the user to do something only a person should: solve a captcha, enter a 2FA code or a password, log in, approve a payment. They get a Chrome notification and the tab comes to the front. Waits up to 40 s per call: on \"waiting\" call again with the same reason; on \"done\" take a snapshot and continue; on \"declined\" stop and tell the user what is blocked.",
    method: "human.ask",
    shape: { reason: z.string().min(1).max(HANDOFF_REASON_MAX).describe("what the user should do, one short sentence, e.g. \"Solve the captcha on the login page\"") },
    params: (a) => ({ reason: a.reason, wait_ms: askWait() }),
  },
  {
    name: "browser_batch",
    description:
      "Prefer this over single actions when you know several steps ahead (forms, multi-page flows). Steps run in order with lazy targets; the batch stops at the first problem and tells you which step to resend from.",
    method: "act.batch",
    shape: {
      steps: z.array(batchStep).min(1).max(50).describe("steps in order; each has an action (goto, click, fill, select, press, scroll, upload, switch_tab, wait)"),
      allow_domains: z.array(z.string()).optional().describe("extra registrable domains the batch may move to"),
    },
    params: (a) => ({
      steps: (a.steps as z.infer<typeof batchStep>[]).map(batchStepParams),
      ...(a.allow_domains ? { allow_domains: a.allow_domains } : {}),
      ...batchBudget(),
    }),
  },
  {
    name: "browser_plan_find",
    description:
      "Before a multi-step task on a site, look for a plan saved from an earlier run of the same task. Returns {id, slug, intent, params, score} or \"no plan\". Run it with browser_plan_run, passing its id (<site>/<slug>).",
    shape: {
      intent: z.string().min(1).describe("the task in a few words, e.g. \"fill the shipping form\""),
      url: z.string().optional().describe("the site the task is on (default: the active tab's)"),
    },
    run: async (a: { intent: string; url?: string }, session) => {
      let url = a.url
      if (!url) {
        try {
          const r = (await call("tab.list", {}, { session, timeoutMs: mcpTimeout() })) as { tabs?: { url?: string; active?: boolean }[] }
          url = r.tabs?.find((t) => t.active)?.url
        } catch {
          /* no browser: search every site */
        }
      }
      let origin: string | undefined
      try {
        origin = url ? new URL(url).origin : undefined
      } catch {
        throw new KiteError("BAD_REQUEST", `not a URL: ${url}`)
      }
      const best = findAnyPlan(kiteHome(), a.intent, origin)
      if (!best) return "no plan"
      return JSON.stringify({ id: best.id, slug: best.slug, intent: best.plan.intent, params: best.plan.params, score: Math.round(best.score * 100) / 100 })
    },
  },
  {
    name: "browser_plan_run",
    description:
      "Replay a saved plan with its parameter values (every param, by name). Stops at the first problem and leaves the page there: take over from stoppedAt with browser_snapshot / browser_batch, finish the task, then browser_plan_save updates the plan.",
    shape: {
      slug: z.string().min(1).describe("the plan's id from browser_plan_find (<site>/<slug>); a bare slug works when only one site has it"),
      params: z.record(z.string()).optional().describe("value for each of the plan's params, by name"),
      secrets: z
        .array(z.string())
        .optional()
        .describe("names of params whose values are secret (passwords, codes): never kept, not even hashed"),
    },
    run: async (a: { slug: string; params?: Record<string, string>; secrets?: string[] }, session) => {
      let stored
      try {
        stored = planById(kiteHome(), a.slug)
      } catch (e) {
        throw new KiteError("BAD_REQUEST", (e as Error).message)
      }
      const notes: string[] = []
      const values = a.params ?? {}
      const stray = (a.secrets ?? []).filter((n) => !Object.hasOwn(values, n))
      if (stray.length) throw new KiteError("BAD_REQUEST", `secrets names ${stray.join(", ")}, not given in params`)
      const secretNames = new Set(a.secrets ?? [])
      const r = await runPlan(stored.plan, values, {
        call: (method, params) => call(method, params, { session, timeoutMs: mcpTimeout() }),
        out: (line) => void notes.push(line),
        secretNames,
        // a replay starts a new task memory; a stop makes it the takeover of this plan (saving updates the plan)
        onStart: () => void discardPending(kiteHome(), session),
        onStop: (at) => recordReplayStop(kiteHome(), session, stored.id, stored.plan, at, values, secretNames),
      })
      const text = [...notes, formatReplay(stored.id.split("/")[1]!, r)].join("\n")
      if (r.missing) throw new KiteError("BAD_REQUEST", text)
      return text
    },
  },
  {
    name: "browser_plan_save",
    description:
      "After finishing a new multi-step task with browser_batch, save the batches you sent since the last save as a plan for this intent. Plans never hold the values you typed: they become params.",
    shape: { intent: z.string().min(1).describe("the task in a few words, e.g. \"fill the shipping form\"") },
    run: async (a: { intent: string }, session) => {
      const saved = savePending(kiteHome(), session, a.intent.trim())
      if (!saved) throw new KiteError("BAD_REQUEST", `nothing to save: no batches journaled in session "${session}"`)
      const names = saved.plan.params.map((x) => (x.secret ? `${x.name}*` : x.name)).join(", ")
      const n = saved.plan.batches.length
      const stale = saved.updated && staleSkillNote(homedir(), saved.id, saved.plan.origin)
      return `${saved.note ? `note: ${saved.note}\n` : ""}${stale ? `note: ${stale}\n` : ""}${saved.updated ? "updated" : "saved"} plan ${saved.id} (${n} batch${n === 1 ? "" : "es"}${names ? `; params: ${names} (* = secret)` : ""})`
    },
  },
  {
    name: "browser_plan_discard",
    description: "Forget the batches journaled in this session since the last save (before starting an unrelated task you will not save).",
    shape: {},
    run: async (_a: unknown, session) => (discardPending(kiteHome(), session) ? "discarded pending steps" : "nothing pending"),
  },
]

export const TOOL_NAMES: string[] = TOOLS.map((t) => t.name)

export async function runTool(def: ToolDef, args: unknown, session: string): Promise<ToolResult> {
  try {
    if ("run" in def) return { content: [{ type: "text", text: await def.run(args ?? {}, session) }] }
    const params = def.params(args ?? {})
    const result = await call(def.method, params, { session, timeoutMs: mcpTimeout() })
    if (def.method === "page.screenshot") {
      return { content: [{ type: "image", data: (result as ScreenshotResult).data, mimeType: "image/png" }] }
    }
    let text = human(def.method, result)
    if (def.method === "act.batch" && Array.isArray((result as BatchResult | null)?.steps)) {
      // Journal the agent's ok steps for browser_plan_save (no values). Memory never fails the batch.
      const b = result as BatchResult
      const note = appendPending(kiteHome(), session, b.startUrl ?? "", params.steps as Step[], b)
      if (note) text += `\n${note}`
    }
    return { content: [{ type: "text", text }] }
  } catch (e) {
    // Some extension messages already start with their code ("PAUSED: …"): prefix it once.
    const text =
      e instanceof KiteError
        ? `${e.code}: ${e.message.startsWith(`${e.code}: `) ? e.message.slice(e.code.length + 2) : e.message}`
        : `INTERNAL: ${e instanceof Error ? e.message : String(e)}`
    return { content: [{ type: "text", text }], isError: true }
  }
}
