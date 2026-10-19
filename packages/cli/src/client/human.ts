import type { ActionResult, ActivityEntry, BatchResult, ConsoleEntry, HandoffResult, Method, NetworkEntry } from "@kitestring/protocol"
import { formatActivity, formatCacheClear, formatCacheStats, formatBatch, formatConsole, formatNetwork, formatResult } from "./format.js"

/** The text `kite` prints for a result; the MCP tools return the same text. */
export function human(method: Method, result: unknown): string {
  const r = result as any
  switch (method) {
    case "page.snapshot":
      return String(r?.text ?? "")
    case "page.console":
      return formatConsole((r?.entries ?? []) as ConsoleEntry[])
    case "page.network":
      return formatNetwork((r?.entries ?? []) as NetworkEntry[])
    case "tab.new":
    case "tab.use":
    case "tab.close":
      return r && r.id !== undefined ? `tab ${r.id} ${r.url ?? ""}`.trimEnd() : "ok"
    case "tab.list": {
      const tabs: any[] = Array.isArray(r) ? r : (r?.tabs ?? [])
      return tabs.map((t) => `tab ${t.id} ${t.url ?? ""}${t.active ? "  (active)" : ""}`.trimEnd()).join("\n")
    }
    case "status":
      return typeof r === "string" ? r : JSON.stringify(r, null, 2)
    case "control.pause":
      return "paused — agents get PAUSED until `kite resume`"
    case "control.resume":
      return "resumed"
    case "activity.list":
      return formatActivity((r?.entries ?? []) as ActivityEntry[])
    case "cache.stats":
      return formatCacheStats(r)
    case "cache.clear":
      return formatCacheClear(r)
    case "act.batch":
      return formatBatch(r as BatchResult)
    case "human.ask":
      return formatHandoff(r as HandoffResult)
    default:
      return r && typeof r === "object" && "status" in r ? formatResult(r as ActionResult) : JSON.stringify(r)
  }
}

function formatHandoff(h: HandoffResult): string {
  if (h.status === "done") return `done: the user finished "${h.reason}". Take a snapshot to see the page now.`
  if (h.status === "declined") return `declined: the user could not do "${h.reason}". Stop and tell them what is blocked.`
  return `waiting: the user has not finished "${h.reason}" yet. Ask again with the same reason to keep waiting.`
}
