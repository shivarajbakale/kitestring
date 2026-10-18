import { spawn } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Recording } from "@kitestring/protocol"
import { startDaemon, type Daemon } from "../src/host/daemon.js"
import { listPlans } from "../src/memory/store.js"
import { writeSkill } from "../src/record/write-skill.js"

let home: string
let kh: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kiteskill-"))
  kh = join(home, ".kitestring")
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const REC: Recording = {
  name: "ada-signup",
  url: "http://127.0.0.1:4173/basic-form?ref=mail",
  steps: [
    { action: "fill", target: { text: "Name", role: "textbox", within: "Basic form" }, value: "{{name}}" },
    { action: "fill", target: { text: "Email", role: "textbox", within: "Basic form" }, value: "{{email}}" },
    { action: "click", target: { text: "Submit", role: "button", within: "Basic form" } },
  ],
  secrets: [],
  skipped: [],
}

const LOGIN: Recording = {
  name: "sign-in",
  url: "https://app.example.com/login",
  steps: [
    { action: "fill", target: { text: "Username", role: "textbox" }, value: "{{username}}" },
    { action: "fill", target: { text: "Password", role: "textbox" }, value: "{{password}}" },
    { action: "click", target: { text: "Sign in", role: "button" }, expect: { url: "/home" } },
  ],
  secrets: ["password"],
  skipped: [],
}

const skillDir = (name: string) => join(home, ".agents", "skills", `kite-${name}`)

