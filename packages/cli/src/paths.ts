import { homedir } from "node:os"
import { join } from "node:path"

export function kiteHome(): string {
  return process.env.KITE_HOME || join(homedir(), ".kitestring")
}
export function socketPath(): string {
  return join(kiteHome(), "kite.sock")
}
export function logPath(): string {
  return join(kiteHome(), "logs", "host.log")
}
