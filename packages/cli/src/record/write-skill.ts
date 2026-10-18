import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { BATCH_MAX_STEPS, RECORD_NAME_RE, pathPattern, type Plan, type PlanParam, type PlanStep, type Recording } from "@kitestring/protocol"
import { skillBackupPath } from "../init/init.js"
import { agentsSkillsDir, claudeSkillsDir, linkState } from "../init/skills.js"
import { kiteHome as defaultKiteHome } from "../paths.js"
import { listPlans, savePlan } from "../memory/store.js"

const PARAM = /^\{\{[a-z0-9_]+\}\}$/
const PLACEHOLDER = /\{\{([a-z0-9_]+)\}\}/g
const SUMMARY_STEPS = 4

export interface WriteSkillOptions {
  /** Replace an existing skill folder (moved to `~/.agents/kite-backups/skills/` first) or a foreign Claude link. */
  force: boolean
  /** Where plans live (default `$KITE_HOME`). */
  kiteHome?: string
  now?: Date
}

/** What the person would have to move aside: the skill folder, or something at the Claude link that is not our link. */
function conflicts(dir: string, link: string): string[] {
  const out: string[] = []
  if (existsSync(dir) || isLink(dir)) out.push(dir)
  const state = linkState(link, dir)
  if (state === "not-symlink" || state === "other-symlink") out.push(link)
  return out
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/** The skill folder for a recording name: `<home>/.agents/skills/kite-<name>`. */
export const skillDirFor = (home: string, name: string): string => join(agentsSkillsDir(home), `kite-${name}`)

/**
 * After a save updated plan `id` (`<site>/<slug>`): a note that the recorded skill `kite-<slug>` for it (its SKILL.md names
 * the plan's origin) still shows the old steps, or undefined when there is no such skill.
 */
export function staleSkillNote(home: string, id: string, origin: string): string | undefined {
  const slug = id.split("/")[1] ?? id
  const path = join(skillDirFor(home, slug), "SKILL.md")
  let md: string
  try {
    md = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  if (!md.includes(origin)) return undefined
  return `skill ${path} is now out of date: re-record it (kite record start --name ${slug}, then kite record stop --force)`
}

/** Throws (without writing anything) when the skill would replace something and `force` is not set. */
export function checkSkillTarget(home: string, name: string, force: boolean): void {
  if (!RECORD_NAME_RE.test(name)) throw new Error(`invalid recording name ${JSON.stringify(name)}: use a lowercase slug like ada-signup`)
  const dir = skillDirFor(home, name)
  const found = conflicts(dir, join(claudeSkillsDir(home), `kite-${name}`))
  if (found.length && !force) throw new Error(`${found.join(" and ")} exists: pass --force to replace it (the old one is backed up)`)
}

function moveAside(path: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  renameSync(path, to)
}

/** Refuses a recording with anything but a `{{param}}` where a value goes (defense in depth: the page parameterizes). */
function assertNoValues(steps: PlanStep[]): void {
  steps.forEach((s, i) => {
    const literal =
      ((s.action === "fill" || s.action === "select") && !PARAM.test(s.value)) ||
      (s.action === "upload" && !s.files.every((f) => PARAM.test(f))) ||
      (s.action === "press" && s.key.length === 1)
    if (literal) throw new Error(`refusing to store step ${i + 1} (${s.action}): it holds a literal value, not a {{param}}`)
    if ("target" in s && typeof s.target === "object" && "ref" in s.target) throw new Error(`refusing to store step ${i + 1}: an @ref target`)
  })
}

/** Params in order of first use; secret when the recorder marked them. */
function paramsOf(steps: PlanStep[], secrets: string[]): PlanParam[] {
  const names: string[] = []
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(PLACEHOLDER)) if (!names.includes(m[1]!)) names.push(m[1]!)
    } else if (Array.isArray(v)) v.forEach(visit)
    else if (v && typeof v === "object") Object.values(v).forEach(visit)
  }
  steps.forEach(visit)
  return names.map((name) => ({ name, secret: secrets.includes(name) }))
}