describe("writeSkill", () => {
  it("writes SKILL.md with the exact frontmatter, links it for Claude and saves the plan", () => {
    const r = writeSkill(home, REC, { force: false, kiteHome: kh })
    expect(r).toEqual({ skillPath: join(skillDir("ada-signup"), "SKILL.md"), planSlug: "ada-signup" })
    const md = readFileSync(r.skillPath, "utf8")
    expect(md.split("\n").slice(0, 4).join("\n")).toBe(
      [
        "---",
        "name: kite-ada-signup",
        'description: "Replays a recorded 3-step task (fill Name, fill Email, click Submit) on http://127.0.0.1:4173 with Kitestring. Use when the user asks to ada signup on 127.0.0.1:4173."',
        "---",
      ].join("\n"),
    )
    const link = join(home, ".claude", "skills", "kite-ada-signup")
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(skillDir("ada-signup"))

    const [stored] = listPlans(kh)
    expect(stored!.id).toBe("127-0-0-1-4173/ada-signup")
    expect(stored!.plan).toMatchObject({
      version: 1,
      intent: "ada signup",
      origin: "http://127.0.0.1:4173",
      pathPattern: "/basic-form",
      params: [{ name: "name", secret: false }, { name: "email", secret: false }],
      batches: [REC.steps],
      runs: 0,
      lastOk: null,
    })
  })

  it("shows kite run first and the kite batch JSON with {{param}} placeholders as the fallback (R2)", () => {
    const md = readFileSync(writeSkill(home, LOGIN, { force: false, kiteHome: kh }).skillPath, "utf8")
    const run = md.indexOf("kite run sign-in --param username=… --secret password=…")
    const json = md.indexOf("```json")
    expect(run).toBeGreaterThan(0)
    expect(json).toBeGreaterThan(run)
    expect(md).toContain("| `username` | no |")
    expect(md).toContain("| `password` | yes |")
    expect(md).toContain("kite goto https://app.example.com/login")
    const block = md.slice(json + "```json".length, md.indexOf("```", json + 7)).trim()
    expect(JSON.parse(block)).toEqual(LOGIN.steps)
    expect(md).toMatch(/fill .*\{\{param\}\}|\{\{param\}\}.*fill/i)
  })

  it("refuses an existing skill folder without force; with force it backs the folder up first", () => {
    writeSkill(home, REC, { force: false, kiteHome: kh })
    writeFileSync(join(skillDir("ada-signup"), "notes.txt"), "mine")
    expect(() => writeSkill(home, REC, { force: false, kiteHome: kh })).toThrow(/kite-ada-signup exists.*--force/)
    expect(readFileSync(join(skillDir("ada-signup"), "notes.txt"), "utf8")).toBe("mine")

    writeSkill(home, REC, { force: true, kiteHome: kh })
    expect(existsSync(join(skillDir("ada-signup"), "notes.txt"))).toBe(false)
    const backups = readdirSync(join(home, ".agents", "kite-backups", "skills"))
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(/^kite-ada-signup\.kite-backup-/)
    expect(readFileSync(join(home, ".agents", "kite-backups", "skills", backups[0]!, "notes.txt"), "utf8")).toBe("mine")
    expect(lstatSync(join(home, ".claude", "skills", "kite-ada-signup")).isSymbolicLink()).toBe(true)
  })

  it("refuses a real folder where the Claude link goes, unless forced", () => {
    mkdirSync(join(home, ".claude", "skills", "kite-ada-signup"), { recursive: true })
    expect(() => writeSkill(home, REC, { force: false, kiteHome: kh })).toThrow(/--force/)
    expect(existsSync(skillDir("ada-signup"))).toBe(false)
    expect(listPlans(kh)).toEqual([])
    writeSkill(home, REC, { force: true, kiteHome: kh })
    expect(lstatSync(join(home, ".claude", "skills", "kite-ada-signup")).isSymbolicLink()).toBe(true)
  })

  it("never writes a literal value: a recording with one is refused", () => {
    const leaky: Recording = { ...REC, steps: [{ action: "fill", target: { text: "Name", role: "textbox" }, value: "Ada" }] }
    expect(() => writeSkill(home, leaky, { force: false, kiteHome: kh })).toThrow(/literal value/)
    const leakyFile: Recording = { ...REC, steps: [{ action: "upload", target: { text: "Zip", role: "button" }, files: ["/tmp/a.zip"] }] }
    expect(() => writeSkill(home, leakyFile, { force: false, kiteHome: kh })).toThrow(/literal value/)
    expect(existsSync(skillDir("ada-signup"))).toBe(false)
  })

  it("refuses to merge into a stored plan with the same intent unless forced, leaving everything as it was", () => {
    writeSkill(home, REC, { force: false, kiteHome: kh })
    rmSync(skillDir("ada-signup"), { recursive: true })
    rmSync(join(home, ".claude", "skills", "kite-ada-signup"))
    expect(() => writeSkill(home, REC, { force: false, kiteHome: kh })).toThrow(
      /plan 127-0-0-1-4173\/ada-signup \("ada signup"\) already exists: pass --force .*kite memory forget/,
    )
    expect(existsSync(skillDir("ada-signup"))).toBe(false)
    writeSkill(home, REC, { force: true, kiteHome: kh })
    expect(listPlans(kh)).toHaveLength(1)
  })

  it("saves the plan before touching the old skill: a failed save leaves the old folder in place", () => {
    writeSkill(home, REC, { force: false, kiteHome: kh })
    writeFileSync(join(skillDir("ada-signup"), "notes.txt"), "mine")
    const blocked = join(home, "not-a-dir")
    writeFileSync(blocked, "x") // memory cannot be created under a file
    expect(() => writeSkill(home, REC, { force: true, kiteHome: blocked })).toThrow()
    expect(readFileSync(join(skillDir("ada-signup"), "notes.txt"), "utf8")).toBe("mine")
    expect(existsSync(join(home, ".agents", "kite-backups"))).toBe(false)
  })

  it("a failed skill write leaves no new plan behind, and a forced one puts the old plan back", () => {
    mkdirSync(join(home, ".agents"), { recursive: true })
    writeFileSync(join(home, ".agents", "skills"), "x") // the skill folder cannot be created under a file
    expect(() => writeSkill(home, REC, { force: false, kiteHome: kh })).toThrow()
    expect(listPlans(kh)).toEqual([])

    rmSync(join(home, ".agents", "skills"))
    writeSkill(home, REC, { force: false, kiteHome: kh })
    const file = join(kh, "memory", "127-0-0-1-4173", "ada-signup.json")
    const before = readFileSync(file, "utf8")
    rmSync(join(home, ".agents", "skills"), { recursive: true })
    writeFileSync(join(home, ".agents", "skills"), "x")
    const changed: Recording = { ...REC, steps: REC.steps.slice(0, 1) }
    expect(() => writeSkill(home, changed, { force: true, kiteHome: kh })).toThrow()
    expect(readFileSync(file, "utf8")).toBe(before)
  })

  it("a failed write after the old skill folder was moved aside moves it back", () => {
    writeSkill(home, REC, { force: false, kiteHome: kh })
    writeFileSync(join(skillDir("ada-signup"), "notes.txt"), "mine")
    // the Claude link's parent is a file: the new folder is written, then linking it fails
    rmSync(join(home, ".claude"), { recursive: true, force: true })
    writeFileSync(join(home, ".claude"), "x")
    expect(() => writeSkill(home, REC, { force: true, kiteHome: kh })).toThrow()
    expect(readFileSync(join(skillDir("ada-signup"), "notes.txt"), "utf8")).toBe("mine")
    expect(readdirSync(join(home, ".agents", "kite-backups", "skills"))).toEqual([])
  })

  it("tells the agent an upload param is an absolute path", () => {
    const up: Recording = {
      ...REC,
      steps: [{ action: "upload", target: { text: "Package", role: "button" }, files: ["{{package}}"] }],
    }
    const md = readFileSync(writeSkill(home, up, { force: false, kiteHome: kh }).skillPath, "utf8")
    expect(md).toContain("`package` is a file to upload: give its absolute path")
  })

  it("rejects a name that is not a slug", () => {
    expect(() => writeSkill(home, { ...REC, name: "../x" }, { force: false, kiteHome: kh })).toThrow(/name/)
  })
})

