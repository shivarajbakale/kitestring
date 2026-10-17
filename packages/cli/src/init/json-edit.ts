import {
  SyntaxKind,
  applyEdits,
  createScanner,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parseTree,
  printParseErrorCode,
  type Edit,
  type Node,
  type ParseError,
} from "jsonc-parser"
import { isDeepStrictEqual } from "node:util"

/**
 * Comment-preserving JSON/JSONC edits. jsonc-parser's `modify` computes a minimal edit (we call it without
 * formatting options so it never reformats neighbours); we only pretty-print the inserted/replaced value to
 * match the file's indentation. Every byte outside the edited property stays as it was.
 */

const PARSE = { allowTrailingComma: true, disallowComments: false }

/** Parse tree, or undefined for an empty file. Throws on a file we cannot parse (never edit what we can't read). */
function tree(text: string): Node | undefined {
  if (text.trim() === "") return undefined
  const errors: ParseError[] = []
  const root = parseTree(text, errors, PARSE)
  if (errors.length || !root) {
    const e = errors[0]
    throw new Error(`not valid JSON/JSONC${e ? ` (${printParseErrorCode(e.error)} at offset ${e.offset})` : ""} — left unchanged`)
  }
  if (root.type !== "object") throw new Error("top level is not a JSON object — left unchanged")
  return root
}

export function jsonGet(text: string, path: string[]): unknown {
  const root = tree(text)
  const node = root && findNodeAtLocation(root, path)
  return node ? getNodeValue(node) : undefined
}

function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

/** Indentation unit used by the file: a tab, or the smallest leading-space run before a key. */
function unitOf(text: string): string {
  if (/^\t+"/m.test(text)) return "\t"
  let min = Infinity
  for (const m of text.matchAll(/^( +)["}\]]/gm)) min = Math.min(min, m[1]!.length)
  return Number.isFinite(min) ? " ".repeat(min) : "  "
}

/** Leading whitespace of the line containing `offset`. */
function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1
  return /^[ \t]*/.exec(text.slice(start))![0]
}

function isFirstOnLine(text: string, offset: number): boolean {
  const start = text.lastIndexOf("\n", offset - 1) + 1
  return text.slice(start, offset).trim() === ""
}

function pretty(value: unknown, unit: string, indent: string, eol: string): string {
  return JSON.stringify(value, null, unit).split("\n").join(eol + indent)
}

function apply(text: string, edits: Edit[]): string {
  return applyEdits(text, edits)
}

/** Sets `path` to `value`. Returns `text` unchanged (same string) when the value is already deep-equal. */
export function jsonSet(text: string, path: string[], value: unknown): string {
  if (isDeepStrictEqual(jsonGet(text, path), value)) return text
  const eol = eolOf(text)
  const unit = unitOf(text)
  const root = tree(text)
  if (!root) return pretty(nest(path, value), unit, "", eol) + eol

  // Deepest existing object along the path, and the remaining keys to create.
  let depth = path.length
  while (depth > 0 && !findNodeAtLocation(root, path.slice(0, depth))) depth--
  const existing = depth === path.length ? findNodeAtLocation(root, path)! : undefined

  const edits = modify(text, path, value, {})
  if (edits.length !== 1) return apply(text, edits)
  const edit = edits[0]!

  if (existing) {
    // Replace the value in place, indented like its property line.
    const indent = lineIndent(text, existing.offset)
    return apply(text, [{ ...edit, content: pretty(value, unit, indent, eol) }])
  }

  const parent = depth === 0 ? root : findNodeAtLocation(root, path.slice(0, depth))!
  if (parent.type !== "object") return apply(text, edits)
  const key = path[depth]!
  const rest = nest(path.slice(depth + 1), value)
  const props = parent.children ?? []
  const last = props[props.length - 1]
  const indent = last && isFirstOnLine(text, last.offset) ? lineIndent(text, last.offset) : lineIndent(text, parent.offset) + unit
  const prop = `${JSON.stringify(key)}: ${pretty(rest, unit, indent, eol)}`
  if (last) {
    // Insert right after the last property (before any trailing comma / comment).
    const at = last.offset + last.length
    return text.slice(0, at) + `,${eol}${indent}${prop}` + text.slice(at)
  }
  // Empty object: put the property on its own line, then close on the object's own indentation.
  const open = parent.offset + 1
  const close = parent.offset + parent.length - 1
  const inner = text.slice(open, close)
  const closeIndent = lineIndent(text, parent.offset)
  if (inner.trim() === "") return text.slice(0, open) + `${eol}${indent}${prop}${eol}${closeIndent}` + text.slice(close)
  return text.slice(0, open) + `${eol}${indent}${prop}` + text.slice(open)
}

/** True when `text` (a slice of the document) contains a line or block comment. */
function hasComment(text: string): boolean {
  const sc = createScanner(text, false)
  for (let t = sc.scan(); t !== SyntaxKind.EOF; t = sc.scan()) {
    if (t === SyntaxKind.LineCommentTrivia || t === SyntaxKind.BlockCommentTrivia) return true
  }
  return false
}

/**
 * Text range that removing the property at `path` deletes: from the end of the previous sibling's value
 * (taking the separating comma), else from our key to the start of the next sibling, else the object's
 * whole inside. Returns undefined when that range holds a comment (deleting it would lose the user's note).
 */
function removalRange(text: string, path: string[]): { start: number; end: number } | undefined {
  const root = tree(text)!
  const value = findNodeAtLocation(root, path)!
  const prop = value.parent! // property node: [key, value]
  const obj = prop.parent!
  const siblings = obj.children ?? []
  const i = siblings.indexOf(prop)
  const propEnd = prop.offset + prop.length
  const candidates: { start: number; end: number }[] = []
  if (siblings.length === 1) candidates.push({ start: obj.offset + 1, end: obj.offset + obj.length - 1 })
  if (i > 0) {
    const prev = siblings[i - 1]!
    candidates.push({ start: prev.offset + prev.length, end: propEnd })
  } else if (i + 1 < siblings.length) {
    candidates.push({ start: prop.offset, end: siblings[i + 1]!.offset })
  } else candidates.push({ start: prop.offset, end: propEnd })
  return candidates.find((r) => !hasComment(text.slice(r.start, r.end)))
}

/**
 * Removes `path`. If that leaves its parent object empty (and comment-free), removes the parent too (up to
 * the top level), so a key that init created goes away with its container. Throws instead of deleting a
 * user's comment next to the entry.
 */
export function jsonRemove(text: string, path: string[]): string {
  if (jsonGet(text, path) === undefined) return text
  const r = removalRange(text, path)
  if (!r) throw new Error(`a comment sits next to ${path.join(".")} — remove that entry by hand`)
  let out = text.slice(0, r.start) + text.slice(r.end)
  for (let d = path.length - 1; d >= 1; d--) {
    const parentPath = path.slice(0, d)
    const v = jsonGet(out, parentPath)
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== 0) break
    const pr = removalRange(out, parentPath)
    if (!pr) break // keep an empty container that carries comments
    out = out.slice(0, pr.start) + out.slice(pr.end)
  }
  return out
}

function nest(path: string[], value: unknown): unknown {
  return path.reduceRight<unknown>((v, k) => ({ [k]: v }), value)
}
