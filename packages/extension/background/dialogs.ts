import type { DialogEvent } from "@kitestring/protocol"
import { onAttach, onEvent, send } from "./cdp"

export type DialogPolicy = "accept" | "dismiss"

export interface DialogWatch {
  events: DialogEvent[]
  stop(): void
}

type DialogType = DialogEvent["type"]

/** Tabs with a running DialogWatch (count, since runs on one tab may overlap while one unwinds). */
const watching = new Map<number, number>()

/** Global rule for `alert` (accept) and `beforeunload` (accept only while navigating); `policy` covers confirm/prompt. */
function shouldAccept(type: DialogType, policy: DialogPolicy | undefined, navigating: boolean): boolean {
  if (type === "alert") return true
  if (type === "beforeunload") return navigating
  return policy === "accept"
}

function answer(tabId: number, params: Record<string, unknown>, navigating: boolean, policy?: DialogPolicy): DialogEvent {
  const type = params.type as DialogType
  const accept = shouldAccept(type, policy, navigating)
  const reply: Record<string, unknown> = { accept }
  if (accept && type === "prompt") reply.promptText = ""
  void send(tabId, "Page.handleJavaScriptDialog", reply).catch(() => {})
  return { type, message: String(params.message ?? ""), handled: accept ? "accepted" : "dismissed" }
}

/**
 * Answers JS dialogs on the tab until stopped and records each one. A dialog blocks the page (and
 * input commands) until answered, so this must run while an action is in flight.
 */
export function watchDialogs(tabId: number, opts: { policy?: DialogPolicy; navigating?: () => boolean } = {}): DialogWatch {
  const events: DialogEvent[] = []
  watching.set(tabId, (watching.get(tabId) ?? 0) + 1)
  const off = onEvent(tabId, ({ method, params }) => {
    if (method !== "Page.javascriptDialogOpening") return
    events.push(answer(tabId, params, opts.navigating?.() ?? false, opts.policy))
  })
  let stopped = false
  return {
    events,
    stop() {
      if (stopped) return
      stopped = true
      off()
      const n = (watching.get(tabId) ?? 1) - 1
      if (n <= 0) watching.delete(tabId)
      else watching.set(tabId, n)
    },
  }
}

/**
 * Background-wide fallback so a dialog never wedges a tab between actions: alerts accepted,
 * everything else dismissed. Tabs with an active DialogWatch are skipped (that watch answers).
 * `onAnswered` hears each dialog this guard answered (for the activity log).
 */
export function installDialogGuard(onAnswered?: (tabId: number, dialog: DialogEvent) => void): void {
  /** One subscription per tab: onAttach runs on every (re-)attach. */
  const guards = new Map<number, () => void>()
  onAttach((tabId) => {
    guards.get(tabId)?.()
    const off = onEvent(tabId, ({ method, params }) => {
      if (method !== "Page.javascriptDialogOpening" || watching.has(tabId)) return
      const d = answer(tabId, params, false)
      onAnswered?.(tabId, d)
    })
    guards.set(tabId, off)
  })
}
