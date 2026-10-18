/** Click targets whose accessible name matches one of these (whole word/phrase) halt a batch with `risky`. */
export const RISK_KEYWORDS = [
  "pay",
  "buy",
  "purchase",
  "place order",
  "send",
  "delete",
  "remove account",
  "publish",
  "submit for review",
  "transfer",
  "confirm payment",
] as const

function fold(s: string): string {
  return s.normalize("NFKC").replace(/ /g, " ").replace(/\s+/g, " ").trim().toLowerCase()
}

const RISK_RES = RISK_KEYWORDS.map((k) => new RegExp(`(?<![\\p{L}\\p{N}])${k}(?![\\p{L}\\p{N}])`, "u"))

export function isRisky(name: string): boolean {
  const n = fold(name)
  return RISK_RES.some((re) => re.test(n))
}
