const MAX_ANCESTORS = 5
const MAX_CANDIDATES = 3

function isFileInput(el: Element | null | undefined): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.type === "file"
}

function depth(el: Element): number {
  let d = 0
  for (let p = el.parentElement; p; p = p.parentElement) d++
  return d
}

/** Steps between two elements through their closest common ancestor. */
function distance(a: Element, b: Element): number {
  const seen = new Map<Element, number>()
  let steps = 0
  for (let p: Element | null = a; p; p = p.parentElement) seen.set(p, steps++)
  steps = 0
  for (let p: Element | null = b; p; p = p.parentElement, steps++) {
    const up = seen.get(p)
    if (up !== undefined) return up + steps
  }
  return depth(a) + depth(b)
}

function isRendered(el: Element): boolean {
  const r = el.getBoundingClientRect()
  return r.width >= 2 && r.height >= 2
}

/**
 * Is `input` already someone else's? A rendered input is a control in its own right, and an input
 * sitting closer to another button is that button's. Inputs inside `el` are always `el`'s.
 */
function claimedByOther(el: Element, input: HTMLInputElement, scope: Element): boolean {
  if (el.contains(input)) return false
  if (isRendered(input)) return true
  const mine = distance(el, input)
  for (const other of Array.from(scope.querySelectorAll("button, [role=button], a[href], input, select, textarea"))) {
    if (other === el || other === input || el.contains(other) || other.contains(el) || other.contains(input)) continue
    if (distance(other, input) < mine) return true
  }
  return false
}

/**
 * Among inputs equally near to `el`: a flat row of `button input button input` pairs each button with
 * the input after it (`input button input button`, with the one before).
 */
function paired(el: Element, ties: HTMLInputElement[], scope: Element): HTMLInputElement | null {
  const seq = Array.from(scope.querySelectorAll("button, [role=button], input[type=file]")).filter(
    (e) => !isFileInput(e) || ties.includes(e),
  )
  const i = seq.indexOf(el)
  const n = seq[isFileInput(seq[0]) ? i - 1 : i + 1]
  return i >= 0 && isFileInput(n) && ties.includes(n) ? n : null
}

/**
 * The file input a click on `el` would feed: `el` itself; the control of its label (for= or wrapping);
 * else the input nearest to it inside the closest ancestor (at most 5 up) that holds 1..3 file inputs.
 * An ancestor holding more than 3 is ambiguous, so the answer is null. Inputs that belong to something
 * else (rendered on their own, or nearer to another button) are not offered to `el`: a drop zone next to
 * other upload controls must not steal their inputs.
 */
export function fileInputFor(el: Element): HTMLInputElement | null {
  if (isFileInput(el)) return el
  const control = (el.closest("label") as HTMLLabelElement | null)?.control
  if (isFileInput(control)) return control
  let anc = el.parentElement
  for (let i = 0; i < MAX_ANCESTORS && anc; i++, anc = anc.parentElement) {
    const inputs = Array.from(anc.querySelectorAll<HTMLInputElement>("input[type=file]"))
    if (inputs.length === 0) continue
    if (inputs.length > MAX_CANDIDATES) return null
    const free = inputs.filter((c) => !claimedByOther(el, c, anc!))
    if (free.length === 0) continue
    const near = Math.min(...free.map((c) => distance(el, c)))
    const ties = free.filter((c) => distance(el, c) === near)
    return ties.length > 1 ? (paired(el, ties, anc) ?? ties[0]!) : ties[0]!
  }
  return null
}

const names = (input: HTMLInputElement): string[] => Array.from(input.files ?? [], (f) => f.name)

/** Names a watched input held when it dispatched its first input/change event after the watch. */
const dispatched = new WeakMap<HTMLInputElement, string[]>()
const unwatch = new WeakMap<HTMLInputElement, () => void>()

/**
 * Records the input's file names at the first input/change event it dispatches from now on. The
 * listener is a capture-phase one on the window, so it runs before any page listener that clears
 * `value` after reading the files. One-shot; a new watch replaces the old one and its record.
 */
export function watchFileInput(el: Element | null): boolean {
  if (!isFileInput(el)) return false
  unwatch.get(el)?.()
  dispatched.delete(el)
  const win = el.ownerDocument.defaultView!
  const on = (e: Event) => {
    if (e.composedPath()[0] !== el) return
    dispatched.set(el, names(el))
    off()
  }
  const off = () => {
    win.removeEventListener("input", on, true)
    win.removeEventListener("change", on, true)
    unwatch.delete(el)
  }
  win.addEventListener("input", on, true)
  win.addEventListener("change", on, true)
  unwatch.set(el, off)
  return true
}

/**
 * File names selected in the input: as recorded at dispatch by watchFileInput (the page may clear the
 * input in its change handler), else the live `input.files`. Null if `el` is not a file input.
 */
export function fileNames(el: Element | null): string[] | null {
  return isFileInput(el) ? (dispatched.get(el) ?? names(el)) : null
}
