import type { PlasmoCSConfig } from "plasmo"
import { createAgent, startRecorder, type PageAgent, type Recorder } from "@kitestring/page-agent"
import type { RecordedEvent, RecorderState } from "@kitestring/protocol"

export const config: PlasmoCSConfig = { matches: ["<all_urls>"], run_at: "document_idle" }

interface AgentMessage {
  kite: true
  method: keyof PageAgent
  args: unknown[]
}

// The script can be injected again (chrome.scripting) into a page that already has it; keep one agent.
const g = globalThis as { __kiteAgent?: PageAgent }
if (!g.__kiteAgent) {
  const agent = createAgent(window)
  g.__kiteAgent = agent
  chrome.runtime.onMessage.addListener((msg: AgentMessage | undefined, _sender, sendResponse) => {
    if (!msg || msg.kite !== true) return false
    const fn = agent[msg.method] as ((...a: unknown[]) => unknown) | undefined
    if (typeof fn !== "function") {
      sendResponse({ ok: false, error: `unknown page agent method: ${String(msg.method)}` })
      return false
    }
    Promise.resolve()
      .then(() => fn(...msg.args))
      .then(
        (value) => sendResponse({ ok: true, value }),
        (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      )
    return true // async response
  })

  // The recorder listens only between the background's start and stop (only while this tab is being recorded).
  let recorder: Recorder | undefined
  chrome.runtime.onMessage.addListener((msg: { kiteRecord?: string; state?: RecorderState } | undefined, _sender, sendResponse) => {
    if (msg?.kiteRecord === "start" && msg.state) {
      if (recorder) recorder.update(msg.state)
      else {
        recorder = startRecorder(window, msg.state, (event: RecordedEvent) => {
          // steps arrive already parameterized: no typed value, option text, file name or secret is in them
          chrome.runtime.sendMessage({ kiteRecord: "event", event }).catch(() => {})
        })
      }
    } else if (msg?.kiteRecord === "stop") {
      recorder?.stop()
      recorder = undefined
    } else return false
    sendResponse({ ok: true })
    return false
  })
}
