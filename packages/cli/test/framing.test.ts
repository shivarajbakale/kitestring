import { describe, expect, it } from "vitest"
import { FrameDecoder, FrameTooLargeError, encodeFrame } from "../src/host/framing.js"

describe("framing", () => {
  it("round-trips a message", () => {
    const d = new FrameDecoder()
    expect(d.push(encodeFrame({ a: 1 }))).toEqual([{ a: 1 }])
  })

  it("handles a frame split at every byte offset", () => {
    const buf = encodeFrame({ a: "héllo" })
    for (let i = 0; i <= buf.length; i++) {
      const d = new FrameDecoder()
      const out = [...d.push(buf.subarray(0, i)), ...d.push(buf.subarray(i))]
      expect(out).toEqual([{ a: "héllo" }])
    }
  })

  it("yields two messages from one chunk", () => {
    const d = new FrameDecoder()
    expect(d.push(Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 })]))).toEqual([{ n: 1 }, { n: 2 }])
  })

  it("throws FrameTooLargeError for >1MB", () => {
    expect(() => encodeFrame("x".repeat(1_100_000))).toThrow(FrameTooLargeError)
  })

  it("skips a malformed frame, reports it, and keeps decoding", () => {
    const errors: Error[] = []
    const d = new FrameDecoder((e) => errors.push(e))
    const bad = Buffer.from("{nope", "utf8")
    const hdr = Buffer.alloc(4)
    hdr.writeUInt32LE(bad.length, 0)
    const out = d.push(Buffer.concat([hdr, bad, encodeFrame({ ok: 1 })]))
    expect(out).toEqual([{ ok: 1 }])
    expect(errors).toHaveLength(1)
    expect(d.push(encodeFrame({ ok: 2 }))).toEqual([{ ok: 2 }])
  })
})
