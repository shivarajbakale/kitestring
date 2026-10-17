import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import type { AddressInfo } from "node:net"

const pagesDir = join(dirname(fileURLToPath(import.meta.url)), "pages")

export async function startTorture(port = 4173): Promise<{ url: string; close(): Promise<void> }> {
  let lastResult: string | undefined
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname
    if (path === "/__last-result") {
      if (req.method === "POST") {
        let body = ""
        for await (const chunk of req) {
          body += chunk
          if (body.length > 4096) break
        }
        lastResult = body.slice(0, 4096)
        res.writeHead(204).end()
      } else if (lastResult === undefined) res.writeHead(404, { "content-type": "text/plain" }).end("no result yet")
      else res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end(lastResult)
      return
    }
    if (path.startsWith("/analytics/")) {
      res.writeHead(204).end()
      return
    }
    const status = /^\/status\/([1-5][0-9]{2})$/.exec(path)
    if (status) {
      res.writeHead(Number(status[1]), { "content-type": "text/plain" }).end(`status ${status[1]}`)
      return
    }
    if (path === "/hang") {
      // A document that never finishes loading (never reaches document_idle): partial HTML, connection kept open.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      res.write("<!doctype html><title>Hang</title><h1>Loading forever</h1>\n")
      return
    }
    const name = path.slice(1)
    if (!/^[a-z0-9-]+$/.test(name)) {
      res.writeHead(404).end("not found")
      return
    }
    try {
      const html = await readFile(join(pagesDir, `${name}.html`))
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html)
    } catch {
      res.writeHead(404).end("not found")
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
  const actual = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${actual}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        server.closeAllConnections()
      }),
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const t = await startTorture(Number(process.env.PORT ?? 4173))
  console.log(`torture site: ${t.url}`)
}
