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

type Op<T extends UiRequest["op"]> = Omit<Extract<UiRequest, { op: T }>, "kite">

/** Sends a UI op to the background; every op answers with the fresh state. */
export async function uiCall<T extends UiRequest["op"]>(req: Op<T> & { op: T }): Promise<UiState> {
  const res = (await chrome.runtime.sendMessage({ kite: "ui", ...req })) as UiResponse | undefined
  if (!res) throw new Error("Kitestring's background did not answer")
  if (!res.ok) throw new Error(res.error)
  return res.state
}
