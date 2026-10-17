import { INTERACTIVE_ROLES, roleOf } from "./roles.js"

/** One-line page summary: "<title> | <url> | <first h1> | <n> interactive". */
export function brief(doc: Document): string {
  const h1 = doc.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim() ?? ""
  let n = 0
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    const role = roleOf(el)
    if (role && INTERACTIVE_ROLES.has(role)) n++
  }
  return `${doc.title} | ${doc.location.href} | ${h1} | ${n} interactive`
}
