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

/**
 * Puts `files` (absolute paths) into a file input. With an input: set them directly, no dialog.
 * Without: intercept the file chooser, click at `clickAt`, and answer the chooser the page opens.
 * Interception is always switched off again.
 */
export async function setFiles(
  tabId: number,
  target: FileInputTarget | null,
  files: string[],
  clickAt?: { x: number; y: number },
): Promise<void> {
  if (target) {
    if (files.length > 1 && !target.multiple) throw tooMany(files)
    await send(tabId, "DOM.setFileInputFiles", { files, backendNodeId: await backendNodeId(tabId, target.ref) })
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
    await send(tabId, "DOM.setFileInputFiles", { files, backendNodeId: chooser.backendNodeId })
  } finally {
    off()
    await send(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {})
  }
}
