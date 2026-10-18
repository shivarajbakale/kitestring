import type { ActivityEntry } from "@kitestring/protocol"
import { useId, useState } from "react"
import { BATCH_COLLAPSE_OVER, clockTime, describeAction, duration, groupBatches, summaryDetail } from "../activity-format"
import type { GroupColor } from "../messages"
import { ChevronIcon } from "./icons"
import { SessionDot } from "./SessionDot"
import { StatusBadge } from "./StatusBadge"

interface RowProps {
  entry: ActivityEntry
  color: GroupColor
  /** Arrived while the panel was open: highlighted once. */
  fresh: boolean
  onFocus: (entry: ActivityEntry) => void
}

const hasDiff = (e: ActivityEntry) => !!e.diff
const hasDetails = (e: ActivityEntry) => !!e.url || hasDiff(e) || !!e.page

/**
 * Everything here originates from web pages or agents (targets, summaries, URLs, diff lines, the page
 * brief): it is rendered as React text only, never as HTML.
 */
function Details({ entry, id }: { entry: ActivityEntry; id: string }) {
  const { diff } = entry
  return (
    <div className="ks-entry__details" id={id}>
      {entry.url ? (
        <p className="ks-entry__url">
          <span className="ks-entry__label">Page</span>
          <span className="ks-entry__url-text">{entry.url}</span>
        </p>
      ) : null}
      {diff ? (
        <section className="ks-diff" aria-label="Changes">
          <h3 className="ks-entry__label">Changes</h3>
          {diff.added.length || diff.removed.length ? (
            <ul className="ks-diff__lines">
              {diff.removed.map((l, i) => (
                <li key={`r${i}`} className="ks-diff__line" data-kind="removed">
                  <span className="ks-diff__sign" aria-hidden="true">−</span>
                  <span className="ks-visually-hidden">Removed: </span>
                  <span>{l}</span>
                </li>
              ))}
              {diff.added.map((l, i) => (
                <li key={`a${i}`} className="ks-diff__line" data-kind="added">
                  <span className="ks-diff__sign" aria-hidden="true">+</span>
                  <span className="ks-visually-hidden">Added: </span>
                  <span>{l}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ks-entry__none">Nothing on the page changed.</p>
          )}
        </section>
      ) : null}
      {entry.page ? (
        <section className="ks-brief" aria-label="Page brief">
          <h3 className="ks-entry__label">Page brief</h3>
          <pre className="ks-brief__text">{entry.page}</pre>
        </section>
      ) : null}
    </div>
  )
}

export function ActivityRow({ entry, color, fresh, onFocus }: RowProps) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const detail = summaryDetail(entry)
  const action = describeAction(entry)
  const changed = !!(detail.added || detail.removed)
  return (
    <li className="ks-entry" data-fresh={fresh || undefined} data-open={open || undefined}>
      <button type="button" className="ks-entry__main" title="Show this tab" onClick={() => onFocus(entry)}>
        <span className="ks-entry__meta">
          <SessionDot color={color} />
          <span className="ks-entry__session">{entry.session}</span>
          <span className="ks-entry__nums">
            <span className="ks-entry__ms">{duration(entry.ms)}</span>
            <time dateTime={new Date(entry.ts).toISOString()} title={new Date(entry.ts).toLocaleString()}>
              {clockTime(entry.ts)}
            </time>
          </span>
        </span>
        <span className="ks-entry__line">
          <span className="ks-entry__action" title={action}>
            {action}
          </span>
          <StatusBadge status={entry.status} />
        </span>
        {detail.text || changed ? (
          <span className="ks-entry__summary">
            {detail.text ? (
              <span className="ks-entry__summary-text" title={detail.text}>
                {detail.text}
              </span>
            ) : null}
            {changed ? (
              <span className="ks-stat" title={`${detail.added} added, ${detail.removed} removed`}>
                <span className="ks-visually-hidden">Lines changed: </span>
                {detail.added ? <span data-kind="added">+{detail.added}</span> : null}
                {detail.removed ? <span data-kind="removed">−{detail.removed}</span> : null}
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
      {hasDetails(entry) ? (
        <button
          type="button"
          className="ks-entry__toggle"
          aria-expanded={open}
          aria-controls={open ? detailsId : undefined}
          aria-label={open ? "Hide details" : "Show details"}
          title={open ? "Hide details" : "Show details"}
          onClick={() => setOpen(!open)}>
          <ChevronIcon size={14} />
        </button>
      ) : null}
      {open ? <Details entry={entry} id={detailsId} /> : null}
    </li>
  )
}

interface FeedProps {
  entries: ActivityEntry[]
  colorOf: (session: string) => GroupColor
  /** Entries with a larger id arrived after the panel opened. */
  freshAfter: number
  onFocus: (entry: ActivityEntry) => void
}

function BatchGroup({
  steps,
  colorOf,
  freshAfter,
  onFocus,
}: {
  steps: ActivityEntry[]
  colorOf: (session: string) => GroupColor
  freshAfter: number
  onFocus: (entry: ActivityEntry) => void
}) {
  // Steps arrive one by one: the default follows the current count until the user picks.
  const [chosen, setChosen] = useState<boolean | null>(null)
  const open = chosen ?? steps.length <= BATCH_COLLAPSE_OVER
  const listId = useId()
  const label = `batch · ${steps.length} ${steps.length === 1 ? "step" : "steps"}`
  const first = steps[0]!
  return (
    <li className="ks-batch" data-open={open || undefined}>
      <button type="button" className="ks-batch__head" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => setChosen(!open)}>
        <ChevronIcon size={14} />
        <span className="ks-batch__label">{label}</span>
        <span className="ks-batch__session">{first.session}</span>
        <StatusBadge status={steps[steps.length - 1]!.status} />
      </button>
      {open ? (
        <ol className="ks-batch__steps" id={listId} aria-label={label}>
          {steps.map((e) => (
            <ActivityRow key={e.id} entry={e} color={colorOf(e.session)} fresh={e.id > freshAfter} onFocus={onFocus} />
          ))}
        </ol>
      ) : null}
    </li>
  )
}

export function ActivityFeed({ entries, colorOf, freshAfter, onFocus }: FeedProps) {
  return (
    <ol className="ks-feed" aria-label="Activity">
      {groupBatches(entries).map((it) =>
        it.kind === "entry" ? (
          <ActivityRow key={it.entry.id} entry={it.entry} color={colorOf(it.entry.session)} fresh={it.entry.id > freshAfter} onFocus={onFocus} />
        ) : (
          <BatchGroup key={`b${it.id}`} steps={it.steps} colorOf={colorOf} freshAfter={freshAfter} onFocus={onFocus} />
        ),
      )}
    </ol>
  )
}
