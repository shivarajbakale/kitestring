import type { ActivityEntry } from "@kitestring/protocol"

/** chrome.tabGroups color names. */
export type GroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange"

export interface UiSession {
  name: string
  color: GroupColor
  tabCount: number
  lastActivity?: ActivityEntry
}

/** An agent waiting for the person to do something only they can (captcha, 2FA, login). */
export interface UiHandoff {
  session: string
  reason: string
  since: number
  tabId: number | null
}

export interface UiState {
  hostConnected: boolean
  paused: boolean
  /** Why the user paused, when they said. */
  reason?: string
  /** Epoch ms of the last pause/resume. */
  since?: number
  sessions: UiSession[]
  /** A recording in progress (`active`), or stopped from the panel and waiting for `kite record stop`. */
  recording?: { name: string; active: boolean }
  /** Agents waiting on the person, oldest first. */
  handoffs: UiHandoff[]
}

/** Messages the popup and side panel send the background over chrome.runtime.sendMessage. */
export type UiRequest =
  | { kite: "ui"; op: "state" }
  | { kite: "ui"; op: "pause"; reason?: string }
  | { kite: "ui"; op: "resume" }
  /** Brings a tab to the front: `tabId` when given and still open, else the session's active tab. */
  | { kite: "ui"; op: "focusTab"; session: string; tabId?: number }
  | { kite: "ui"; op: "openPanel"; windowId?: number }
  /** Stops the recording in progress; `kite record stop` still saves it. */
  | { kite: "ui"; op: "recordStop" }
  /** The person's answer to an agent's request: Done or Can't do it. */
  | { kite: "ui"; op: "handoff"; session: string; outcome: "done" | "declined" }

export type UiResponse = { ok: true; state: UiState } | { ok: false; error: string }

export function isUiRequest(m: unknown): m is UiRequest {
  return !!m && typeof m === "object" && (m as { kite?: unknown }).kite === "ui"
}

export const REASON_MAX = 200

/**
 * Validates a UI request's fields; null when malformed. Reasons are trimmed and capped at REASON_MAX.
 */
export function parseUiRequest(m: unknown): UiRequest | null {
  if (!isUiRequest(m)) return null
  const r = m as unknown as Record<string, unknown>
  switch (r.op) {
    case "state":
    case "resume":
    case "recordStop":
      return { kite: "ui", op: r.op }
    case "pause": {
      if (r.reason !== undefined && typeof r.reason !== "string") return null
      const reason = typeof r.reason === "string" ? r.reason.trim().slice(0, REASON_MAX) : ""
      return reason ? { kite: "ui", op: "pause", reason } : { kite: "ui", op: "pause" }
    }
    case "focusTab": {
      if (typeof r.session !== "string" || !r.session) return null
      if (r.tabId === undefined) return { kite: "ui", op: "focusTab", session: r.session }
      if (!Number.isSafeInteger(r.tabId) || (r.tabId as number) < 0) return null
      return { kite: "ui", op: "focusTab", session: r.session, tabId: r.tabId as number }
    }
    case "handoff":
      if (typeof r.session !== "string" || !r.session) return null
      if (r.outcome !== "done" && r.outcome !== "declined") return null
      return { kite: "ui", op: "handoff", session: r.session, outcome: r.outcome }
    case "openPanel":
      if (r.windowId !== undefined && !Number.isInteger(r.windowId)) return null
      return r.windowId === undefined ? { kite: "ui", op: "openPanel" } : { kite: "ui", op: "openPanel", windowId: r.windowId as number }
    default:
      return null
  }
}

/**
 * Only the extension's own pages (popup, side panel) may drive the UI ops. Content scripts share the
 * extension id but run in web pages: their sender.url is the page's, so they're rejected. A tab check
 * would not do: the popup can be open as a tab.
 */
export function isTrustedUiSender(sender: { id?: string; url?: string }, extensionId: string, extensionOrigin: string): boolean {
  return sender.id === extensionId && typeof sender.url === "string" && sender.url.startsWith(extensionOrigin)
}

type Op<T extends UiRequest["op"]> = Omit<Extract<UiRequest, { op: T }>, "kite">

/** Sends a UI op to the background; every op answers with the fresh state. */
export async function uiCall<T extends UiRequest["op"]>(req: Op<T> & { op: T }): Promise<UiState> {
  const res = (await chrome.runtime.sendMessage({ kite: "ui", ...req })) as UiResponse | undefined
  if (!res) throw new Error("Kitestring's background did not answer")
  if (!res.ok) throw new Error(res.error)
  return res.state
}
