import { beforeEach, describe, expect, it, vi } from "vitest"

let store: Record<string, unknown>
let changed: ((changes: Record<string, { newValue?: unknown }>, area: string) => void) | undefined

beforeEach(() => {
  vi.resetModules()
  store = {}
  changed = undefined
  ;(globalThis as { chrome?: unknown }).chrome = {
    storage: {
      session: {
        get: vi.fn(async (k: string) => (k in store ? { [k]: store[k] } : {})),
        set: vi.fn(async (o: Record<string, unknown>) => Object.assign(store, o)),
      },
      onChanged: { addListener: (cb: typeof changed) => (changed = cb) },
    },
  }
})

describe("control", () => {
  it("pauses, resumes, persists and notifies", async () => {
    const control = await import("../background/control")
    await control.ready()
    const seen: boolean[] = []
    control.onChange((s) => seen.push(s.paused))
    expect(control.isPaused()).toBe(false)
    await control.pause("lunch")
    expect(control.isPaused()).toBe(true)
    expect(control.getState()).toMatchObject({ paused: true, reason: "lunch" })
    expect(store.control).toMatchObject({ paused: true, reason: "lunch" })
    await control.resume()
    expect(control.isPaused()).toBe(false)
    expect(seen).toEqual([true, false])
  })

  it("restores a persisted pause after a service-worker restart", async () => {
    store.control = { paused: true, since: 5 }
    const control = await import("../background/control")
    await control.ready()
    expect(control.isPaused()).toBe(true)
  })

  it("follows newer writes by other extension pages and ignores stale echoes", async () => {
    const control = await import("../background/control")
    await control.ready()
    const seen: boolean[] = []
    control.onChange((s) => seen.push(s.paused))
    changed!({ control: { newValue: { paused: true, since: Date.now() + 1000 } } }, "session")
    expect(control.isPaused()).toBe(true)
    changed!({ control: { newValue: { paused: false, since: 1 } } }, "session") // stale
    expect(control.isPaused()).toBe(true)
    changed!({ control: { newValue: { paused: false, since: Date.now() + 2000 } } }, "local") // other area
    expect(control.isPaused()).toBe(true)
    expect(seen).toEqual([true])
  })

  it("assertNotPaused throws PAUSED with the user-facing message", async () => {
    const control = await import("../background/control")
    await control.ready()
    control.assertNotPaused()
    await control.pause()
    expect(() => control.assertNotPaused()).toThrow("Kitestring is paused by the user")
    try {
      control.assertNotPaused()
    } catch (e) {
      expect((e as { code: string }).code).toBe("PAUSED")
    }
  })
})
