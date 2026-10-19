import { useCallback, useEffect, useState } from "react"
import { uiCall, type UiRequest, type UiState } from "./messages"

const POLL_MS = 2000
/** chrome.storage.session keys the background writes when sessions, pause state, requests or the activity log change. */
const WATCHED = ["control", "activity", "kite.sessions", "kite.recording", "kite.handoff"]

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Live Kitestring state for extension pages: refetched on every relevant storage change, and polled
 * for what storage doesn't carry (the native host connection).
 */
export function useStatus() {
  const [state, setState] = useState<UiState | null>(null)
  /** The background can't be reached (state fetch failed). */
  const [error, setError] = useState<string | null>(null)
  /** The last pause/resume/focus/open action failed. */
  const [actionError, setActionError] = useState<string | null>(null)

  const refresh = useCallback(
    () =>
      uiCall({ op: "state" }).then(
        (s) => {
          setState(s)
          setError(null)
          return s
        },
        (e: unknown) => {
          setError(message(e))
          return null
        },
      ),
    [],
  )

  useEffect(() => {
    void refresh()
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "session" && WATCHED.some((k) => k in changes)) void refresh()
    }
    chrome.storage.onChanged.addListener(onChanged)
    const id = setInterval(() => void refresh(), POLL_MS)
    return () => {
      chrome.storage.onChanged.removeListener(onChanged)
      clearInterval(id)
    }
  }, [refresh])

  type Op = Exclude<UiRequest["op"], "state">
  const act = useCallback(
    <T extends Op>(req: Omit<Extract<UiRequest, { op: T }>, "kite"> & { op: T }) =>
      uiCall<T>(req).then(
        (s) => {
          setState(s)
          setActionError(null)
          return s
        },
        (e: unknown) => {
          setActionError(message(e))
          return null
        },
      ),
    [],
  )

  return { state, error, actionError, refresh, act }
}
