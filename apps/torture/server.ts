import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import type { AddressInfo } from "node:net"

const pagesDir = join(dirname(fileURLToPath(import.meta.url)), "pages")

export async function startTorture(port = 4173): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname
    if (path.startsWith("/analytics/")) {
      res.writeHead(204).end()
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
