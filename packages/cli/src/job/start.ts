import { resolve } from "node:path"
import type { Method } from "@kitestring/protocol"
import { formatOf } from "../client/extract.js"
import { KiteError } from "../client/rpc-client.js"
import { SCRIPT_MAX_CHARS } from "../script/run.js"
import { compileSpec, parseSpec, specId, specNeedsInput, type Spec } from "./spec.js"
import { JOB_DEFAULT_MS, JOB_MAX_MS, createJob, loadRecipe, saveRecipe, type JobDef, type JobWork } from "./store.js"
import { spawnJob } from "./run.js"

export interface JobInput {
  code?: string
  spec?: unknown
  recipe?: string
  params?: Record<string, string>
  /** File for the rows at the end, relative to `cwd`. */
  save?: string
  /** Column rows repeat by. */
  id?: string
  /** Page to start on (default: a spec's start, else `currentUrl`). */
  url?: string
  window?: "front" | "background"
  timeoutMin?: number
  /** Also save it as a recipe under this name (run again with other params, or on a schedule). */
  saveAs?: string
  /** Name part of the job id. */
  name?: string
}

const fill = (t: string, vars: Record<string, string>): string => t.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined ? m : encodeURIComponent(vars[k]!)))

/** What the input asks to run, checked: code, a spec or a recipe (exactly one), with its params and start page. */
export function jobWork(home: string, i: JobInput, currentUrl?: string): { work: JobWork; recipe?: string } {
  const given = [i.code !== undefined, i.spec !== undefined, i.recipe !== undefined].filter(Boolean).length
  if (given !== 1) throw new KiteError("BAD_REQUEST", "pass exactly one of code, spec or recipe")
  if (i.timeoutMin !== undefined && (!Number.isFinite(i.timeoutMin) || i.timeoutMin <= 0 || i.timeoutMin * 60_000 > JOB_MAX_MS)) {
    throw new KiteError("BAD_REQUEST", `timeout must be 1 to ${JOB_MAX_MS / 60_000} minutes`)
  }
  const timeoutMs = i.timeoutMin !== undefined ? Math.round(i.timeoutMin * 60_000) : undefined
  if (i.recipe !== undefined) {
    let r
    try {
      r = loadRecipe(home, i.recipe)
    } catch (e) {
      throw new KiteError("BAD_REQUEST", (e as Error).message)
    }
    const params = { ...r.params, ...(i.params ?? {}) }
    const start = i.url ?? (r.kind === "spec" && r.spec?.start ? fill(r.spec.start, { ...(r.spec.params ?? {}), ...params }) : r.startUrl)
    return {
      recipe: r.name,
      work: {
        kind: r.kind,
        ...(r.code !== undefined ? { code: r.code } : {}),
        ...(r.spec ? { spec: r.spec } : {}),
        params,
        ...(i.id ?? r.rowId ? { rowId: i.id ?? r.rowId } : {}),
        ...(start ? { startUrl: start } : {}),
        window: i.window ?? r.window,
        timeoutMs: timeoutMs ?? r.timeoutMs,
      },
    }
  }
  const params = i.params ?? {}
  if (i.code !== undefined) {
    if (!i.code.trim() || i.code.length > SCRIPT_MAX_CHARS) throw new KiteError("BAD_REQUEST", `code must be 1 to ${SCRIPT_MAX_CHARS} characters`)
    const start = i.url ?? currentUrl
    return {
      work: { kind: "script", code: i.code, params, ...(i.id ? { rowId: i.id } : {}), ...(start ? { startUrl: start } : {}), window: i.window ?? "front", timeoutMs: timeoutMs ?? JOB_DEFAULT_MS },
    }
  }
  const spec: Spec = parseSpec(i.spec)
  const start = i.url ?? (spec.start ? fill(spec.start, { ...(spec.params ?? {}), ...params }) : currentUrl)
  const rowId = i.id ?? specId(spec)
  return {
    work: {
      kind: "spec",
      spec,
      params,
      ...(rowId ? { rowId } : {}),
      ...(start ? { startUrl: start } : {}),
      // Reading alone works in a background tab; scrolling or clicking for more needs a window in front.
      window: i.window ?? (specNeedsInput(spec) ? "front" : "background"),
      timeoutMs: timeoutMs ?? JOB_DEFAULT_MS,
    },
  }
}

/** Creates the job (and the recipe, with saveAs) and starts its process. */
export function startJob(home: string, i: JobInput, o: { cwd: string; currentUrl?: string }): JobDef {
  const { work, recipe } = jobWork(home, i, o.currentUrl)
  if (!work.startUrl) throw new KiteError("BAD_REQUEST", "no page to start on: pass url (or open the page first, or give the spec a start)")
  if (!/^https?:\/\//.test(work.startUrl)) throw new KiteError("BAD_REQUEST", `the start page must be an http(s) URL: ${work.startUrl}`)
  let save: string | undefined
  if (i.save) {
    formatOf(i.save)
    save = resolve(o.cwd, i.save)
  }
  if (i.saveAs) saveRecipe(home, i.saveAs, work, save ? formatOf(save) : "csv")
  const def = createJob(home, { ...work, ...(save ? { save } : {}), ...(recipe ? { recipe } : {}), ...(i.name ? { name: i.name } : i.saveAs ? { name: i.saveAs } : {}) })
  spawnJob(home, def.id)
  return def
}

/** A spec's code for a quick try in the caller's own tab: at most `limit` rows. */
export function dryRunCode(spec: Spec, limit = 3): string {
  return compileSpec({ ...spec, limit: Math.min(spec.limit ?? limit, limit), ...(spec.inputs ? { inputs: spec.inputs.slice(0, 1) } : {}) })
}

/**
 * Puts the caller's tab where a dry run starts: a session with no tab opens one at `url` (or the spec's start), and an
 * explicit `url` is visited. A spec with a start goes there itself.
 */
export async function prepareDryRun(call: (method: Method, params: Record<string, unknown>) => Promise<unknown>, spec: Spec | undefined, i: { url?: string; params?: Record<string, string> }): Promise<void> {
  const start = i.url ?? (spec?.start ? fill(spec.start, { ...(spec.params ?? {}), ...(i.params ?? {}) }) : undefined)
  const tabs = ((await call("tab.list", {})) as { tabs?: { active?: boolean }[] }).tabs ?? []
  if (!tabs.some((t) => t.active)) {
    if (!start) throw new KiteError("NO_TAB", "no tab to try it in: pass url, or open the page first")
    await call("tab.new", { url: start })
    return
  }
  if (i.url) await call("page.goto", { url: i.url })
}
