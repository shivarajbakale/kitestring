import { nameOf, roleOf } from "./roles.js"

/** What a press of Enter or Space on the focused element would activate, for the batch risk check. */
export interface PressTarget {
  /** The control whose name is checked: the focused control itself, or the form's default button. */
  control?: Element
  /** The control's accessible name; without one, the form's accessible name or `action` text. */
  name: string
}

function isSubmitControl(el: Element): boolean {
  if (el instanceof HTMLButtonElement) return el.type === "submit"
  return el instanceof HTMLInputElement && (el.type === "submit" || el.type === "image")
}

/** A focused control that Enter / Space activates itself (a click), rather than submitting a form. */
function activates(el: Element, key: "Enter" | "Space"): boolean {
  if (el instanceof HTMLButtonElement) return true
  if (el instanceof HTMLInputElement) return ["submit", "image", "button", "reset"].includes(el.type)
  const role = roleOf(el)
  if (role === "button") return true
  // Space never follows a link
  return key === "Enter" && (role === "link" || (el instanceof HTMLAnchorElement && el.hasAttribute("href")))
}

function focused(doc: Document): Element | null {
  let el: Element | null = doc.activeElement
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement
  return el
}

/**
 * null when the press activates nothing a name can be checked against: focus outside a form, Enter in a textarea or
 * contenteditable (a new line), Space anywhere but on a button.
 */
export function pressTarget(doc: Document, key: string): PressTarget | null {
  const k = /(^|\+)Enter$/.test(key) ? "Enter" : key === "Space" || key === " " ? "Space" : null
  const el = focused(doc)
  if (!k || !el || el === doc.body) return null
  if (activates(el, k)) return { control: el, name: nameOf(el) || (el instanceof HTMLInputElement ? el.value : "") }
  if (k === "Space") return null
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)) return null
  const owner = "form" in el && (el as { form: unknown }).form instanceof HTMLFormElement ? (el as { form: HTMLFormElement }).form : null
  const form = owner ?? el.closest("form")
  if (!form) return null
  const button = Array.from(form.elements).find(isSubmitControl)
  const label = button ? nameOf(button) || (button instanceof HTMLInputElement ? button.value : "") : ""
  if (button && label) return { control: button, name: label }
  return { ...(button ? { control: button } : {}), name: nameOf(form) || form.getAttribute("action") || "" }
}
