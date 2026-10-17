/**
 * Text-level TOML edits for exactly one table and its sub-tables (e.g. `[mcp_servers.kitestring]` and
 * `[mcp_servers.kitestring.env]`). Everything else in the file is left byte-for-byte as it was.
 */

const HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/

/** `mcp_servers."kitestring".env` → `mcp_servers.kitestring.env` (enough for simple bare/quoted keys). */
function normKey(k: string): string {
  return k
    .split(".")
    .map((p) => p.trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2"))
    .join(".")
}

function headerKey(line: string): string | undefined {
  const m = HEADER.exec(line)
  return m ? normKey(m[1]!) : undefined
}

const isTrivia = (line: string) => line.trim() === "" || line.trim().startsWith("#")

interface Block {
  start: number
  end: number // exclusive; trailing blank/comment lines before the next header are not part of the block
}

/** Blocks (header line .. last content line) for `table` and its sub-tables, in file order. */
function findBlocks(lines: string[], table: string): Block[] {
  const blocks: Block[] = []
  for (let i = 0; i < lines.length; i++) {
    const k = headerKey(lines[i]!)
    if (k === undefined || (k !== table && !k.startsWith(table + "."))) continue
    let j = i + 1
    while (j < lines.length && headerKey(lines[j]!) === undefined) j++
    let end = j
    while (end > i + 1 && isTrivia(lines[end - 1]!)) end--
    blocks.push({ start: i, end })
    i = j - 1
  }
  return blocks
}

function split(text: string): { lines: string[]; eol: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  return { lines: text.split(eol), eol }
}

const KEY_LINE = /^\s*((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=/

/**
 * 1-based line number where `table` (or a key under it) is defined by a key/value line instead of a
 * `[table]` header: `kitestring = { … }` under `[mcp_servers]`, or `mcp_servers.kitestring.command = …`.
 * Appending a `[table]` header then would define the key twice and break the file.
 */
function otherDefinition(text: string, table: string): number | undefined {
  const lines = split(text).lines
  let current = ""
  let arrayDepth = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (arrayDepth > 0) {
      arrayDepth += bracketDelta(line)
      continue
    }
    const h = headerKey(line)
    if (h !== undefined) {
      current = /^\s*\[\[/.test(line) ? "\0array" : h
      continue
    }
    const m = KEY_LINE.exec(line)
    if (!m) continue
    arrayDepth = Math.max(0, bracketDelta(line.slice(m[0].length)))
    if (current === table || current.startsWith(table + ".")) continue // inside our own tables
    const full = normKey(current ? `${current}.${m[1]}` : m[1]!)
    if (full === table || full.startsWith(table + ".")) return i + 1
  }
  return undefined
}

/** Net `[` minus `]` outside strings and comments (for multi-line arrays). */
function bracketDelta(s: string): number {
  let d = 0
  let q: string | undefined
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (q) {
      if (c === "\\" && q === '"') i++
      else if (c === q) q = undefined
    } else if (c === '"' || c === "'") q = c
    else if (c === "#") break
    else if (c === "[") d++
    else if (c === "]") d--
  }
  return d
}

/** Lines strictly between two blocks are all blank (so they read as one unit). */
function adjacent(lines: string[], a: Block, b: Block): boolean {
  for (let i = a.end; i < b.start; i++) if (lines[i]!.trim() !== "") return false
  return true
}

function removeBlock(lines: string[], b: Block): void {
  lines.splice(b.start, b.end - b.start)
  const before = b.start - 1
  const atEnd = lines.slice(b.start).every((l) => l.trim() === "")
  if (atEnd) {
    // Drop the separator we added when appending; keep a single final newline.
    let k = lines.length
    while (k > 0 && lines[k - 1]!.trim() === "") k--
    lines.splice(k, lines.length - k, "")
    return
  }
  if (before >= 0 && lines[before]!.trim() === "" && lines[b.start]!.trim() === "") lines.splice(b.start, 1)
}

/**
 * Makes `table` (with its sub-tables) read exactly `block` (no trailing newline). Replaces the existing
 * table in place when present, else appends it after a blank line. Returns `text` itself when unchanged.
 */
export function tomlSetTable(text: string, table: string, block: string): string {
  const other = otherDefinition(text, table)
  if (other) {
    throw new Error(`${table} is already defined as a key (line ${other}: inline table or dotted keys) — edit it by hand`)
  }
  const { lines, eol } = split(text)
  const blockLines = block.split("\n")
  const blocks = findBlocks(lines, table)
  if (blocks.length === 0) {
    if (text === "") return blockLines.join(eol) + eol
    const base = text.endsWith(eol) ? text : text + eol
    const sep = base.trim() === "" ? "" : eol
    return base + sep + blockLines.join(eol) + eol
  }
  const first = blocks[0]!
  const contiguous = blocks.every((b, i) => i === 0 || adjacent(lines, blocks[i - 1]!, b))
  if (contiguous) {
    const lastBlock = blocks[blocks.length - 1]!
    const current = lines.slice(first.start, lastBlock.end)
    if (current.join("\n") === blockLines.join("\n")) return text
    lines.splice(first.start, lastBlock.end - first.start, ...blockLines)
    return lines.join(eol)
  }
  // Scattered: drop the later pieces, replace the first.
  for (const b of blocks.slice(1).reverse()) removeBlock(lines, b)
  lines.splice(first.start, first.end - first.start, ...blockLines)
  return lines.join(eol)
}

/** Removes `table` and its sub-tables. Returns `text` itself when absent. */
export function tomlRemoveTable(text: string, table: string): string {
  const { lines, eol } = split(text)
  const blocks = findBlocks(lines, table)
  if (blocks.length === 0) return text
  for (const b of [...blocks].reverse()) removeBlock(lines, b)
  return lines.join(eol)
}

export function tomlHasTable(text: string, table: string): boolean {
  return findBlocks(split(text).lines, table).length > 0
}

