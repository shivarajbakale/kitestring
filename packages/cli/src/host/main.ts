import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { logPath, socketPath } from "../paths.js"
import { startDaemon } from "./daemon.js"
import { FrameDecoder, encodeFrame } from "./framing.js"

function log(msg: string): void {
  try {
    const p = logPath()
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    // logging must never break the host; stdout is reserved for frames
  }
}

async function main(): Promise<void> {
  mkdirSync(dirname(socketPath()), { recursive: true, mode: 0o700 })
  const daemon = await startDaemon({
    socketPath: socketPath(),
    toExtension: (msg) => {
      process.stdout.write(encodeFrame(msg))
    },
  })
  log("host started")

  const decoder = new FrameDecoder()
  process.stdin.on("data", (chunk: Buffer) => {
    try {
      for (const msg of decoder.push(chunk)) daemon.fromExtension(msg)
    } catch (e) {
      log(`bad frame: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
  process.stdin.on("end", () => {
    log("stdin ended; shutting down")
    daemon.fromExtension({ type: "disconnected" })
    void daemon.close().finally(() => process.exit(0))
  })
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})