// ---- the kite record commands, against a fake extension ----

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js")
let daemon: Daemon | undefined
let received: any[]
let answers: unknown[]
afterEach(async () => {
  await daemon?.close()
  daemon = undefined
})

async function startFake(): Promise<void> {
  received = []
  answers = []
  const d: Daemon = await startDaemon({
    socketPath: join(kh, "kite.sock"),
    toExtension: (msg: any) => {
      received.push(msg)
      const result = answers.shift() ?? null
      queueMicrotask(() => d.fromExtension({ id: msg.id, result }))
    },
  })
  daemon = d
}

function kite(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, KITE_SESSION: "", KITE_HOME: kh, HOME: home } })
    let out = ""
    let err = ""
    p.stdout.on("data", (d) => (out += d))
    p.stderr.on("data", (d) => (err += d))
    p.on("close", (code) => resolve({ code, out, err }))
  })
}

describe("kite record", () => {
  it("start sends record.start {name}; stop writes the skill and the plan", async () => {
    mkdirSync(kh, { recursive: true })
    await startFake()
    answers.push({ name: "ada-signup", tab: 7, url: REC.url })
    const s = await kite(["record", "start", "--name", "ada-signup"])
    expect(s.code, s.err).toBe(0)
    expect(received[0]).toMatchObject({ method: "record.start", params: { name: "ada-signup" } })
    expect(s.out).toContain("kite record stop")

    answers.push(REC, REC) // the peek, then the stop
    const t = await kite(["record", "stop"])
    expect(t.code, t.err).toBe(0)
    expect(received.slice(1).map((m) => m.params)).toEqual([{ peek: true }, {}])
    expect(t.out).toContain("kite-ada-signup")
    expect(existsSync(join(skillDir("ada-signup"), "SKILL.md"))).toBe(true)
    expect(listPlans(kh).map((p) => p.id)).toEqual(["127-0-0-1-4173/ada-signup"])
  })

  it("stop warns about each field it could not record, by name only", async () => {
    mkdirSync(kh, { recursive: true })
    await startFake()
    const rec = { ...REC, skipped: ["date input 'Birthday'", "color input 'Theme'"] }
    answers.push(rec, rec)
    const t = await kite(["record", "stop"])
    expect(t.code, t.err).toBe(0)
    expect(t.err).toBe(
      "kite: warning: not recorded: date input 'Birthday' (set it by hand when replaying)\n" +
        "kite: warning: not recorded: color input 'Theme' (set it by hand when replaying)\n",
    )
  })

  it("stop strips control characters from page-derived names before printing them", async () => {
    mkdirSync(kh, { recursive: true })
    await startFake()
    const rec = { ...REC, skipped: ["date input '\u001b[31mBirth\u0007day\u001b[0m'"] }
    answers.push(rec, rec)
    const t = await kite(["record", "stop"])
    expect(t.code, t.err).toBe(0)
    expect(t.err).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/)
    expect(t.err).toContain("date input '[31mBirthday[0m'")
  })

  it("stop writes the skill before it ends the recording: a failed write leaves the recording in the browser", async () => {
    mkdirSync(join(home, ".agents"), { recursive: true })
    writeFileSync(join(home, ".agents", "skills"), "x") // the skill folder cannot be created
    mkdirSync(kh, { recursive: true })
    await startFake()
    answers.push(REC)
    const r = await kite(["record", "stop"])
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/still recording/)
    expect(received.map((m) => [m.method, m.params])).toEqual([["record.stop", { peek: true }]])
    expect(listPlans(kh)).toEqual([])
  })

  it("start refuses a name that is not a slug before calling the browser", async () => {
    mkdirSync(kh, { recursive: true })
    await startFake()
    const r = await kite(["record", "start", "--name", "Ada Signup"])
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/--name/)
    expect(received).toEqual([])
  })

  it("stop without --force leaves an existing skill and the recording alone", async () => {
    writeSkill(home, REC, { force: false, kiteHome: kh })
    await startFake()
    answers.push({ name: "ada-signup", tab: 7, url: REC.url })
    expect((await kite(["record", "start", "--name", "ada-signup"])).code).toBe(0)
    answers.push(REC)
    const r = await kite(["record", "stop"])
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/--force.*still recording/)
    // only peeked: the recording was not stopped, nothing is lost
    expect(received.map((m) => [m.method, m.params])).toEqual([["record.start", { name: "ada-signup" }], ["record.stop", { peek: true }]])
    answers.push(REC, REC)
    const f = await kite(["record", "stop", "--force"])
    expect(f.code, f.err).toBe(0)
    expect(readdirSync(join(home, ".agents", "kite-backups", "skills"))).toHaveLength(1)
  })
})
