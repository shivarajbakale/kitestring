/** Multi-label public suffixes (ICANN and private) the domain guard must not treat as one site. Not the full PSL. */
const SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.in", "co.jp", "com.br", "co.nz",
  "github.io", "vercel.app", "netlify.app", "pages.dev", "web.app", "firebaseapp.com", "appspot.com",
  "herokuapp.com", "cloudfront.net", "blogspot.com",
])

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

/** eTLD+1 of a URL's host (bundled suffix subset, fallback last two labels). IPs and `localhost` return the host. */
export function registrableDomain(url: string): string {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return url
  }
  host = host.replace(/\.$/, "")
  if (host === "localhost" || IPV4_RE.test(host) || host.startsWith("[")) return host
  const labels = host.split(".")
  if (labels.length <= 2) return host
  for (let n = Math.min(3, labels.length - 1); n >= 2; n--) {
    if (SUFFIXES.has(labels.slice(-n).join("."))) return labels.slice(-(n + 1)).join(".")
  }
  return labels.slice(-2).join(".")
}

export function sameSite(a: string, b: string): boolean {
  return registrableDomain(a) === registrableDomain(b)
}
