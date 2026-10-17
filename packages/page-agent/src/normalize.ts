/** Canonical form for comparing user-supplied text with page text. */
export function norm(s: string): string {
  return s.normalize("NFKC").replace(/ /g, " ").replace(/\s+/g, " ").trim().toLowerCase()
}
