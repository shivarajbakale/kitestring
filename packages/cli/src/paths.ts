import { homedir } from "node:os"
import { join } from "node:path"

export function bxHome(): string {
  return process.env.BX_HOME || join(homedir(), ".bx")
}
export function socketPath(): string {
  return join(bxHome(), "bx.sock")
}
export function logPath(): string {
  return join(bxHome(), "logs", "host.log")
}
