import { MAX_HOST_TO_CHROME } from "@bx/protocol"

export class FrameTooLargeError extends Error {
  constructor(size: number) {
    super(`frame of ${size} bytes exceeds the ${MAX_HOST_TO_CHROME} byte limit`)
    this.name = "FrameTooLargeError"
  }
}

/** Encode a message as a native-messaging frame: 4-byte LE length + UTF-8 JSON. */
export function encodeFrame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8")
  if (body.length > MAX_HOST_TO_CHROME) throw new FrameTooLargeError(body.length)
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const out: unknown[] = []
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0)
      if (this.buf.length < 4 + len) break
      out.push(JSON.parse(this.buf.subarray(4, 4 + len).toString("utf8")))
      this.buf = this.buf.subarray(4 + len)
    }
    return out
  }
}
