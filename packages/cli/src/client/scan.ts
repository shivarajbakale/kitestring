/** An array in some JSON that holds the page's records: where it is, how big, and how many visible values it holds. */
export interface RecordArray {
  /** `props.pageProps.items`, `[0][1]`: a dot path from the JSON's root. */
  path: string
  count: number
  /** Keys of its items (indexes when the items are arrays). */
  keys: string[]
  /** How many of the needles appear inside it. */
  hits: number
  /** Its first item as JSON, cut short. */
  sample: string
}

/**
 * Arrays of records (objects, or arrays as in some APIs) inside `root`, ranked by how many `needles` (visible values) they
 * contain, then by size. Self-contained, with no closure over anything outside it: its source also runs in the page
 * (`page.eval`), where it scans embedded state.
 */
export function findRecordArrays(root: unknown, needles: string[], max = 5): RecordArray[] {
  const folded = needles.map((n) => n.toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean)
  const found: RecordArray[] = []
  let nodes = 0
  const LIMIT_NODES = 200_000
  const textOf = (v: unknown): string => {
    try {
      const t = JSON.stringify(v) ?? ""
      return t.length > 3_000_000 ? t.slice(0, 3_000_000) : t
    } catch {
      return ""
    }
  }
  const unescape = (t: string): string => t.toLowerCase().replace(/\\u0026/g, "&").replace(/\\"/g, '"').replace(/\s+/g, " ")
  const walk = (v: unknown, path: string, depth: number): void => {
    if (nodes++ > LIMIT_NODES || depth > 14 || v === null || typeof v !== "object") return
    if (Array.isArray(v)) {
      const recs = v.filter((x) => x !== null && typeof x === "object")
      if (v.length >= 2 && recs.length >= Math.max(2, v.length * 0.6)) {
        const text = unescape(textOf(v))
        const hits = folded.filter((n) => text.includes(n)).length
        const keys: string[] = []
        for (const it of recs.slice(0, 3)) for (const k of Object.keys(it as object)) if (!keys.includes(k) && keys.length < 25) keys.push(k)
        const first = textOf(recs[0])
        found.push({ path, count: v.length, keys, hits, sample: first.length > 600 ? `${first.slice(0, 599)}…` : first })
      }
      v.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1))
      return
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, path ? `${path}.${k}` : k, depth + 1)
  }
  walk(root, "", 0)
  // Of an array and one inside it (or around it) holding no more of the needles, keep the first ranked: the list,
  // not each item's own little lists, nor the wrapper around the list.
  const ranked = found
    .filter((a) => folded.length === 0 || a.hits > 0)
    // Equal hits: the deeper array is the list itself, the shallower a wrapper around it (`[meta, [records…]]`).
    .sort((a, b) => b.hits - a.hits || depth(b.path) - depth(a.path) || b.count - a.count)
  function depth(p: string): number {
    return (p.match(/[.[]/g) ?? []).length + (p ? 1 : 0)
  }
  const within = (inner: string, outer: string) => inner.length > outer.length && inner.startsWith(outer) && /^[[.]/.test(inner.slice(outer.length))
  const out: RecordArray[] = []
  for (const a of ranked) {
    if (out.some((o) => (within(a.path, o.path) || within(o.path, a.path)) && o.hits >= a.hits)) continue
    out.push(a)
    if (out.length >= max) break
  }
  return out.map((a) => (a.path ? a : { ...a, path: "(root)" }))
}

/** JSON text as a value: strips an anti-hijacking prefix (`)]}'`, `for(;;);`, `while(1);`); undefined when not JSON. */
export function parseJsonText(text: string): unknown {
  const t = text.replace(/^﻿/, "").replace(/^\s*(\)\]\}'[^\n]*\n?|for\s*\(;;\);|while\s*\(1\);)/, "").trim()
  if (!t || !/^[[{"]/.test(t)) return undefined
  try {
    return JSON.parse(t)
  } catch {
    // Some APIs send several JSON values, one per line: an array of them.
    const lines = t.split("\n").filter((l) => /^\s*[[{]/.test(l))
    if (lines.length < 2) return undefined
    try {
      return lines.map((l) => JSON.parse(l))
    } catch {
      return undefined
    }
  }
}

/**
 * Runs in the page: embedded data an app renders from (JSON-LD, `<script type="application/json">` such as
 * __NEXT_DATA__, and state globals such as window.__INITIAL_STATE__), each scanned with findRecordArrays.
 * Self-contained: its source is sent with page.eval, with findRecordArrays' source passed in.
 */
export function scanEmbedded(needles: string[], finderSource: string): { source: string; arrays: RecordArray[] }[] {
  const find = new Function(`return (${finderSource})`)() as typeof findRecordArrays
  const out: { source: string; arrays: RecordArray[] }[] = []
  const add = (source: string, value: unknown) => {
    if (value === null || typeof value !== "object") return
    const arrays = find(value, needles, 3)
    if (arrays.length) out.push({ source, arrays })
  }
  const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"],script[type="application/json"]'))
  const ld: unknown[] = []
  for (const s of scripts.slice(0, 40)) {
    const text = s.textContent ?? ""
    if (text.length > 5_000_000) continue
    let v: unknown
    try {
      v = JSON.parse(text)
    } catch {
      continue
    }
    if (s.getAttribute("type") === "application/ld+json") ld.push(v)
    else add(s.id ? `script#${s.id}` : "script[type=application/json]", v)
  }
  if (ld.length) add("json-ld", ld)
  const w = window as unknown as Record<string, unknown>
  for (const k of Object.keys(w)) {
    if (!/^(__[A-Z0-9_]+__?|__\w*(state|data|props|store|apollo)\w*|\w*(INITIAL|PRELOADED|APOLLO|NUXT|REDUX)\w*)$/i.test(k)) continue
    let v: unknown
    try {
      v = w[k]
    } catch {
      continue
    }
    if (typeof v === "function" || v === window || (typeof Node !== "undefined" && v instanceof Node)) continue
    try {
      // Only plain data: a global holding DOM nodes or class instances is an app object, not state.
      v = JSON.parse(JSON.stringify(v) ?? "null")
    } catch {
      continue
    }
    add(`window.${k}`, v)
  }
  return out
    .sort((a, b) => (b.arrays[0]?.hits ?? 0) - (a.arrays[0]?.hits ?? 0))
    .slice(0, 5)
}

/** The value at a path as findRecordArrays writes it (`data.items`, `[0][1]`, `(root)`); undefined when absent. */
export function atPath(root: unknown, path: string): unknown {
  if (!path || path === "(root)" || path === ".") return root
  let v: unknown = root
  for (const m of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    if (v === null || typeof v !== "object") return undefined
    v = m[2] !== undefined ? (v as unknown[])[Number(m[2])] : (v as Record<string, unknown>)[m[1]!]
  }
  return v
}
