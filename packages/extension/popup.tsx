import { useEffect, useState } from "react"
import { ConnectionPill } from "~ui/components/ConnectionPill"
import { ChevronIcon, PanelIcon } from "~ui/components/icons"
import { Lockup } from "~ui/components/Lockup"
import { PauseControl } from "~ui/components/PauseControl"
import { SessionList } from "~ui/components/SessionList"
import { useStatus } from "~ui/use-status"
import "~ui/theme.css"
import "~ui/popup.css"

function Popup() {
  const { state, error, actionError, act } = useStatus()
  const [windowId, setWindowId] = useState<number>()
  const [panelError, setPanelError] = useState<string | null>(null)
  const version = chrome.runtime.getManifest().version

  // Known before any click, so openPanel runs inside the click's user gesture.
  useEffect(() => {
    chrome.windows.getCurrent().then((w) => setWindowId(w.id), () => {})
  }, [])

  // Called directly in the click handler (not via the background) so Chrome sees the user gesture.
  const openPanel = () => {
    if (windowId === undefined) return
    chrome.sidePanel.open({ windowId }).then(
      () => window.close(),
      (e: unknown) => setPanelError(e instanceof Error ? e.message : String(e)),
    )
  }

  return (
    <main className="popup">
      <header className="popup__header">
        <h1 className="popup__brand">
          <Lockup height={24} />
        </h1>
        {state ? <ConnectionPill connected={state.hostConnected} /> : null}
      </header>

      {error ? (
        <p className="popup__error" role="alert">
          Can’t reach Kitestring’s background ({error}). Close and reopen this popup.
        </p>
      ) : actionError || panelError ? (
        <p className="popup__error" role="alert">
          That didn’t work: {actionError ?? panelError}
        </p>
      ) : null}

      {state ? (
        <>
          <PauseControl
            paused={state.paused}
            reason={state.reason}
            since={state.since}
            agentTabs={state.sessions.reduce((n, s) => n + s.tabCount, 0)}
            onPause={(reason) => act({ op: "pause", reason })}
            onResume={() => act({ op: "resume" })}
          />

          <section className="popup__sessions" aria-labelledby="sessions-h">
            <h2 id="sessions-h" className="popup__h2">
              Sessions
              {state.sessions.length ? <span className="popup__h2-count">{state.sessions.length}</span> : null}
            </h2>
            {state.sessions.length ? (
              <SessionList sessions={state.sessions} onFocus={(session) => void act({ op: "focusTab", session })} />
            ) : (
              <p className="popup__empty">
                No agents yet. Run <code>kite init</code> in a terminal to connect your coding agent.
              </p>
            )}
          </section>
        </>
      ) : !error ? (
        <div className="popup__loading" aria-busy="true" />
      ) : null}

      <footer className="popup__footer">
        <button type="button" className="ks-link" onClick={openPanel} disabled={windowId === undefined}>
          <PanelIcon />
          Open live view
          <ChevronIcon size={12} />
        </button>
        <span className="popup__version">v{version}</span>
      </footer>
    </main>
  )
}

export default Popup
