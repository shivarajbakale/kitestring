import { beforeEach, describe, expect, it, vi } from "vitest"

type H = (e: { method: string; params: Record<string, unknown> }) => void
const handlers: H[] = []
let attachHook: ((tabId: number) => void) | undefined
const send = vi.fn(async () => ({}))
vi.mock("../background/cdp", () => ({
  send: (...a: unknown[]) => (send as (...a: unknown[]) => unknown)(...a),
  onEvent: (_t: number, h: H) => {
    handlers.push(h)
    return () => handlers.splice(handlers.indexOf(h), 1)
  },
  onAttach: (h: (tabId: number) => void) => (attachHook = h),
}))

const open = (type: string, message = "m") =>
  handlers.slice().forEach((h) => h({ method: "Page.javascriptDialogOpening", params: { type, message } }))

beforeEach(() => {
  handlers.length = 0
  send.mockClear()
})

describe("watchDialogs", () => {
  it("accepts alerts", async () => {
    const { watchDialogs } = await import("../background/dialogs")
    const w = watchDialogs(1, {})
    open("alert", "Hello")
    expect(send).toHaveBeenCalledWith(1, "Page.handleJavaScriptDialog", { accept: true })
    expect(w.events).toEqual([{ type: "alert", message: "Hello", handled: "accepted" }])
    w.stop()
  })

  it("dismisses confirm without a policy", async () => {
    const { watchDialogs } = await import("../background/dialogs")
    const w = watchDialogs(1, {})
    open("confirm", "Sure?")
    expect(send).toHaveBeenCalledWith(1, "Page.handleJavaScriptDialog", { accept: false })
    expect(w.events[0]).toMatchObject({ type: "confirm", handled: "dismissed" })
    w.stop()
  })

  it("accepts confirm and prompt (empty text) with policy accept", async () => {
    const { watchDialogs } = await import("../background/dialogs")
    const w = watchDialogs(1, { policy: "accept" })
    open("confirm")
    expect(send).toHaveBeenLastCalledWith(1, "Page.handleJavaScriptDialog", { accept: true })
    open("prompt")
    expect(send).toHaveBeenLastCalledWith(1, "Page.handleJavaScriptDialog", { accept: true, promptText: "" })
    expect(w.events.map((e) => e.handled)).toEqual(["accepted", "accepted"])
    w.stop()
  })

  it("beforeunload is accepted only while navigating", async () => {
    const { watchDialogs } = await import("../background/dialogs")
    let nav = true
    const w = watchDialogs(1, { navigating: () => nav })
    open("beforeunload")
    expect(send).toHaveBeenLastCalledWith(1, "Page.handleJavaScriptDialog", { accept: true })
    nav = false
    open("beforeunload")
    expect(send).toHaveBeenLastCalledWith(1, "Page.handleJavaScriptDialog", { accept: false })
    w.stop()
  })

  it("stop unsubscribes", async () => {
    const { watchDialogs } = await import("../background/dialogs")
    watchDialogs(1, {}).stop()
    open("alert")
    expect(send).not.toHaveBeenCalled()
  })
})

describe("installDialogGuard (R1)", () => {
  it("answers on attached tabs without a watch, never double-answers a watched tab", async () => {
    const { installDialogGuard, watchDialogs } = await import("../background/dialogs")
    installDialogGuard()
    attachHook!(7)
    open("alert")
    expect(send).toHaveBeenCalledTimes(1)
    send.mockClear()
    open("confirm")
    expect(send).toHaveBeenCalledWith(7, "Page.handleJavaScriptDialog", { accept: false })
    send.mockClear()
    const w = watchDialogs(7, { policy: "accept" })
    open("confirm")
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(7, "Page.handleJavaScriptDialog", { accept: true })
    w.stop()
  })

  it("re-attaching the same tab does not stack handlers", async () => {
    const { installDialogGuard } = await import("../background/dialogs")
    installDialogGuard()
    attachHook!(9)
    attachHook!(9)
    send.mockClear()
    open("alert")
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("reports each dialog it answers (between actions), never one a watch answered", async () => {
    const { installDialogGuard, watchDialogs } = await import("../background/dialogs")
    const seen: unknown[] = []
    installDialogGuard((tabId, d) => seen.push([tabId, d]))
    attachHook!(11)
    open("confirm", "Leave?")
    expect(seen).toEqual([[11, { type: "confirm", message: "Leave?", handled: "dismissed" }]])
    const w = watchDialogs(11, {})
    open("alert", "Hi")
    expect(seen).toHaveLength(1)
    w.stop()
  })
})
