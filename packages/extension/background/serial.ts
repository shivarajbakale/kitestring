import { assertNotRecorded } from "./recorder"

/**
 * Per-tab FIFO lock: actions on one tab never interleave their input. Holders always run to the
 * end; queued waiters can leave early (their own cap expired, or the user paused).
 */

interface Waiter {
  resolve: () => void
  reject: (e: unknown) => void
}

interface Lane {
  queue: Waiter[]
}

/** A tab is locked while it has a lane; the lane is deleted when the last holder releases. */
const lanes = new Map<number, Lane>()

function acquire(tabId: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  const lane = lanes.get(tabId)
  if (!lane) {
    lanes.set(tabId, { queue: [] })
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      const i = lane.queue.indexOf(w)
      if (i < 0) return // already handed the lock
      lane.queue.splice(i, 1)
      reject(signal!.reason)
    }
    const w: Waiter = {
      resolve: () => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      },
      reject: (e) => {
        signal?.removeEventListener("abort", onAbort)
        reject(e)
      },
    }
    lane.queue.push(w)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function release(tabId: number): void {
  const lane = lanes.get(tabId)
  if (!lane) return
  const next = lane.queue.shift()
  if (next) next.resolve() // hand off: the lane stays locked
  else lanes.delete(tabId)
}

export interface TabLock {
  /** Hands the lock on now, before `fn` settles. Idempotent; `fn` settling releases it too. */
  release(): void
}

/**
 * Runs `fn` once every earlier caller for `tabId` has finished. `signal` abandons the wait (not a
 * running `fn`). `fn` gets a handle to release early, e.g. when it is past its cap but stuck.
 * Every agent action takes this lock, so it is where a tab the user is recording is refused
 * (`TabRecordedError`, whichever way the action reached the tab).
 */
export async function withTabLock<T>(
  tabId: number,
  fn: (lock: TabLock) => Promise<T>,
  opts: { signal?: AbortSignal } = {},
): Promise<T> {
  await acquire(tabId, opts.signal)
  let held = true
  const lock: TabLock = {
    release: () => {
      if (!held) return
      held = false
      release(tabId)
    },
  }
  try {
    assertNotRecorded(tabId)
    return await fn(lock)
  } finally {
    lock.release()
  }
}

/** Rejects every queued waiter on every tab with `reason`; current holders keep running. */
export function rejectWaiters(reason: unknown): void {
  for (const lane of lanes.values()) {
    for (const w of lane.queue.splice(0)) w.reject(reason)
  }
}
