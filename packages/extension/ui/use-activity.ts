import type { ActivityEntry } from "@kitestring/protocol"
import { useEffect, useState } from "react"

/** chrome.storage.session key the background keeps the log under, oldest first (background/activity.ts). */
const KEY = "activity"

function newestFirst(v: unknown): ActivityEntry[] {
  if (!Array.isArray(v)) return []
  return v.filter((e): e is ActivityEntry => !!e && typeof e === "object" && typeof (e as ActivityEntry).id === "number").reverse()
}

/** The activity log, newest first: read once, then followed through chrome.storage.onChanged. */
export function useActivity() {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    // A change can land before the initial read answers; it is the newer of the two.
    let changed = false
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "session" || !(KEY in changes)) return
      changed = true
      setEntries(newestFirst(changes[KEY].newValue))
    }
    chrome.storage.onChanged.addListener(onChanged)
    chrome.storage.session.get(KEY).then(
      (r) => {
        if (live && !changed) setEntries(newestFirst(r[KEY]))
      },
      (e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e))
      },
    )
    return () => {
      live = false
      chrome.storage.onChanged.removeListener(onChanged)
    }
  }, [])

  return { entries, error }
}
