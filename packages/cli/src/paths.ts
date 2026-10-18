import { homedir, userInfo } from "node:os"
import { join } from "node:path"

export function kiteHome(): string {
  return process.env.KITE_HOME || join(homedir(), ".kitestring")
}
export function socketPath(plat: NodeJS.Platform = process.platform, user?: string): string {
  if (plat === "win32") return `\\\\.\\pipe\\kitestring-${user ?? userInfo().username}`
  return join(kiteHome(), "kite.sock")
}
export function logPath(): string {
  return join(kiteHome(), "logs", "host.log")
}

/** Show `p` relative to `home` as `~/…` when it is inside it. */
export const tilde = (home: string, p: string): string => (p.startsWith(home + "/") ? "~" + p.slice(home.length) : p)
