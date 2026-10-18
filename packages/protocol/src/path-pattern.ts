const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NUMERIC = /^\d+$/
const HEX = /^[0-9a-f]{16,}$/i
const TOKENISH = /^[A-Za-z0-9+/_=-]{16,}$/
const KEBAB_SLUG = /^[a-z0-9]+(-[a-z0-9]+)+$/

function isVariable(seg: string): boolean {
  if (NUMERIC.test(seg) || UUID.test(seg) || HEX.test(seg)) return true
  // base64-ish ids mix letters and digits; a lowercase hyphenated slug is a page name, not an id
  return TOKENISH.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg) && !KEBAB_SLUG.test(seg)
}

/** The route of a URL with its id-like segments replaced by `*`; query and fragment are dropped. */
export function pathPattern(url: string): string {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    path = url.split(/[?#]/)[0] ?? ""
  }
  const segs = path.split("/").map((s) => (s && isVariable(s) ? "*" : s))
  return segs.join("/") || "/"
}
