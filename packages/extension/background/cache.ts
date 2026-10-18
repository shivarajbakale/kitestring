import { pathPattern, type Locator, type Target } from "@kitestring/protocol"

/** chrome.storage.local key holding the cache (an array of [key, entry], least recently used first). */
export const CACHE_KEY = "kite.cache"
export const CACHE_LIMIT = 5_000
export const FLUSH_MS = 5_000

interface Entry extends Locator {
  hits: number
  lastUsed: number
}

/** Insertion order is recency order: the first key is the least recently used. */
const map = new Map<string, Entry>()
let loaded: Promise<void> | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let writes: Promise<void> = Promise.resolve()

const fold = (s: string): string => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()
const SEP = "\n"

/**
 * `origin + pathPattern + text + role? + within?`; "" for a ref target (refs are not stable, nothing to cache)
 * or a URL with no origin.
 */
export function cacheKey(url: string, target: Target): string {
  if (!("text" in target)) return ""
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    return ""
  }
  if (origin === "null") return ""
  return [origin, pathPattern(url), fold(target.text), target.role ? fold(target.role) : "", target.within ? fold(target.within) : ""].join(SEP)
}

const originOf = (key: string): string => key.split(SEP, 1)[0] ?? ""

/** Loads the persisted cache once; entries remembered meanwhile win over stored ones. */
export function ready(): Promise<void> {
  loaded ??= (async () => {
    const stored = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] as [string, Entry][] | undefined
    if (!Array.isArray(stored)) return
    const fresh = new Map(map)
    map.clear()
    for (const [k, v] of stored) if (typeof k === "string" && v && typeof v.ref === "string") map.set(k, v)
    for (const [k, v] of fresh) {
      map.delete(k)
      map.set(k, v)
    }
    while (map.size > CACHE_LIMIT) map.delete(map.keys().next().value as string)
  })().catch((e: unknown) => {
    loaded = null
    throw e
  })
  return loaded
}

function touch(key: string, e: Entry): void {
  map.delete(key)
  map.set(key, e)
}

function schedule(): void {
  if (timer) return
  timer = setTimeout(() => void flush(), FLUSH_MS)
}

/** Writes the cache now (cancelling a pending timer); resolves once it is stored. */
export function flush(): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = null
  writes = writes
    .then(() => ready())
    .then(() => chrome.storage.local.set({ [CACHE_KEY]: [...map] }))
    .catch((err: unknown) => console.warn("[kite] cache not persisted", err))
  return writes
}

/** The remembered locator for this key. Only a hint: the page agent must still verify it. */
export function getHint(key: string): Locator | undefined {
  const e = key ? map.get(key) : undefined
  if (!e) return undefined
  const { hits: _h, lastUsed: _l, ...loc } = e
  return loc
}

/** Counts a use: the hint was verified and the action went ahead with it. */
export function hit(key: string): void {
  const e = map.get(key)
  if (!e) return
  e.hits++
  e.lastUsed = Date.now()
  touch(key, e)
  schedule()
}

/** Stores (or overwrites) what FIND resolved for this key. */
export function remember(key: string, loc: Locator): void {
  if (!key) return
  const prev = map.get(key)
  touch(key, { ...loc, hits: prev?.hits ?? 0, lastUsed: Date.now() })
  while (map.size > CACHE_LIMIT) map.delete(map.keys().next().value as string)
  schedule()
}

export function stats(): { entries: number; hits: number; sites: number } {
  let hits = 0
  const sites = new Set<string>()
  for (const [k, e] of map) {
    hits += e.hits
    sites.add(originOf(k))
  }
  return { entries: map.size, hits, sites: sites.size }
}

/** Forgets every entry, or only those of one origin. Returns how many were removed. */
export function clear(site?: string): number {
  let n = 0
  for (const k of [...map.keys()]) {
    if (site === undefined || originOf(k) === site) {
      map.delete(k)
      n++
    }
  }
  void flush()
  return n
}
