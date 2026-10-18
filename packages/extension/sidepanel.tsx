import type { ActivityEntry } from "@kitestring/protocol"
import { useMemo, useRef, useState } from "react"
import { ActivityFeed } from "~ui/components/ActivityFeed"
import { ConnectionPill } from "~ui/components/ConnectionPill"
import { Lockup } from "~ui/components/Lockup"
import { PauseControl } from "~ui/components/PauseControl"
import { SessionFilter, type FilterOption } from "~ui/components/SessionFilter"
import type { GroupColor } from "~ui/messages"
import { useActivity } from "~ui/use-activity"
import { useStatus } from "~ui/use-status"
import "~ui/theme.css"
import "~ui/sidepanel.css"

const LOG_LIMIT = 200

/** Live view: every action agents take, newest first, with the pause switch kept in reach. */
function SidePanel() {
  const { state, error, actionError, act } = useStatus()
  const { entries, error: logError } = useActivity()
  const [selected, setSelected] = useState<string | null>(null)

  // Entries already in the log when the panel opened are history; later ones get a one-time highlight.
  const freshAfter = useRef<number | null>(null)
  if (freshAfter.current === null && entries) freshAfter.current = entries[0]?.id ?? 0

  const colors = useMemo(() => new Map(state?.sessions.map((s) => [s.name, s.color])), [state])
  const colorOf = (name: string): GroupColor => colors.get(name) ?? "grey"

  // Sessions in order of their latest action, then live sessions that haven't acted yet.
  const options = useMemo<FilterOption[]>(() => {
    const counts = new Map<string, number>()
    for (const e of entries ?? []) counts.set(e.session, (counts.get(e.session) ?? 0) + 1)
    for (const s of state?.sessions ?? []) if (!counts.has(s.name)) counts.set(s.name, 0)
    if (selected !== null && !counts.has(selected)) counts.set(selected, 0)
    return [...counts].map(([name, count]) => ({ name, count, color: colors.get(name) ?? "grey" }))
  }, [entries, state, selected, colors])

  const shown = useMemo(
    () => (entries ?? []).filter((e) => selected === null || e.session === selected),
    [entries, selected],
  )

  const focus = (e: ActivityEntry) =>
    void act(e.tabId === null ? { op: "focusTab", session: e.session } : { op: "focusTab", session: e.session, tabId: e.tabId })

  const problem = error
    ? `Can’t reach Kitestring’s background (${error}). Close and reopen this panel.`
    : logError
      ? `Can’t read the activity log (${logError}).`
      : actionError
        ? `That didn’t work: ${actionError}`
        : null

  return (
    <main className="panel">
      <div className="panel__top">
        <header className="panel__header">
          <h1 className="panel__brand">
            <Lockup height={24} />
          </h1>
          {state ? <ConnectionPill connected={state.hostConnected} /> : null}
        </header>

        {problem ? (
          <p className="panel__error" role="alert">
            {problem}
          </p>
        ) : null}

        {state?.recording ? (
          <div className="panel__recording" role="status">
            {state.recording.active ? (
              <>
                <span className="panel__rec-dot" aria-hidden="true" />
                <span className="panel__rec-text">Recording {state.recording.name}</span>
                <button type="button" className="panel__rec-stop" onClick={() => void act({ op: "recordStop" })}>
                  Stop
                </button>
              </>
            ) : (
              <span className="panel__rec-text">
                Stopped {state.recording.name}. Run <code>kite record stop</code> to save it as a skill.
              </span>
            )}
          </div>
        ) : null}

        {state ? (
          <PauseControl
            paused={state.paused}
            reason={state.reason}
            since={state.since}
            agentTabs={state.sessions.reduce((n, s) => n + s.tabCount, 0)}
            onPause={(reason) => act({ op: "pause", reason })}
            onResume={() => act({ op: "resume" })}
          />
        ) : null}
      </div>

      <section className="panel__log" aria-labelledby="activity-h">
        <div className="panel__log-head">
          <h2 id="activity-h" className="panel__h2">
            Activity
          </h2>
          {entries?.length ? (
            <SessionFilter options={options} total={entries.length} selected={selected} onSelect={setSelected} />
          ) : null}
        </div>

        {entries === null ? (
          <div className="panel__loading" aria-busy="true" />
        ) : entries.length === 0 ? (
          <p className="panel__empty">
            No activity yet. Each tab an agent opens and each click, fill or key press shows up here as it happens.
          </p>
        ) : (
          <>
            {shown.length ? (
              <ActivityFeed entries={shown} colorOf={colorOf} freshAfter={freshAfter.current ?? 0} onFocus={focus} />
            ) : (
              <p className="panel__empty">Nothing from {selected} in the log yet.</p>
            )}
            {entries.length >= LOG_LIMIT ? (
              <p className="panel__note">Showing the latest {LOG_LIMIT} actions. Older ones have rolled off.</p>
            ) : null}
          </>
        )}
      </section>
    </main>
  )
}

export default SidePanel
