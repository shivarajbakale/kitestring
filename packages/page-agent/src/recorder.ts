import {
  MIN_ECHO,
  echoEntry,
  findEcho,
  normEcho,
  paramName,
  type PlanParam,
  type PlanStep,
  type PlanTarget,
  type RecordEcho,
  type RecordedEvent,
  type RecorderState,
} from "@kitestring/protocol"
import { fileInputFor } from "./files.js"
import { isSecretField, scopeName } from "./find.js"
import { nameOf, roleOf } from "./roles.js"

/** Roles a recorded click lands on (text fields, selects and sliders are recorded by their change instead). */
const CLICK_ROLES = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "option", "menuitem", "menuitemcheckbox", "menuitemradio",
  "treeitem", "gridcell", "combobox",
])
/** Clicking one of these picks a value from a list, so its name is data (as in `buildPlan`). */
const CHOICE_ROLES = new Set(["option", "menuitemradio", "treeitem", "gridcell"])
const CHOICE_BOX = "[role=listbox],[role=menu],[role=menubar],[role=tree],[role=grid],[role=treegrid],[role=combobox]"
const TEXT_TYPES = new Set(["text", "email", "search", "tel", "url", "password", "number"])
/** Inputs kite cannot set by typing: a change to one is reported by name in `skipped`, never recorded. */
const UNRECORDED_TYPES = new Set(["date", "time", "datetime-local", "month", "week", "color", "range"])
/** The submit button's implicit click this soon after a recorded Enter was caused by it (and is not recorded again). */
const IMPLICIT_CLICK_MS = 1_000

export interface Recorder {
  /** New state from the background (param names in use, echoes of earlier pages' values). */
  update(state: RecorderState): void
  /** Removes every listener; nothing more is emitted. */
  stop(): void
}

type TextField = HTMLInputElement | HTMLTextAreaElement

const isTextField = (el: Element): el is TextField =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_TYPES.has(el.type))
const isFileInput = (el: Element | null | undefined): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === "file"
const isSubmitOf = (el: Element, form: HTMLFormElement | null): boolean =>
  (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) && el.type === "submit" && el.form === form

/**
 * Records the human's actions in this page as plan steps, parameterized here so that no value leaves the page:
 *
 * - click on an interactive role, a text field committed (change: blur or Enter), a select change, a file chosen, and Enter
 *   in a text field; a form submit is recorded as the click or Enter that caused it, and any other submit (a page that
 *   submits itself) is dropped; a change to a date / time / color / range input is reported by kind and name only;
 * - only trusted events (a person, not page script);
 * - targets are `{text: name, role, within?}` from `nameOf` / `roleOf` / the nearest named scope;
 * - every fill/select value and upload file is a `{{param}}` named from its field (`paramName`, deduped with `_2`); a
 *   password / cc-* / one-time-code field's param is secret, and its value is not even hashed; a select's value is its
 *   visible option text (never the hidden `value`);
 * - the no-value rules of `buildPlan`: a click target or scope whose text contains a typed value (this page's, or an
 *   earlier page's by `RecordEcho` hash) becomes that value's `{{param}}`; a click on an option-like role becomes a new
 *   `{{param}}` and its text is remembered like a typed value; a field whose name contains a value is stored by role only;
 * - each event carries the params it allocated and hashed echoes of its non-secret values (for later pages).
 */
