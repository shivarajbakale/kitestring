import { ErrorCode } from "@kitestring/protocol"
import { send } from "./cdp"
import { RpcError } from "./errors"

interface KeyDef {
  key: string
  code: string
  keyCode: number
  text?: string
}

const KEYS: Record<string, KeyDef> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
}

/** CDP modifier bits. */
const CTRL = 2
const META = 4

/** Throws BAD_REQUEST for keys outside the supported set (validate before acting). */
export function keyDef(key: string): KeyDef {
  const def = Object.prototype.hasOwnProperty.call(KEYS, key) ? KEYS[key] : undefined
  if (!def) {
    throw new RpcError(ErrorCode.BAD_REQUEST, `unknown key "${key}" (supported: ${Object.keys(KEYS).join(", ")})`)
  }
  return def
}

/** Left click at viewport CSS coordinates. Press and release are sent back to back (no await between). */
export async function click(tabId: number, x: number, y: number): Promise<void> {
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
  const base = { x, y, button: "left", buttons: 1, clickCount: 1 }
  await Promise.all([
    send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" }),
    send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 }),
  ])
}

export async function insertText(tabId: number, text: string): Promise<void> {
  await send(tabId, "Input.insertText", { text })
}

let isMac: Promise<boolean> | null = null

/** Meta+A on macOS, Control+A elsewhere (with the editing command, which macOS needs for synthetic keys). */
export async function selectAll(tabId: number): Promise<void> {
  isMac ??= chrome.runtime.getPlatformInfo().then((p) => p.os === "mac")
  const modifiers = (await isMac) ? META : CTRL
  const base = { modifiers, key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 }
  await send(tabId, "Input.dispatchKeyEvent", { ...base, type: "rawKeyDown", commands: ["selectAll"] })
  await send(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" })
}

/** Presses and releases a key on the focused element. Unknown key → BAD_REQUEST. */
export async function press(tabId: number, key: string): Promise<void> {
  const d = keyDef(key)
  const base = {
    key: d.key,
    code: d.code,
    windowsVirtualKeyCode: d.keyCode,
    nativeVirtualKeyCode: d.keyCode,
  }
  await send(tabId, "Input.dispatchKeyEvent", {
    ...base,
    type: d.text ? "keyDown" : "rawKeyDown",
    ...(d.text ? { text: d.text, unmodifiedText: d.text } : {}),
  })
  await send(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" })
}

/** Viewport size in CSS pixels. */
export async function viewport(tabId: number): Promise<{ width: number; height: number }> {
  const m = await send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>(tabId, "Page.getLayoutMetrics")
  return { width: m.cssLayoutViewport.clientWidth, height: m.cssLayoutViewport.clientHeight }
}

/** Mouse-wheel scroll by `dy` CSS pixels (negative = up) at `at`, or at the viewport centre. */
export async function wheel(tabId: number, dy: number, at?: { x: number; y: number }): Promise<void> {
  let p = at
  if (!p) {
    const v = await viewport(tabId)
    p = { x: v.width / 2, y: v.height / 2 }
  }
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: Math.round(p.x),
    y: Math.round(p.y),
    deltaX: 0,
    deltaY: dy,
  })
}
