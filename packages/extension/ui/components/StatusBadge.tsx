import type { ActivityEntry } from "@kitestring/protocol"
import { statusTone } from "../activity-format"
import { CheckIcon, CrossIcon, PauseIcon } from "./icons"

/** What each status means, for the badge's tooltip. */
const HINTS: Record<string, string> = {
  done: "The action happened",
  not_found: "Nothing on the page matched",
  ambiguous: "More than one element matched",
  blocked: "Something covered the element",
  disabled: "The element was disabled",
  no_effect: "The action ran but nothing changed",
  timeout: "The page did not settle in time",
  restricted: "Chrome does not let extensions act on this page",
  error: "The action failed",
  PAUSED: "Agents were paused",
  NOT_OWNER: "The tab belongs to another session",
  NO_TAB: "The session had no tab",
  NOT_CONNECTED: "The browser was not connected",
  RESTRICTED: "Chrome does not let extensions act on this page",
  BAD_REQUEST: "The request was malformed",
  INTERNAL: "Kitestring hit an internal error",
  TIMEOUT: "The browser did not answer in time",
}

/**
 * The outcome of one recorded action: a check for `done`, a pause glyph for `PAUSED`, otherwise a
 * cross and the status or error code. `quiet` (the feed) says nothing visible for `done`, the normal
 * case, so problems stand out; the status is still read out.
 */
export function StatusBadge({ status, quiet = false }: { status: ActivityEntry["status"]; quiet?: boolean }) {
  const tone = statusTone(status)
  if (quiet && tone === "ok") {
    return (
      <span className="ks-badge ks-visually-hidden" data-status={status}>
        {status}
      </span>
    )
  }
  return (
    <span className={`ks-badge ks-badge--${tone}`} title={HINTS[status]} data-status={status}>
      {tone === "ok" ? <CheckIcon /> : tone === "paused" ? <PauseIcon size={12} /> : <CrossIcon />}
      {status}
    </span>
  )
}
