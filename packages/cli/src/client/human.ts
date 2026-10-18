import type { ActionResult, ActivityEntry, ConsoleEntry, Method, NetworkEntry } from "@kitestring/protocol"
import { formatActivity, formatConsole, formatNetwork, formatResult } from "./format.js"

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
    default:
      return r && typeof r === "object" && "status" in r ? formatResult(r as ActionResult) : JSON.stringify(r)
  }
}
