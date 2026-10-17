import type { ActivityEntry } from "@kitestring/protocol"

/** chrome.tabGroups color names. */
export type GroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange"

export interface UiSession {
  name: string
  color: GroupColor
  tabCount: number
  lastActivity?: ActivityEntry
}

export interface UiState {
  hostConnected: boolean
  paused: boolean
  /** Why the user paused, when they said. */
  reason?: string
  /** Epoch ms of the last pause/resume. */
  since?: number
  sessions: UiSession[]
}

/** Messages the popup and side panel send the background over chrome.runtime.sendMessage. */
export type UiRequest =
  | { kite: "ui"; op: "state" }
  | { kite: "ui"; op: "pause"; reason?: string }
  | { kite: "ui"; op: "resume" }
  | { kite: "ui"; op: "focusTab"; session: string }
  | { kite: "ui"; op: "openPanel"; windowId?: number }

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
      return { kite: "ui", op: r.op }
    case "pause": {
      if (r.reason !== undefined && typeof r.reason !== "string") return null
      const reason = typeof r.reason === "string" ? r.reason.trim().slice(0, REASON_MAX) : ""
      return reason ? { kite: "ui", op: "pause", reason } : { kite: "ui", op: "pause" }
    }
    case "focusTab":
      return typeof r.session === "string" && r.session ? { kite: "ui", op: "focusTab", session: r.session } : null
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
