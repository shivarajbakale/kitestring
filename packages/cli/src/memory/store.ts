import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { slug, type Plan } from "@kitestring/protocol"

/** Minimum Jaccard overlap of intent word sets for a stored plan to match. */
export const MATCH_THRESHOLD = 0.6

const STOPWORDS = new Set(
  "a an and the to of for on in at by with from into my me i it is be do this that please then so just can you your our we".split(" "),
)
const SAFE = /^[a-z0-9][a-z0-9_-]*$/

const memoryDir = (home: string): string => join(home, "memory")

/** Directory name for an origin: "https://localhost:3000" -> "localhost-3000". */
export function originSlug(origin: string): string {
  let host = origin
  try {
    host = new URL(origin).host
  } catch {
    /* use the raw text */
  }
  return slug(host, "site")
}

function words(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) if (w && !STOPWORDS.has(w)) out.add(w)
  return out
}

/** Jaccard overlap of the normalized word sets of two intents (0 when either is empty). */
export function intentScore(a: string, b: string): number {
  const x = words(a)
  const y = words(b)
  if (!x.size || !y.size) return 0
  let inter = 0
  for (const w of x) if (y.has(w)) inter++
  return inter / (x.size + y.size - inter)
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700) // mkdir's mode is masked by umask and ignored for existing dirs
}

/** Writes the plan to `<home>/memory/<origin-slug>/<plan-slug>.json` (replacing a plan with the same slug). Returns the path. */
export function savePlan(home: string, plan: Plan): string {
  const dir = join(memoryDir(home), originSlug(plan.origin))
  ensureDir(memoryDir(home))
  ensureDir(dir)
  const file = join(dir, `${slug(plan.intent)}.json`)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(plan, null, 2) + "\n", { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
  return file
}

interface Stored {
  plan: Plan
  /** `<origin-slug>/<plan-slug>` */
  id: string
}

function readAll(home: string, origin?: string): Stored[] {
  const root = memoryDir(home)
  if (!existsSync(root)) return []
  const dirs = origin ? [originSlug(origin)] : readdirSync(root).filter((d) => !d.startsWith("."))
  const out: Stored[] = []
  for (const d of dirs) {
    let files: string[]
    try {
      files = readdirSync(join(root, d))
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue
      try {
        const p = JSON.parse(readFileSync(join(root, d, f), "utf8")) as Plan
        if (p.version !== 1 || typeof p.intent !== "string" || typeof p.origin !== "string" || !Array.isArray(p.batches)) continue
        if (origin && p.origin !== origin) continue
        out.push({ plan: p, id: `${d}/${f.slice(0, -5)}` })
      } catch {
        /* unreadable or corrupt: ignore */
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** All stored plans, optionally only those of one origin (e.g. "https://example.com"). */
export function loadPlans(home: string, origin?: string): Plan[] {
  return readAll(home, origin).map((s) => s.plan)
}

/** Best plan for `origin` whose intent overlaps `intent` by >= 0.6 (Jaccard); the first listed wins ties. */
export function findPlan(home: string, origin: string, intent: string): { plan: Plan; score: number; slug: string } | undefined {
  let best: { plan: Plan; score: number; slug: string } | undefined
  for (const s of readAll(home, origin)) {
    const score = intentScore(intent, s.plan.intent)
    if (score >= MATCH_THRESHOLD && (!best || score > best.score)) best = { plan: s.plan, score, slug: s.id.split("/")[1]! }
  }
  return best
}

/**
 * Deletes a plan by `<plan-slug>` or `<origin-slug>/<plan-slug>`. False when none matches;
 * throws when a bare slug exists under several origins.
 */
export function forgetPlan(home: string, slugOrId: string): boolean {
  const parts = slugOrId.split("/")
  if (parts.length > 2 || !parts.every((p) => SAFE.test(p))) return false
  const matches = readAll(home).filter((s) => (parts.length === 2 ? s.id === slugOrId : s.id.endsWith(`/${slugOrId}`)))
  if (!matches.length) return false
  if (matches.length > 1) throw new Error(`ambiguous plan slug ${slugOrId}: use one of ${matches.map((m) => m.id).join(", ")}`)
  rmSync(join(memoryDir(home), `${matches[0]!.id}.json`))
  return true
}
