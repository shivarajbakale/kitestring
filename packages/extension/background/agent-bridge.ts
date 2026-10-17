import { ErrorCode } from "@bx/protocol"
import type { PageAgent } from "@bx/page-agent"
import { RestrictedPageError, RpcError } from "./errors"

export { RestrictedPageError }

export interface AgentMessage {
  bx: true
  method: keyof PageAgent
  args: unknown[]
}

export type AgentReply = { ok: true; value: unknown } | { ok: false; error: string }

const RESTRICTED_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "edge://",
  "about:",
  "devtools://",
  "view-source:",
  "https://chrome.google.com/webstore",
  "https://chromewebstore.google.com",
]

const AGENT_TIMEOUT_MS = 30_000
/** executeScript waits for document_idle: a page that never finishes loading would block it forever. */
const INJECT_TIMEOUT_MS = 10_000

/** Diagnostics, readable from the service worker console (and e2e) as `globalThis.__bxStats`. */
const stats = { injections: 0 }
;(globalThis as { __bxStats?: typeof stats }).__bxStats = stats

export function isRestrictedUrl(url: string): boolean {
  return RESTRICTED_PREFIXES.some((p) => url.startsWith(p))
}

/** executeScript failure messages that mean "the browser won't let extensions touch this page". */
const CANNOT_ACCESS_RE = /cannot access|cannot be scripted|extensions gallery|chrome:\/\/|chrome-extension:\/\/|missing host permission/i
const NO_RECEIVER_RE = /receiving end does not exist|could not establish connection/i

function send(tabId: number, msg: AgentMessage): Promise<AgentReply | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`page agent in tab ${tabId} did not answer within ${AGENT_TIMEOUT_MS} ms`)),
      AGENT_TIMEOUT_MS,
    )
    chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).then(
      (r: AgentReply | undefined) => {
        clearTimeout(timer)
        resolve(r)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

async function inject(tabId: number, url: string): Promise<void> {
  const file = chrome.runtime.getManifest().content_scripts?.[0]?.js?.[0]
  if (!file) throw new Error("content script missing from manifest")
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new RpcError(
            ErrorCode.TIMEOUT,
            `TIMEOUT: page in tab ${tabId} did not become scriptable within ${INJECT_TIMEOUT_MS} ms (still loading?)`,
          ),
        ),
      INJECT_TIMEOUT_MS,
    )
  })
  try {
    await Promise.race([chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [file] }), timeout])
  } catch (e) {
    if (e instanceof RpcError) throw e
    const message = e instanceof Error ? e.message : String(e)
    if (CANNOT_ACCESS_RE.test(message)) throw new RestrictedPageError(url)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

const tabUrl = (t: chrome.tabs.Tab) => t.url || t.pendingUrl || ""

/** Calls `method` on the page agent in the tab's top frame, injecting the content script if needed. */
export async function callAgent<T>(tabId: number, method: keyof PageAgent, args: unknown[]): Promise<T> {
  const url = tabUrl(await chrome.tabs.get(tabId))
  if (isRestrictedUrl(url)) throw new RestrictedPageError(url)

  const msg: AgentMessage = { bx: true, method, args }
  let reply: AgentReply | undefined
  try {
    reply = await send(tabId, msg)
  } catch (e) {
    if (!NO_RECEIVER_RE.test(e instanceof Error ? e.message : String(e))) throw e
    stats.injections++
    await inject(tabId, url)
    reply = await send(tabId, msg)
  }
  if (!reply) throw new Error(`page agent in tab ${tabId} sent no reply`)
  if (!reply.ok) throw new Error(reply.error)
  return reply.value as T
}
