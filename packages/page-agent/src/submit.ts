import { nameOf } from "./roles.js"

/** What an Enter on the focused element would submit, for the batch risk check. */
export interface EnterSubmit {
  form: HTMLFormElement
  /** The form's default button, if it has one (the first submit control, `form=` owners included). */
  button?: Element
  /** The button's accessible name; without a button, the form's accessible name or `action` text. */
  name: string
}

function isSubmitControl(el: Element): boolean {
  if (el instanceof HTMLButtonElement) return el.type === "submit"
  return el instanceof HTMLInputElement && (el.type === "submit" || el.type === "image")
}

function focused(doc: Document): Element | null {
  let el: Element | null = doc.activeElement
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement
  return el
}

/** null when the focused element is not inside a form (an Enter there submits nothing). */
export function enterSubmit(doc: Document): EnterSubmit | null {
  const el = focused(doc)
  if (!el) return null
  const owner = "form" in el && (el as { form: unknown }).form instanceof HTMLFormElement ? (el as { form: HTMLFormElement }).form : null
  const form = owner ?? el.closest("form")
  if (!form) return null
  const button = Array.from(form.elements).find(isSubmitControl)
  const label = button ? nameOf(button) || (button instanceof HTMLInputElement ? button.value : "") : ""
  if (button && label) return { form, button, name: label }
  return { form, ...(button ? { button } : {}), name: nameOf(form) || form.getAttribute("action") || "" }
}
