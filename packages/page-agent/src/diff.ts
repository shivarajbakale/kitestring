export interface Diff {
  added: string[]
  removed: string[]
}

function lines(snap: string): string[] {
  const all = snap.split("\n")
  if (all[0]?.startsWith('page "')) all.shift()
  return all.map((l) => l.trim()).filter((l) => l !== "")
}

function minus(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>()
  for (const l of b) counts.set(l, (counts.get(l) ?? 0) + 1)
  const out: string[] = []
  for (const l of a) {
    const n = counts.get(l) ?? 0
    if (n > 0) counts.set(l, n - 1)
    else out.push(l)
  }
  return out
}

/** Line-multiset difference between two snapshots, ignoring the header and indentation. */
export function diffSnapshots(before: string, after: string): Diff {
  const b = lines(before)
  const a = lines(after)
  return { added: minus(a, b), removed: minus(b, a) }
}
