import type { ActivityEntry } from "@kitestring/protocol"

/** `example.com/a` from `https://example.com/a`; a bare origin loses its trailing slash. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/^([^/]+)\/$/, "$1")
}

/**
 * `click "Pay now"`, `goto example.com`, `tab.new 127.0.0.1:5173/serial`: the action without the
 * `act.` namespace or URL scheme.
 */
export function describeAction(e: Pick<ActivityEntry, "method" | "target">): string {
  const method = e.method === "page.goto" ? "goto" : e.method.replace(/^act\./, "")
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
