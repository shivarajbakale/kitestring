import { useState } from "react"
import type { UiHandoff } from "../messages"
import { ChevronIcon } from "./icons"
import { Elapsed } from "./RelativeTime"

interface Props {
  handoffs: UiHandoff[]
  onShow: (h: UiHandoff) => void
  /** Resolves null (or undefined) when the answer was not applied. */
  onAnswer: (h: UiHandoff, outcome: "done" | "declined") => Promise<unknown>
}

/**
 * Agents waiting on the person: the most urgent thing on screen, so it sits first and is the only place
 * the accent fills a button. The request reads as the headline; who asked and how long they have waited
 * sit above it.
 */
export function HandoffList({ handoffs, onShow, onAnswer }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  if (!handoffs.length) return null

  const answer = async (h: UiHandoff, outcome: "done" | "declined") => {
    setBusy(h.session)
    try {
      await onAnswer(h, outcome)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="ks-handoffs" aria-label="Agents waiting for you">
      {handoffs.map((h) => (
        <article key={h.session} className="ks-handoff" role="status">
          <p className="ks-handoff__who">
            <span className="ks-handoff__beacon" aria-hidden="true" />
            <span className="ks-handoff__name">
              <strong>{h.session}</strong> is waiting for you
            </span>
            <Elapsed ts={h.since} />
          </p>
          <p className="ks-handoff__reason">{h.reason}</p>
          <div className="ks-handoff__actions">
            <button type="button" className="ks-btn ks-btn--accent" disabled={busy === h.session} onClick={() => void answer(h, "done")}>
              Done
            </button>
            <button type="button" className="ks-btn ks-btn--quiet" disabled={busy === h.session} onClick={() => void answer(h, "declined")}>
              Can’t do it
            </button>
          </div>
          {h.tabId !== null ? (
            <button type="button" className="ks-link ks-handoff__show" onClick={() => onShow(h)}>
              Show tab
              <ChevronIcon size={12} />
            </button>
          ) : null}
        </article>
      ))}
    </section>
  )
}
