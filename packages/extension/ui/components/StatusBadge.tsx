import type { ActivityEntry } from "@kitestring/protocol"
import { CheckIcon, CrossIcon } from "./icons"

/** The outcome of one recorded action: a check for `done`, otherwise a cross and the status or error code. */
export function StatusBadge({ status }: { status: ActivityEntry["status"] }) {
  const ok = status === "done"
  return (
    <span className={`ks-badge ${ok ? "ks-badge--ok" : "ks-badge--fail"}`}>
      {ok ? <CheckIcon /> : <CrossIcon />}
      {ok ? "done" : status}
    </span>
  )
}