export function startRecorder(win: Window, state: RecorderState, emit: (e: RecordedEvent) => void): Recorder {
  const doc = win.document
  const used = new Set(state.used)
  let remote: RecordEcho[] = [...state.echoes]
  let salt = state.salt
  /** This page's values, secrets included, in comparison form. Never sent anywhere. */
  const local: { norm: string; param: string }[] = []
  /** The last value recorded per field, so a blur after Enter does not record it twice. Never sent. */
  const committed = new WeakMap<Element, string>()
  /** A click that may have opened a file chooser: it becomes the target of the upload that follows. */
  let opener: { el: Element; input: HTMLInputElement } | null = null
  /** The control a label click is about to click again. */
  let echoClick: Element | null = null
  /** The form an Enter was just recorded in: its implicit submission clicks the submit button, which is not recorded. */
  let enterIn: { form: HTMLFormElement | null; at: number } | null = null

  const hit = (text: string): { param: string } | undefined => {
    const n = normEcho(text)
    let best: { norm: string; param: string } | undefined
    for (const e of local) if (n.includes(e.norm) && (!best || e.norm.length > best.norm.length)) best = e
    const far = findEcho(text, remote, salt)
    return far && (!best || far.n > best.norm.length) ? far : best
  }
  const echoed = (text: string): boolean => !!hit(text)

  const newParam = (label: string, secret: boolean, into: PlanParam[]): string => {
    const base = paramName(label)
    let name = base
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`
    used.add(name)
    into.push({ name, secret })
    return name
  }

  const send = (step: PlanStep, params: PlanParam[] = [], echoes: RecordEcho[] = []): void => emit({ step, params, echoes })
  /** Remembers a value (in-page) under `param`; its salted hash for later pages unless it is secret. */
  const remember = (value: string, param: string, secret: boolean, into: RecordEcho[]): void => {
    const norm = normEcho(value)
    if (norm.length < MIN_ECHO) return
    local.push({ norm, param })
    const e = secret ? undefined : echoEntry(value, param, salt)
    if (e) into.push(e)
  }

  /** A field's target: by name, or by role only when its name contains a value (its own included). */
  const fieldTarget = (el: Element): { target: PlanTarget; label: string } => {
    const text = nameOf(el)
    const role = roleOf(el) ?? "textbox"
    const within = scopeName(el)
    const w = within && !echoed(within) ? { within } : {}
    if (!text || echoed(text)) return { target: { role, ...w }, label: role }
    return { target: { text, role, ...w }, label: text }
  }

  /** Records a field whose value(s) the person set: `values` are remembered (in-page) before the target is named. */
  const recordField = (
    el: Element,
    src: Element,
    values: string[],
    make: (target: PlanTarget, param: string) => PlanStep,
  ): void => {
    const secret = isSecretField(el)
    const mine = values.map(normEcho).filter((v) => v.length >= MIN_ECHO).map((norm) => ({ norm, param: "" }))
    local.push(...mine)
    const { target, label } = fieldTarget(src)
    const params: PlanParam[] = []
    const name = newParam(label, secret, params)
    for (const m of mine) m.param = name
    const echoes = secret ? [] : values.map((v) => echoEntry(v, name, salt)).filter((e): e is RecordEcho => !!e)
    send(make(target, name), params, echoes)
  }

  const commitText = (el: TextField): void => {
    if (committed.get(el) === el.value) return
    committed.set(el, el.value)
    recordField(el, el, [el.value], (target, p) => ({ action: "fill", target, value: `{{${p}}}` }) as PlanStep)
  }

  const commitSelect = (el: HTMLSelectElement): void => {
    const opt = el.selectedOptions[0]
    const key = opt ? `${opt.index}` : ""
    if (committed.get(el) === key) return
    committed.set(el, key)
    // the visible text only: a hidden code ("dev", "new") would match unrelated labels later
    const values = opt ? [opt.label || opt.text] : []
    recordField(el, el, values, (target, p) => ({ action: "select", target, value: `{{${p}}}` }) as PlanStep)
  }

  const recordUpload = (input: HTMLInputElement): void => {
    const names = Array.from(input.files ?? [], (f) => f.name)
    const src = opener?.input === input ? opener.el : input
    opener = null
    if (!names.length) return
    recordField(input, src, names, (target, p) => ({ action: "upload", target, files: [`{{${p}}}`] }) as PlanStep)
  }

  /** A click's target with value-echoing text and option picks turned into params; null for an unnamed element. */
  const clickTarget = (el: Element, params: PlanParam[], echoes: RecordEcho[]): PlanTarget | null => {
    const name = nameOf(el)
    const role = roleOf(el)
    if (!name || !role) return null
    const within = scopeName(el)
    const e = hit(name)
    let text = name
    if (e) text = `{{${e.param}}}`
    else if (CHOICE_ROLES.has(role)) {
      const box = el.parentElement?.closest(CHOICE_BOX)
      const boxName = box ? nameOf(box) : ""
      const label = boxName && !echoed(boxName) ? boxName : within && !echoed(within) ? within : role
      const p = newParam(label, false, params)
      text = `{{${p}}}`
      remember(name, p, false, echoes) // the picked text is a value: never stored where it shows up later
    }
    const w = within ? hit(within) : undefined
    return { text, role, ...(within ? { within: w ? `{{${w.param}}}` : within } : {}) }
  }

  const recordClick = (el: Element): void => {
    const params: PlanParam[] = []
    const echoes: RecordEcho[] = []
    const target = clickTarget(el, params, echoes)
    if (!target) return
    send({ action: "click", target } as PlanStep, params, echoes)
  }

  /** A held chooser-opening click that turned out not to open one (another event came first): record it as a click. */
  const flushOpener = (): void => {
    const o = opener
    opener = null
    if (o && o.el !== o.input) recordClick(o.el)
  }

  const onClick = (e: MouseEvent): void => {
    if (!e.isTrusted || !(e.target instanceof Element)) return
    const t = e.target
    if (echoClick && t === echoClick) {
      echoClick = null
      return
    }
    const label = t.closest("label")
    const control = label?.control
    if (control && control !== t && !control.contains(t)) {
      // the browser clicks the label's control next: record that control once, here
      if (isFileInput(control)) {
        flushOpener()
        opener = { el: control, input: control }
      } else if (!isTextField(control) && !(control instanceof HTMLSelectElement)) {
        flushOpener()
        recordClick(control)
        echoClick = control
        win.setTimeout(() => (echoClick = null), 0)
      }
      return
    }
    let el: Element | null = null
    for (let n: Element | null = t; n; n = n.parentElement) {
      if (isTextField(n) || n instanceof HTMLSelectElement || n instanceof HTMLOptionElement) return
      if (n instanceof HTMLElement && n.isContentEditable) return
      const role = roleOf(n)
      if (role && CLICK_ROLES.has(role)) {
        el = n
        break
      }
    }
    if (!el) return
    if (e.detail === 0 && enterIn && Date.now() - enterIn.at < IMPLICIT_CLICK_MS && isSubmitOf(el, enterIn.form)) {
      enterIn = null
      return
    }
    flushOpener()
    const input = fileInputFor(el)
    if (input) {
      opener = { el, input } // held until a file is chosen (upload), the chooser is cancelled, or something else happens
      return
    }
    recordClick(el)
  }

  const onChange = (e: Event): void => {
    const t = e.target
    if (!e.isTrusted || !(t instanceof Element)) return
    if (isFileInput(t)) return recordUpload(t)
    flushOpener()
    if (isTextField(t)) commitText(t)
    else if (t instanceof HTMLSelectElement) commitSelect(t)
    else if (t instanceof HTMLInputElement && UNRECORDED_TYPES.has(t.type)) {
      const name = nameOf(t)
      emit({ step: null, params: [], echoes: [], skipped: `${t.type} input ${name && !echoed(name) ? `'${name}'` : "(unnamed)"}` })
    }
  }

  const onCancel = (e: Event): void => {
    if (e.isTrusted && opener && e.target === opener.input) opener = null
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!e.isTrusted || e.key !== "Enter" || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const t = e.target
    if (!(t instanceof HTMLInputElement) || !isTextField(t)) return
    flushOpener()
    commitText(t)
    enterIn = { form: t.form, at: Date.now() }
    send({ action: "press", key: "Enter" })
  }

  const onPageHide = (): void => flushOpener()

  const listeners: [string, (e: never) => void][] = [
    ["click", onClick],
    ["change", onChange],
    ["cancel", onCancel],
    ["keydown", onKeyDown],
  ]
  for (const [type, fn] of listeners) doc.addEventListener(type, fn as EventListener, true)
  win.addEventListener("pagehide", onPageHide)

  return {
    update(next) {
      for (const n of next.used) used.add(n)
      remote = [...next.echoes]
      salt = next.salt
    },
    stop() {
      for (const [type, fn] of listeners) doc.removeEventListener(type, fn as EventListener, true)
      win.removeEventListener("pagehide", onPageHide)
      opener = null
    },
  }
}
