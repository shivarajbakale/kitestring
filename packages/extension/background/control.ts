import { ErrorCode, type ControlState } from "@kitestring/protocol"
import { RpcError } from "./errors"

/** chrome.storage.session key holding the ControlState (read by the popup and side panel). */
export const CONTROL_KEY = "control"
export const PAUSED_MESSAGE = "Kitestring is paused by the user"

let state: ControlState = { paused: false }
const listeners = new Set<(s: ControlState) => void>()
let loaded: Promise<void> | null = null

function apply(next: ControlState): void {
  const flipped = next.paused !== state.paused
  state = next
  if (flipped) for (const cb of listeners) cb(state)
}

/** Loads the persisted state once (service-worker restart) and follows writes by other extension pages. */
export function ready(): Promise<void> {
  loaded ??= (async () => {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "session" || !(CONTROL_KEY in changes)) return
      const next = changes[CONTROL_KEY]!.newValue as ControlState | undefined
      // Our own writes echo back here, possibly after a newer one: only strictly newer states win.
      if (next && (next.since ?? 0) > (state.since ?? 0)) apply(next)
    })
    const stored = (await chrome.storage.session.get(CONTROL_KEY))[CONTROL_KEY] as ControlState | undefined
    if (stored && (stored.since ?? 0) >= (state.since ?? 0)) apply(stored)
  })().catch((e: unknown) => {
    loaded = null
    throw e
  })
  return loaded
}

export function isPaused(): boolean {
  return state.paused
}

export function getState(): ControlState {
  return { ...state }
}

/** Monotonic per call, so two changes in the same millisecond still order correctly. */
function stamp(): number {
  return Math.max(Date.now(), (state.since ?? 0) + 1)
}

export async function pause(reason?: string): Promise<void> {
  apply({ paused: true, ...(reason ? { reason } : {}), since: stamp() })
  await chrome.storage.session.set({ [CONTROL_KEY]: state })
}

export async function resume(): Promise<void> {
  apply({ paused: false, since: stamp() })
  await chrome.storage.session.set({ [CONTROL_KEY]: state })
}

/** Called with the new state whenever paused flips. Returns an unsubscribe function. */
export function onChange(cb: (s: ControlState) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function pausedError(): RpcError {
  return new RpcError(ErrorCode.PAUSED, `PAUSED: ${PAUSED_MESSAGE}${state.reason ? ` (${state.reason})` : ""}`)
}

export function assertNotPaused(): void {
  if (state.paused) throw pausedError()
}
