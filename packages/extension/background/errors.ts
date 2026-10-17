import type { ErrorCode } from "@kitestring/protocol"

/** An error that maps to a specific RPC error code. The message is shown to the CLI user verbatim. */
export class RpcError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "RpcError"
  }
}

/** The browser does not let extensions script this page. */
export class RestrictedPageError extends Error {
  constructor(public url: string) {
    super(`restricted page (${url}) — browser blocks extensions here`)
    this.name = "RestrictedPageError"
  }
}
