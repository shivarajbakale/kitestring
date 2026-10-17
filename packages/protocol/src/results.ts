export type Status =
  | "done"
  | "not_found"
  | "ambiguous"
  | "blocked"
  | "disabled"
  | "no_effect"
  | "timeout"
  | "restricted"
  | "error"

export interface Diff {
  added: string[]
  removed: string[]
}

export interface Candidate {
  ref: string
  line: string
  score: number
}

export interface ActionResult {
  ok: boolean
  status: Status
  detail?: string
  diff: Diff
  navigation?: { url: string; title: string }
  newTabs?: number[]
  errors?: string[]
  candidates?: Candidate[]
  blockedBy?: string
  page: string
}
