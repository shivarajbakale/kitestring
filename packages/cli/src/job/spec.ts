import { z } from "zod"
import { KiteError } from "../client/rpc-client.js"

/**
 * A bulk extraction as data: where the records are and how to reach all of them. It compiles to a script on the same
 * helpers an agent writes by hand (collect, readEach, fetchJson, emit), so a spec and a script run, save, resume and
 * schedule the same way.
 *
 * - `list`: rows of a list on the page (`items` + `fields`, or what extract finds), with `more` ("scroll" or a next
 *   button's text) for the rest.
 * - `api`: rows from a JSON endpoint the page itself calls (see a probe's "network JSON"), page after page.
 * - `detail`: open each row's link and read fields there (a place's phone, a product's specs), joined to the row.
 * - `inputs`: run it all once per set of values (each search term, each area), merged over `params`.
 */
const fields = z.record(z.string().min(1).max(60), z.string().max(500))
const template = z.string().min(1).max(2_000)

export const Spec = z
  .object({
    /** URL to open, with {param} placeholders; without it the job starts on the page it was started from. */
    start: template.optional(),
    /** Default values of the {placeholders}. */
    params: z.record(z.string().max(500)).optional(),
    inputs: z.array(z.record(z.string().max(500))).min(1).max(1_000).optional(),
    list: z
      .object({
        items: z.string().min(1).max(500).optional(),
        near: z.string().min(1).max(200).optional(),
        fields: fields.optional(),
        more: z.string().min(1).max(200).optional(),
        rounds: z.number().int().min(1).max(2_000).optional(),
        waitMs: z.number().int().min(0).max(30_000).optional(),
      })
      .strict()
      .optional(),
    api: z
      .object({
        /** With {page} (from `first`, +1 each time) or {offset} (0, `step`, 2×`step`, …). */
        url: template,
        /** Path to the records in the JSON (`data.items`, `[0][1]`; see the probe). */
        rows: z.string().max(200).default("(root)"),
        /** Name -> path inside one record; without it every record is kept whole. */
        fields: fields.optional(),
        pages: z.number().int().min(1).max(1_000).default(20),
        first: z.number().int().min(0).default(1),
        step: z.number().int().min(1).max(10_000).default(20),
      })
      .strict()
      .optional(),
    detail: z
      .object({
        /** The row column holding the link to open. */
        link: z.string().min(1).max(60).default("link"),
        fields: z.union([fields, z.literal("auto")]),
        wait: z.string().min(1).max(500).optional(),
        mode: z.enum(["tab", "fetch"]).optional(),
        concurrency: z.number().int().min(1).max(8).optional(),
        delayMs: z.number().int().min(0).max(60_000).optional(),
      })
      .strict()
      .optional(),
    /** The column that names a row: rows repeat by it (a resumed run, a scroll that shows a row again). */
    id: z.string().min(1).max(60).optional(),
    /** At most this many rows in all. */
    limit: z.number().int().min(1).max(50_000).optional(),
  })
  .strict()
  .refine((s) => s.list || s.api, { message: "a spec needs list or api: where the records are" })
  .refine((s) => !(s.list && s.api), { message: "a spec reads a list or an api, not both" })

export type Spec = z.infer<typeof Spec>

/** The spec checked, with its mistakes as BAD_REQUEST naming the field. */
export function parseSpec(v: unknown): Spec {
  const text = typeof v === "string" ? v : undefined
  let raw = v
  if (text !== undefined) {
    try {
      raw = JSON.parse(text)
    } catch (e) {
      throw new KiteError("BAD_REQUEST", `spec is not JSON: ${(e as Error).message}`)
    }
  }
  const r = Spec.safeParse(raw)
  if (!r.success) {
    const i = r.error.issues[0]!
    throw new KiteError("BAD_REQUEST", `spec${i.path.length ? `.${i.path.join(".")}` : ""}: ${i.message}`)
  }
  return r.data
}

/** The column rows repeat by: the spec's id, else (with detail pages) the link. */
export const specId = (s: Spec): string | undefined => s.id ?? (s.detail ? s.detail.link : undefined)

/** Whether a run clicks or scrolls (it then needs a window in front); reading alone works in a background tab. */
export const specNeedsInput = (s: Spec): boolean => !!s.list?.more

