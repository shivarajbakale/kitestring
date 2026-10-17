import type { ActivityEntry } from "@kitestring/protocol"
import type { UiSession } from "../messages"
import { ChevronIcon } from "./icons"
import { RelativeTime } from "./RelativeTime"
import { SessionDot } from "./SessionDot"
import { StatusBadge } from "./StatusBadge"

/** `click "Pay now"`, `tab.new 127.0.0.1:5173/serial`: the action without the `act.` namespace or URL scheme. */
export function describeAction(e: ActivityEntry): string {
  const method = e.method.replace(/^act\./, "")
  const target = e.target?.replace(/^https?:\/\//, "")
  return target ? `${method} ${target}` : method
}

const tabs = (n: number) => (n === 1 ? "1 tab" : `${n} tabs`)

export function SessionRow({ session, onFocus }: { session: UiSession; onFocus: (name: string) => void }) {
  const last = session.lastActivity
  return (
    <li>
      <button
        type="button"
        className="ks-session"
        title={session.tabCount ? `Show ${session.name}’s tab` : undefined}
        disabled={session.tabCount === 0} onClick={() => onFocus(session.name)}>
        <span className="ks-session__head">
          <SessionDot color={session.color} />
          <span className="ks-session__name">{session.name}</span>
          <span className="ks-session__count">{session.tabCount ? tabs(session.tabCount) : "no tabs"}</span>
          <span className="ks-session__go" aria-hidden="true">
            <ChevronIcon size={12} />
          </span>
        </span>
        {last ? (
          <span className="ks-session__last">
            <span className="ks-session__action" title={last.summary}>
              {describeAction(last)}
            </span>
            <StatusBadge status={last.status} />
            <RelativeTime ts={last.ts} />
          </span>
        ) : null}
      </button>
    </li>
  )
}

export function SessionList({ sessions, onFocus }: { sessions: UiSession[]; onFocus: (name: string) => void }) {
  return (
    <ul className="ks-sessions">
      {sessions.map((s) => (
        <SessionRow key={s.name} session={s} onFocus={onFocus} />
      ))}
    </ul>
  )
}
