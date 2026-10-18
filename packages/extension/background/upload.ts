import { ErrorCode } from "@kitestring/protocol"
import { callAgent } from "./agent-bridge"
import { onEvent, send } from "./cdp"
import { RpcError } from "./errors"
import * as input from "./input"

/** How long to wait for the page to open a file chooser after the click. */
const CHOOSER_WAIT_MS = 5_000
const OBJECT_GROUP = "kite-upload"

export interface FileInputTarget {
  ref: string
  multiple: boolean
}

function tooMany(files: string[]): RpcError {
  return new RpcError(ErrorCode.BAD_REQUEST, `this file input takes one file, got ${files.length}`)
}

/**
 * The CDP backendNodeId of the page agent's element. The agent lives in an isolated world, so it marks
 * the element with a temporary attribute that the main world (Runtime.evaluate) can query; the mark is
 * removed again before returning.
 */
async function backendNodeId(tabId: number, ref: string): Promise<number> {
  const token = Math.random().toString(36).slice(2, 12)
  if (!(await callAgent<boolean>(tabId, "markFileInput", [ref, token]))) {
    throw new RpcError(ErrorCode.BAD_REQUEST, "the file input is gone from the page")
  }
  try {
    const found = await send<{ result: { objectId?: string } }>(tabId, "Runtime.evaluate", {
      expression: `document.querySelector('[data-kite-upload="${token}"]')`,
      objectGroup: OBJECT_GROUP,
    })
    const objectId = found.result.objectId
    if (!objectId) throw new RpcError(ErrorCode.BAD_REQUEST, "the file input is not reachable from the page")
    const { node } = await send<{ node: { backendNodeId: number } }>(tabId, "DOM.describeNode", { objectId })
    return node.backendNodeId
  } finally {
    void send(tabId, "Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }).catch(() => {})
    await callAgent(tabId, "unmarkFileInput", [token]).catch(() => {})
  }
}

/** Calls `fn` (with `this` = the node) on a node known only by backendNodeId (e.g. a detached input). */
async function callOnNode<T>(tabId: number, backendNodeId: number, fn: string, args: unknown[]): Promise<T | undefined> {
  const { object } = await send<{ object: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId, objectGroup: OBJECT_GROUP })
  try {
    if (!object.objectId) return undefined
    const r = await send<{ result: { value?: T } }>(tabId, "Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    })
    return r.result.value
  } finally {
    void send(tabId, "Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }).catch(() => {})
  }
}

/**
 * One-shot capture-phase input/change listener (on the window and on the input itself, which may be
 * detached) that stores the input's file names under `key` when it dispatches, before a page handler
 * can clear `value`. Same idea as the page agent's watchFileInput, for an input with no agent ref.
 */
const RECORD_NAMES = `function (key) {
  const el = this, win = el.ownerDocument.defaultView || window
  const on = (e) => {
    if (e.composedPath()[0] !== el) return
    Object.defineProperty(el, key, { value: Array.from(el.files || [], (f) => f.name), configurable: true })
    for (const t of [win, el]) { t.removeEventListener("input", on, true); t.removeEventListener("change", on, true) }
  }
  for (const t of [win, el]) { t.addEventListener("input", on, true); t.addEventListener("change", on, true) }
}`

/** The names recorded under `key` at dispatch, else the live `input.files`. */
const READ_NAMES = "function (key) { return this[key] || Array.from(this.files || [], (f) => f.name) }"

/**
 * Puts `files` (absolute paths) into a file input. With an input: set them directly, no dialog.
 * Without: intercept the file chooser, click at `clickAt`, and answer the chooser the page opens.
 * Interception is always switched off again. Returns, for the chooser path, the file names the
 * chooser's input held when it dispatched change (read back through CDP: that input has no page-agent
 * ref); the direct path leaves that record to the page agent's watchFileInput (VERIFY reads fileNames).
 */
export async function setFiles(
  tabId: number,
  target: FileInputTarget | null,
  files: string[],
  clickAt?: { x: number; y: number },
): Promise<string[] | undefined> {
  if (target) {
    if (files.length > 1 && !target.multiple) throw tooMany(files)
    const node = await backendNodeId(tabId, target.ref)
    // VERIFY reads the names recorded at dispatch: the page may clear the input in its change handler.
    await callAgent(tabId, "watchFileInput", [target.ref])
    await send(tabId, "DOM.setFileInputFiles", { files, backendNodeId: node })
    return
  }
  if (!clickAt) throw new RpcError(ErrorCode.BAD_REQUEST, "no file input and nothing to click")
  let off = () => {}
  try {
    const opened = new Promise<{ backendNodeId?: number; mode?: string }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new RpcError(ErrorCode.BAD_REQUEST, `no file chooser opened within ${CHOOSER_WAIT_MS} ms`)),
        CHOOSER_WAIT_MS,
      )
      off = onEvent(tabId, ({ method, params }) => {
        if (method !== "Page.fileChooserOpened") return
        clearTimeout(timer)
        resolve(params as { backendNodeId?: number; mode?: string })
      })
    })
    opened.catch(() => {}) // surfaced by the await below; no unhandled rejection if the click throws first
    await send(tabId, "Page.setInterceptFileChooserDialog", { enabled: true })
    await input.click(tabId, clickAt.x, clickAt.y)
    const chooser = await opened
    if (chooser.backendNodeId === undefined) {
      throw new RpcError(ErrorCode.BAD_REQUEST, "the browser did not say which input the page opened")
    }
    if (files.length > 1 && chooser.mode !== "selectMultiple") throw tooMany(files)
    const key = `__kiteUpload${Math.random().toString(36).slice(2, 10)}`
    await callOnNode(tabId, chooser.backendNodeId, RECORD_NAMES, [key])
    await send(tabId, "DOM.setFileInputFiles", { files, backendNodeId: chooser.backendNodeId })
    return (await callOnNode<string[]>(tabId, chooser.backendNodeId, READ_NAMES, [key])) ?? []
  } finally {
    off()
    await send(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {})
  }
}