const chunk = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

function describeStep(s: PlanStep): string {
  if ("target" in s && typeof s.target === "object") {
    const t = s.target as { text?: string; role?: string }
    return `${s.action} ${t.text ?? t.role ?? ""}`.trim()
  }
  if (s.action === "press") return `press ${s.key}`
  if (s.action === "goto") return "goto"
  return s.action
}

function summary(steps: PlanStep[]): string {
  const shown = steps.slice(0, SUMMARY_STEPS).map(describeStep).join(", ")
  return `a recorded ${steps.length}-step task (${shown}${steps.length > SUMMARY_STEPS ? ", …" : ""})`
}

function skillMarkdown(rec: Recording, plan: Plan, planSlug: string): string {
  const u = new URL(rec.url)
  const words = rec.name.replace(/-/g, " ")
  const start = plan.origin + plan.pathPattern
  const description = `Replays ${summary(rec.steps)} on ${u.origin} with Kitestring. Use when the user asks to ${words} on ${u.host}.`
  const args = plan.params.map((p) => `${p.secret ? "--secret" : "--param"} ${p.name}=…`).join(" ")
  /** Params that are upload files (replay takes absolute paths only). */
  const uploads = [...new Set(rec.steps.flatMap((s) => (s.action === "upload" ? s.files.map((f) => f.slice(2, -2)) : [])))]
  const roleOnly = rec.steps.some((s) => "target" in s && typeof s.target === "object" && !("text" in s.target))
  const startLine = plan.pathPattern.includes("*")
    ? `Start on a page matching ${start} (each \`*\` is an id).`
    : `Start on ${start}: \`kite goto ${start}\` unless the tab is already there.`
  const blocks = plan.batches.map((b, i) =>
    [
      ...(plan.batches.length > 1 ? [`Batch ${i + 1} of ${plan.batches.length}:`, ""] : []),
      "```json",
      "[",
      b.map((s) => `  ${JSON.stringify(s)}`).join(",\n"),
      "]",
      "```",
    ].join("\n"),
  )
  return [
    "---",
    `name: kite-${rec.name}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${words}`,
    "",
    `Recorded once with \`kite record\` on ${start}. Kitestring replays it in the user's own Chrome. No typed value was stored: you supply every parameter on each run.`,
    "",
    "## When to use",
    "",
    `Use when the user asks to ${words} on ${u.host}. ${startLine}`,
    "",
    "## Parameters",
    "",
    ...(plan.params.length
      ? [
          "| name | secret |",
          "|---|---|",
          ...plan.params.map((p) => `| \`${p.name}\` | ${p.secret ? "yes" : "no"} |`),
          "",
          "Ask the user for any value you do not know. Pass a secret with `--secret`, never `--param`, and never repeat it back.",
          ...uploads.map((n) => `\`${n}\` is a file to upload: give its absolute path (e.g. \`/Users/me/icon.png\`).`),
        ]
      : ["None."]),
    "",
    "## Run it",
    "",
    "```sh",
    `kite run ${planSlug}${args ? ` ${args}` : ""}`,
    "```",
    "",
    "`kite run` stops at the first step that no longer works (a renamed field, a new required field, a risky button) and leaves the page there: take over from the step it names.",
    "",
    "## Fallback: kite batch",
    "",
    "If the plan is gone, send these steps with `kite batch -`. You fill each `{{param}}` with its value first; nothing is stored.",
    ...(roleOnly
      ? ["", "A step whose target has no `text` is a field whose label matched a typed value: find that field yourself (`kite snapshot`) and send it with its name."]
      : []),
    "",
    ...blocks.flatMap((b) => [b, ""]),
  ].join("\n")
}

