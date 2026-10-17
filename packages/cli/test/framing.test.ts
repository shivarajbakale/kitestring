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
})
