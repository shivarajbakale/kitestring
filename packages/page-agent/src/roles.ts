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

export function roleOf(el: Element): string | null {
  return getRole(el)
}

export function nameOf(el: Element): string {
  try {
    return computeAccessibleName(el).replace(/\s+/g, " ").trim()
  } catch {
    return ""
  }
}