/**
 * Validates a recording for `writeSkill` and builds its plan, writing nothing. Throws when:
 * - the name is not a slug, the URL does not parse, or nothing was recorded;
 * - a value slot holds anything but a `{{param}}` (defense in depth: the page parameterizes);
 * - without `force`: the skill folder (or a foreign file at the Claude link) exists, or a plan with the same intent is
 *   already stored for the origin (saving would merge into it).
 */
export function prepareSkill(home: string, rec: Recording, opts: WriteSkillOptions): Plan {
  checkSkillTarget(home, rec.name, opts.force)
  let u: URL
  try {
    u = new URL(rec.url)
  } catch {
    throw new Error(`recording has no page URL: ${JSON.stringify(rec.url)}`)
  }
  if (!rec.steps.length) throw new Error("nothing was recorded")
  assertNoValues(rec.steps)
  const intent = rec.name.replace(/-/g, " ")
  const same = listPlans(opts.kiteHome ?? defaultKiteHome(), u.origin).find((s) => s.plan.intent === intent)
  if (same && !opts.force) {
    throw new Error(`plan ${same.id} ("${intent}") already exists: pass --force to replace its steps, or run kite memory forget ${same.id}`)
  }
  return {
    version: 1,
    intent,
    origin: u.origin,
    pathPattern: pathPattern(rec.url),
    params: paramsOf(rec.steps, rec.secrets),
    batches: chunk(rec.steps, BATCH_MAX_STEPS),
    createdAt: (opts.now ?? new Date()).toISOString(),
    runs: 0,
    lastOk: null,
  }
}

/**
 * Turns a recording into a skill and a plan:
 * `<home>/.agents/skills/kite-<name>/SKILL.md`, a `<home>/.claude/skills/kite-<name>` symlink to that folder (as `kite init`
 * links its skills), and the plan in `$KITE_HOME/memory`. Order: validate everything (`prepareSkill`; nothing written on
 * refusal), save the plan, then move an existing folder (or a foreign file at the link) to
 * `<home>/.agents/kite-backups/skills/` (only with `force`) and write the new one. If writing the skill fails, the plan
 * file is put back as it was (removed, or the replaced plan restored) before the error is rethrown.
 */
export function writeSkill(home: string, rec: Recording, opts: WriteSkillOptions): { skillPath: string; planSlug: string } {
  const plan = prepareSkill(home, rec, opts)
  const now = opts.now ?? new Date()
  const kh = opts.kiteHome ?? defaultKiteHome()
  // what a forced save replaces, so a failed skill write can put it back
  const prev = listPlans(kh, plan.origin).find((s) => s.plan.intent === plan.intent)
  const prevFile = prev && join(kh, "memory", `${prev.id}.json`)
  const prevText = prevFile && readFileSync(prevFile, "utf8")
  const planFile = savePlan(kh, plan)
  try {
    return writeSkillFiles(home, rec, plan, basename(planFile, ".json"), now)
  } catch (e) {
    if (prevFile && prevText !== undefined) writeFileSync(prevFile, prevText, { mode: 0o600 })
    else rmSync(planFile, { force: true })
    throw e
  }
}

function writeSkillFiles(home: string, rec: Recording, plan: Plan, planSlug: string, now: Date): { skillPath: string; planSlug: string } {
  const dir = skillDirFor(home, rec.name)
  const link = join(claudeSkillsDir(home), `kite-${rec.name}`)
  if (existsSync(dir) || isLink(dir)) moveAside(dir, skillBackupPath(home, `kite-${rec.name}`, now))
  const state = linkState(link, dir)
  if (state === "not-symlink") moveAside(link, skillBackupPath(home, `kite-${rec.name}.claude-link`, now))
  else if (state === "other-symlink") unlinkSync(link)

  mkdirSync(dir, { recursive: true })
  const skillPath = join(dir, "SKILL.md")
  writeFileSync(skillPath, skillMarkdown(rec, plan, planSlug))
  if (linkState(link, dir) !== "ours") {
    mkdirSync(dirname(link), { recursive: true })
    rmSync(link, { force: true })
    symlinkSync(dir, link)
  }
  return { skillPath, planSlug }
}