/**
 * The script a spec runs as. Placeholders take `params` (the job's values over the spec's defaults); with `inputs` each
 * set runs in turn, its values added to its rows, and a finished set is checkpointed so a resumed run skips it.
 */
export function compileSpec(s: Spec): string {
  const id = specId(s)
  return `const __spec = ${JSON.stringify(s)}
const __fill = (t, vars, enc) => t.replace(/\\{(\\w+)\\}/g, (m, k) => (vars[k] === undefined ? m : enc ? encodeURIComponent(vars[k]) : String(vars[k])))
const __at = (v, path) => {
  if (!path || path === "(root)" || path === ".") return v
  for (const m of path.matchAll(/([^.[\\]]+)|\\[(\\d+)\\]/g)) { if (v === null || typeof v !== "object") return undefined; v = m[2] !== undefined ? v[Number(m[2])] : v[m[1]] }
  return v
}
const __cell = (v) => (v === undefined || v === null ? "" : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v))
const sets = __spec.inputs ? __spec.inputs.map((x) => ({ ...(__spec.params || {}), ...params, ...x })) : [{ ...(__spec.params || {}), ...params }]
const done = new Set((resume && resume.done) || [])
let total = 0
for (let si = 0; si < sets.length; si++) {
  if (done.has(si)) continue
  const vars = sets[si]
  const extra = __spec.inputs ? __spec.inputs[si] : {}
  const room = __spec.limit ? __spec.limit - total : undefined
  if (room !== undefined && room <= 0) break
  if (__spec.start && (si > 0 || done.size || !(await tabs()).some((t) => t.active && t.url === __fill(__spec.start, vars, true)))) await goto(__fill(__spec.start, vars, true))
  const out = async (rows) => { const r = await emit(rows.map((x) => ({ ...extra, ...x }))); total = r.total }
  let rows = []
  if (__spec.api) {
    const a = __spec.api
    let before = -1
    for (let p = 0; p < a.pages; p++) {
      const url = __fill(a.url, { ...vars, page: a.first + p, offset: p * a.step }, false)
      const v = await fetchJson(url)
      const recs = __at(v, a.rows)
      if (!Array.isArray(recs) || !recs.length) break
      const mapped = recs.map((x) => (a.fields ? Object.fromEntries(Object.entries(a.fields).map(([k, path]) => [k, __cell(__at(x, path))])) : x && typeof x === "object" && !Array.isArray(x) ? x : { value: __cell(x) }))
      rows.push(...mapped)
      if (!__spec.detail) await out(mapped)
      console.log("api page " + (p + 1) + ": " + recs.length + " records")
      if (!a.url.includes("{page}") && !a.url.includes("{offset}")) break
      if (rows.length === before || (room !== undefined && rows.length >= room)) break
      before = rows.length
    }
  } else {
    rows = await collect({ ...__spec.list, ${id ? `id: ${JSON.stringify(id)}, ` : ""}...(room !== undefined ? { limit: room } : {}), emit: !__spec.detail && !__spec.inputs })
    if (!__spec.detail && __spec.inputs) await out(rows)
    if (!__spec.detail) total = (await emit([])).total
  }
  if (__spec.detail) {
    const d = __spec.detail
    const todo = rows.filter((r) => typeof r[d.link] === "string" && r[d.link]).map((r) => ({ ...extra, ...r }))
    if (!todo.length && rows.length) throw Object.assign(new Error("no row has a link in column " + JSON.stringify(d.link) + "; the columns are: " + Object.keys(rows[0]).join(", ")), { code: "BAD_REQUEST" })
    await readEach(room !== undefined ? todo.slice(0, room) : todo, d.fields, { link: d.link, emit: true, ...(d.wait ? { wait: d.wait } : {}), ...(d.mode ? { mode: d.mode } : {}), ...(d.concurrency ? { concurrency: d.concurrency } : {}), ...(d.delayMs !== undefined ? { delayMs: d.delayMs } : {}) })
    total = (await emit([])).total
  }
  done.add(si)
  await checkpoint({ done: [...done] })
}
return "rows: " + (await emit([])).total
`
}
