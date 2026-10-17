import type { PlasmoCSConfig } from "plasmo"
import { createAgent, type PageAgent } from "@kitestring/page-agent"

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
}
