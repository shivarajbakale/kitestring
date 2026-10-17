import type { PlasmoCSConfig } from "plasmo"
import { createAgent, type PageAgent } from "@bx/page-agent"

export const config: PlasmoCSConfig = { matches: ["<all_urls>"], run_at: "document_idle" }

interface AgentMessage {
  bx: true
  method: keyof PageAgent
  args: unknown[]
}

// The script can be injected again (chrome.scripting) into a page that already has it; keep one agent.
const g = globalThis as { __bxAgent?: PageAgent }
if (!g.__bxAgent) {
  const agent = createAgent(window)
  g.__bxAgent = agent
  chrome.runtime.onMessage.addListener((msg: AgentMessage | undefined, _sender, sendResponse) => {
    if (!msg || msg.bx !== true) return false
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
