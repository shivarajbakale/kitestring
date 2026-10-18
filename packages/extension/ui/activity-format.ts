import type { ActivityEntry } from "@kitestring/protocol"

/** `example.com/a` from `https://example.com/a`; a bare origin loses its trailing slash. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/^([^/]+)\/$/, "$1")
}

/**
 * `click "Pay now"`, `goto example.com`, `tab.new 127.0.0.1:5173/serial`, `pause`: the action without
 * the `act.`/`control.` namespace or URL scheme.
 */
export function describeAction(e: Pick<ActivityEntry, "method" | "target">): string {
  const method = e.method === "page.goto" ? "goto" : e.method.replace(/^(act|control)\./, "")
  const target = e.target === undefined ? undefined : shortUrl(e.target)
  return target ? `${method} ${target}` : method
}

export interface SummaryDetail {
  /** What the summary says beyond the status. */
  text: string
  /** Total lines added/removed, when the summary carries them (the entry's diff is capped at 20). */
  added?: number
  removed?: number
}

/**
 * The summary without the `✓ done` / `✗ status:` head the status badge already shows, with its
 * trailing `+N/−M` split off.
 */
export function summaryDetail(e: Pick<ActivityEntry, "method" | "status" | "summary">): SummaryDetail {
  let s = e.summary.trim()
  for (const head of [`✗ ${e.status}:`, `✗ ${e.status}`, `✓ ${e.status}`, "✓", "✗"]) {
    if (s.startsWith(head)) {
      s = s.slice(head.length).trim()
      break
    }
  }
  if (e.method === "tab.new" && /^tab \d+\b/.test(s)) return { text: "" }
  // The action line already says pause/resume: keep only the reason.
  if (e.method === "control.resume" && s === "resumed") return { text: "" }
  if (e.method === "control.pause" && /^paused\b/.test(s)) return { text: s.replace(/^paused:?\s*/, "") }
  const m = /(?:^|\s)\+(\d+)\/−(\d+)$/.exec(s)
  if (!m) return { text: s }
  return { text: s.slice(0, m.index).trim(), added: Number(m[1]), removed: Number(m[2]) }
}

export type StatusTone = "ok" | "paused" | "fail"

export function statusTone(status: ActivityEntry["status"]): StatusTone {
  return status === "done" ? "ok" : status === "PAUSED" ? "paused" : "fail"
}

/** `312 ms`, `1.2 s`, `65 s`. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  const s = ms / 1000
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`
}

const pad = (n: number) => String(n).padStart(2, "0")

/** `09:05:07`, local time. */
export function clockTime(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** A batch with more steps than this starts collapsed in the feed. */
export const BATCH_COLLAPSE_OVER = 5

export type FeedItem =
  | { kind: "entry"; entry: ActivityEntry }
  | { kind: "batch"; id: number; /** Oldest first. */ steps: ActivityEntry[] }

/** Entries newest first -> feed items: consecutive entries with the same `batch` id become one group. */
export function groupBatches(entries: ActivityEntry[]): FeedItem[] {
  const items: FeedItem[] = []
  for (const e of entries) {
    const last = items[items.length - 1]
    if (e.batch === undefined) items.push({ kind: "entry", entry: e })
    else if (last?.kind === "batch" && last.id === e.batch) last.steps.unshift(e)
    else items.push({ kind: "batch", id: e.batch, steps: [e] })
  }
  return items
}
