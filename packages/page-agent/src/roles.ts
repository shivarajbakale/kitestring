import { computeAccessibleName, getRole } from "dom-accessibility-api"

export const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox",
  "option", "menuitem", "tab", "switch", "slider", "spinbutton"
])

export const LANDMARK_ROLES = new Set([
  "main", "navigation", "banner", "contentinfo", "complementary", "form", "region",
  "dialog", "alertdialog", "list", "heading"
])

/** Landmarks that contribute to a ref's landmark path (lists and headings do not). */
export const PATH_ROLES = new Set([
  "main", "navigation", "banner", "contentinfo", "complementary", "form", "region",
  "dialog", "alertdialog"
])

/** True only for the element carrying contenteditable, whose parent is not itself editable. */
function isEditingHost(el: Element): boolean {
  if (!(el instanceof HTMLElement) || !el.isContentEditable) return false
  const attr = el.getAttribute("contenteditable")
  if (attr === null || !["", "true", "plaintext-only"].includes(attr.toLowerCase())) return false
  const parent = el.parentElement
  return !(parent && parent.isContentEditable)
}

export function roleOf(el: Element): string | null {
  // ARIA has no role for password inputs; treat them as textboxes (value is masked in snapshots).
  if (el instanceof HTMLInputElement && el.type === "password") return "textbox"
  // Browsers expose a file input as a button; the library gives it no role, which would hide it from find().
  if (el instanceof HTMLInputElement && el.type === "file") return "button"
  const role = getRole(el)
  if ((!role || role === "generic") && isEditingHost(el)) return "textbox"
  return role
}

export function nameOf(el: Element): string {
  try {
    return computeAccessibleName(el).replace(/\s+/g, " ").trim()
  } catch {
    return ""
  }
}
