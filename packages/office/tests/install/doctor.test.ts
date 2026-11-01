/** Python's `tests/install/test_doctor.py`. */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { HqStatus, OfficeInfo } from "@opencorp/protocol"
import { VERSION } from "@opencorp/protocol/version"
import { openSqlite } from "@ngocbh/yian/platform"
import { expect, onTestFinished, test } from "bun:test"
import { Identity, IdentityUnreadable, identityPath, readIdentity, writeIdentity } from "../../src/auth/identity.ts"
import { newToken } from "../../src/auth/tokens.ts"
import { writeCompany } from "../../src/company_template/index.ts"
import { logLine } from "../../src/daemon/http.ts"
import { OfficePaths } from "../../src/daemon/office.ts"
import { attach } from "../../src/hq/core.ts"
import * as doctor from "../../src/install/doctor.ts"
import type { Check } from "../../src/install/doctor.ts"
import { INHERITED_ENV, launch } from "../../src/install/launch.ts"
import * as launchd from "../../src/install/launchd.ts"
import { SET_UP, setupConnectionFile } from "../../src/install/onboard.ts"
import * as service from "../../src/install/service.ts"
import * as systemd from "../../src/install/systemd.ts"
import { helperCommand } from "../../src/platform.ts"
import { writePrivate } from "../../src/secrets.ts"
import { latestVersion } from "../../src/store/migrate.ts"
import { Store } from "../../src/store/store.ts"
import { git } from "../company/helpers.ts"
import { CEO, giveDevice, makeOffice, served } from "../daemon/helpers.ts"
import { fifo, ps, shortDir, tempDir } from "../helpers.ts"
import { sandboxAvailable } from "../sandbox/helpers.ts"
import { makeHost, Runner, standIn } from "./helpers.ts"

const KEY = "sk-ant-test-0123456789"
const PROVIDER = { llm_config: { provider: "anthropic", api_key: KEY } }

/** Saves `provider` as the office's setup connection, making `connections/` private first. */
async function saveProvider(paths: OfficePaths, provider: object): Promise<void> {
  const folder = path.join(paths.office, "connections")
  fs.mkdirSync(folder, { mode: 0o700 })
  fs.chmodSync(folder, 0o700)
  await writePrivate(setupConnectionFile(paths.office), JSON.stringify(provider))
}

/** An onboarded home under `dir`: private home and office, the Acme company, `provider` if given, and
 *  `install.json` naming `mode`. */
async function onboarded(dir: string, provider?: object, mode = "launchd"): Promise<OfficePaths> {
  const paths = new OfficePaths(path.join(dir, "home"))
  fs.mkdirSync(paths.office, { recursive: true, mode: 0o700 })
  fs.chmodSync(paths.home, 0o700)
  fs.chmodSync(paths.office, 0o700)
  await writeCompany(paths.company, paths.worktrees, { company: "Acme", owner: { handle: "ngocbh", name: "Ngoc" } })
  if (provider !== undefined) await saveProvider(paths, provider)
  fs.writeFileSync(path.join(paths.office, "install.json"), JSON.stringify({ mode, name: "x" }))
  return paths
}

function byName(found: Check[]): Record<string, Check> {
  return Object.fromEntries(found.map((c) => [c.name, c]))
}

const COMMAND = ["/opt/opencorp/bin/opencorp"] as const

/** The launch `checks` makes for the office at `paths`. */
function launchFor(dir: string, paths: OfficePaths) {
  return launch(paths.home, { command: COMMAND, environ: {}, userHome: dir })
}

function runChecks(
  dir: string,
  paths: OfficePaths,
  {
    runner = new Runner(),
    answers = false,
    locked = () => false,
    probe = async () => null,
    platform = "darwin",
    lstat,
    command = COMMAND,
    environ = {},
  }: {
    runner?: Runner
    answers?: boolean
    locked?: (lockPath: string) => boolean
    probe?: (officeHome: string) => Promise<string | null>
    platform?: NodeJS.Platform
    lstat?: (p: string) => fs.Stats
    command?: readonly [string, ...string[]]
    environ?: Record<string, string>
  } = {},
): Promise<Check[]> {
  const host = makeHost(dir, runner, { answers: async () => answers, locked, platform })
  return doctor.checks(paths.home, {
    host,
    command,
    repo: path.join(dir, "repo"),
    probe,
    codex: async () => ({ name: "codex", status: "ok", detail: "stand-in" }),
    environ,
    hq: async () => "unreachable",
    office: async () => "unreachable",
    ...(lstat ? { lstat } : {}),
  })
}

function keyShown(found: Record<string, Check>): boolean {
  return Object.values(found).some((c) => c.detail.includes(KEY))
}

test("the report keeps the python line format byte for byte", () => {
  expect(doctor.report([{ name: "hq", status: "ok", detail: "web app at http://127.0.0.1:1/, and on /s" }])).toBe(
    "ok    hq           web app at http://127.0.0.1:1/, and on /s\n",
  )
  expect(
    doctor.report([
      { name: "provider", status: "warn", detail: "no model" },
      { name: "connections", status: "fail", detail: "loose" },
    ]),
  ).toBe("warn  provider     no model\nfail  connections  loose\n")
})

test("each check stays one row in the report, whatever its detail holds", () => {
  const out = doctor.report([{ name: "codex", status: "fail", detail: "a\nb\rc\x1b]0;t\x07d\x1b[31me\x07\x9b2J" }])
  expect(out).toBe("fail  codex        a b cde2J\n")
})

test("a company without a first commit is told to onboard", async () => {
  const dir = tempDir()
  const paths = new OfficePaths(path.join(dir, "home"))
  fs.mkdirSync(paths.company, { recursive: true })
  git(paths.company, "init", "-q", "-b", "main")
  fs.writeFileSync(path.join(paths.company, "company.yaml"), 'name: "Acme"\nceo: "me"\n')
  const got = byName(await runChecks(dir, paths))
  expect(got.company).toEqual({
    name: "company",
    status: "fail",
    detail:
      `${paths.company} has no company yet (no first commit);` + " run `opencorp init` to finish it",
  })
})

test("a home too long for the socket fails the home check, even before it exists", async () => {
  const dir = tempDir()
  const got = byName(await runChecks(dir, new OfficePaths(path.join(dir, "h".repeat(120)))))
  expect(got.home!.status).toBe("fail")
  expect(got.home!.detail).toContain("socket path too long")
  expect(got.home!.detail).toContain("--home")
})

test("a damaged company is named, with how to fix it", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  git(paths.company, "rm", "-q", "company.yaml")
  git(paths.company, "commit", "-qm", "drop company.yaml")
  let got = byName(await runChecks(dir, paths))
  expect(got.company!.status).toBe("fail")
  expect(got.company!.detail).toContain("has no company.yaml")
  expect(got.company!.detail).toContain("log -- company.yaml")
  fs.rmSync(path.join(paths.company, ".git"), { recursive: true })
  got = byName(await runChecks(dir, paths))
  expect(got.company!.status).toBe("fail")
  expect(got.company!.detail).toContain("holds files but no git repo")
  expect(got.company!.detail).toContain("restore its .git")
})

test("a fresh machine is told to onboard", async () => {
  const dir = tempDir()
  const found = await runChecks(dir, new OfficePaths(path.join(dir, "home")))
  const got = byName(found)
  expect(got.home).toEqual({
    name: "home",
    status: "fail",
    detail: `no office home at ${path.join(dir, "home")}; ${SET_UP}`,
  })
  expect(got.company).toEqual({
    name: "company",
    status: "fail",
    detail: `no company repo at ${path.join(dir, "home", "company")}; ${SET_UP}`,
  })
  expect(doctor.exitCode(found)).toBe(1)
})

test("an onboarded office that isnt running is only a warning", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir, { llm_config: { provider: "openai" } })
  const found = await runChecks(dir, paths)
  const got = byName(found)
  expect(got.company!.status).toBe("ok")
  expect(got.provider).toEqual({ name: "provider", status: "ok", detail: "openai, yian's own login" })
  const label = launchd.label(launchFor(dir, paths))
  expect(got.service).toEqual({ name: "service", status: "ok", detail: `launchd: ${label} is loaded` })
  expect(got.home).toEqual({ name: "home", status: "ok", detail: paths.home })
  expect(got.office!.status).toBe("warn")
  expect(got.office!.detail).toContain("not answering")
  expect(got.office!.detail).toContain("Run `opencorp start`.")
  expect(got.office!.detail).toContain(`\`launchctl print gui/501/${label}\` shows its status`)
  expect(got.sandbox).toEqual({ name: "sandbox", status: "ok", detail: "sandboxed commands run" })
  expect(doctor.exitCode(found)).toBe(0)
})

test("a home others can read warns", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  fs.chmodSync(paths.home, 0o755)
  const got = byName(await runChecks(dir, paths))
  expect(got.home!.status).toBe("warn")
  expect(got.home!.detail).toContain("0755, not 0700")
})

test("a stopped systemd office names the next step and the unit", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir, undefined, "systemd")
  const unit = systemd.unitName(launchFor(dir, paths))
  const runner = new Runner([[["loginctl"], 0, "", "Linger=yes\n"]])
  const got = byName(await runChecks(dir, paths, { runner, platform: "linux" }))
  expect(got.office!.detail).toContain("Run `opencorp start`.")
  expect(got.office!.detail).toContain(`\`systemctl --user status ${unit}\` shows its status`)
})

test("a disabled systemd unit shows what systemctl said", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir, undefined, "systemd")
  const runner = new Runner([[["systemctl", "--user", "is-enabled"], 1, "Failed to connect to bus: No medium found"]])
  const got = byName(await runChecks(dir, paths, { runner, platform: "linux" }))
  expect(got.service!.status).toBe("fail")
  expect(got.service!.detail).toContain("Failed to connect to bus: No medium found")
})

test("lint errors fail", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  fs.writeFileSync(path.join(paths.company, "company.yaml"), "name: Acme\nceo: nobody\n")
  const got = byName(await runChecks(dir, paths))
  expect(got.company!.status).toBe("fail")
  expect(got.company!.detail).toContain("company.unknown_ceo")
})

test("a multi-line lint message stays on the company row", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  fs.mkdirSync(path.join(paths.company, "people", "minh"), { recursive: true })
  fs.writeFileSync(
    path.join(paths.company, "people", "minh", "person.yaml"),
    'handle: minh\nname: Minh\nkind: agent\ntitle: Engineer\nmanager: ngocbh\nmain: ../../shared/flows/spin.yaml\n',
  )
  fs.writeFileSync(
    path.join(paths.company, "shared", "flows", "spin.yaml"),
    "id: spin\nname: spin\ninput:\n  messages: !Inbox(Message)\n  person: !str\n  talking_to: !str\n  summary: !str\n" +
      "  history: !list(list(Message))\n  turns: !int\n  max_turns: !int\nnodes:\n  reply:\n    kind: agent\n" +
      "    input:\n      who: ${input.talking_to}\n    output: str\n    prompt: |-\n      Say hi to ${who}.\n" +
      "output: ${reply.output}\n",
  )
  const got = byName(await runChecks(dir, paths))
  expect(got.company!.status).toBe("fail")
  expect(got.company!.detail).toContain("flow has unread inbox inputs: inbox input `messages`")
  expect(got.company!.detail).not.toContain("\n")
})

test.skipIf(process.getuid?.() === 0)("a people folder that cant be listed says so on the company row", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const people = path.join(paths.company, "people")
  fs.chmodSync(people, 0o000)
  let got: Record<string, Check>
  try {
    got = byName(await runChecks(dir, paths))
  } finally {
    fs.chmodSync(people, 0o755)
  }
  expect(got.company!.status).toBe("fail")
  expect(got.company!.detail).toContain("people: repo.unreadable: can't be listed (EACCES)")
})

const SIDE_CHAT = "shared/flows/side_chat.yaml"

test("a company missing template files is told to onboard again", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  fs.unlinkSync(path.join(paths.company, SIDE_CHAT))
  const got = byName(await runChecks(dir, paths))
  expect(got.company!.status).toBe("warn")
  expect(got.company!.detail).toContain(SIDE_CHAT)
  expect(got.company!.detail).toContain("`opencorp onboard` adds")
})

test("a running office missing template files is told to stop first", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  fs.unlinkSync(path.join(paths.company, SIDE_CHAT))
  const got = byName(await runChecks(dir, paths, { answers: true }))
  expect(got.company!.status).toBe("warn")
  expect(got.company!.detail).toContain(SIDE_CHAT)
  expect(got.company!.detail).toContain(
    "The office is running; run `opencorp stop`, then `opencorp onboard` again to add 1 template file.",
  )
})

test("a locked office that doesnt answer gets the stop to top up advice", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  fs.unlinkSync(path.join(paths.company, SIDE_CHAT))
  const got = byName(await runChecks(dir, paths, { locked: () => true }))
  expect(got.company!.detail).toContain(
    "The office is running; stop it and run `opencorp onboard` again to add 1 template file.",
  )
  // Everything that asks the office still needs it to answer.
  expect(got.office!.detail).toStartWith("not answering on ")
  const unchecked = byName(
    await runChecks(dir, paths, {
      locked: () => {
        throw new Error("can't open")
      },
    }),
  )
  expect(unchecked.company!.detail).toContain("`opencorp onboard` adds")
})

test("a provider others can read fails without showing it", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir, PROVIDER)
  fs.chmodSync(setupConnectionFile(paths.office), 0o644)
  const got = byName(await runChecks(dir, paths))
  expect(got.provider!.status).toBe("fail")
  expect(got.provider!.detail).toContain("0600")
  expect(keyShown(got)).toBe(false)
})

test("connections others can read fail without showing them", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  expect(byName(await runChecks(dir, paths)).connections).toBeUndefined() // none saved
  await saveProvider(paths, PROVIDER)
  const folder = path.join(paths.office, "connections")
  expect(byName(await runChecks(dir, paths)).connections).toEqual({
    name: "connections",
    status: "ok",
    detail: `${folder} is private`,
  })
  await writePrivate(path.join(folder, "second.json"), JSON.stringify(PROVIDER))
  fs.chmodSync(path.join(folder, "second.json"), 0o640)
  let got = byName(await runChecks(dir, paths))
  expect(got.connections).toEqual({
    name: "connections",
    status: "fail",
    detail: `second.json in ${folder} must be private to its owner (mode 0600)`,
  })
  fs.chmodSync(folder, 0o750)
  got = byName(await runChecks(dir, paths))
  expect(got.connections).toEqual({ name: "connections", status: "fail", detail: `${folder} is mode 0750, not 0700` })
  expect(keyShown(got)).toBe(false)
})

test("a symlinked connection is called a symlink, not a loose mode or an errno", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir, PROVIDER)
  const folder = path.join(paths.office, "connections")
  const file = setupConnectionFile(paths.office)
  const target = path.join(dir, "elsewhere.json")
  fs.writeFileSync(target, JSON.stringify(PROVIDER), { mode: 0o600 })
  fs.rmSync(file)
  fs.symlinkSync(target, file)
  const found = await runChecks(dir, paths)
  const got = byName(found)
  expect(got.provider!.status).toBe("fail")
  expect(got.provider!.detail).toContain("is a symlink, not a regular file")
  expect(got.connections).toEqual({
    name: "connections",
    status: "fail",
    detail: `office.json in ${folder} must be a regular file, not a symlink`,
  })
  for (const c of [got.provider!, got.connections!]) expect(c.detail).not.toContain("ELOOP")
  expect(doctor.report(found)).not.toContain(KEY)
})

test("a FIFO in connections must be a regular file, and loose modes are named apart from symlinks", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir, PROVIDER)
  const folder = path.join(paths.office, "connections")
  fifo(path.join(folder, "pipe.json"))
  let got = byName(await runChecks(dir, paths))
  expect(got.connections).toEqual({
    name: "connections",
    status: "fail",
    detail: `pipe.json in ${folder} must be a regular file`,
  })
  fs.rmSync(path.join(folder, "pipe.json"))
  fs.symlinkSync(setupConnectionFile(paths.office), path.join(folder, "link.json"))
  fs.writeFileSync(path.join(folder, "open.json"), "{}", { mode: 0o644 })
  got = byName(await runChecks(dir, paths))
  expect(got.connections!.detail).toBe(
    `link.json in ${folder} must be a regular file, not a symlink; ` +
      `open.json in ${folder} must be private to its owner (mode 0600)`,
  )
})

test("connections that is not a directory fails with what it is", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const folder = path.join(paths.office, "connections")
  fs.writeFileSync(folder, "")
  expect(byName(await runChecks(dir, paths)).connections).toEqual({
    name: "connections",
    status: "fail",
    detail: `${folder} is not a directory`,
  })
  fs.unlinkSync(folder)
  fs.mkdirSync(path.join(dir, "elsewhere"), { mode: 0o700 })
  fs.symlinkSync(path.join(dir, "elsewhere"), folder)
  expect(byName(await runChecks(dir, paths)).connections).toEqual({
    name: "connections",
    status: "fail",
    detail: `${folder} must be a directory, not a symlink`,
  })
})

test("a home or office that is a regular file is reported not thrown", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  fs.writeFileSync(home, "")
  let got = byName(await runChecks(dir, new OfficePaths(home)))
  expect(got.home).toEqual({ name: "home", status: "fail", detail: `${home} is not a directory` })
  expect(got.connections!.status).toBe("fail")
  const paths = await onboarded(path.join(dir, "second"))
  fs.rmSync(paths.office, { recursive: true })
  fs.writeFileSync(paths.office, "")
  got = byName(await runChecks(dir, paths))
  expect(got.home).toEqual({ name: "home", status: "ok", detail: paths.home })
  const folder = path.join(paths.office, "connections")
  expect(got.connections).toEqual({
    name: "connections",
    status: "fail",
    detail: `can't read ${folder}: Not a directory`,
  })
})

test("a connection removed during the check is skipped", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir, PROVIDER)
  const folder = path.join(paths.office, "connections")
  await writePrivate(path.join(folder, "second.json"), JSON.stringify(PROVIDER))
  // Loose, so only skipping it keeps the line ok.
  fs.chmodSync(path.join(folder, "second.json"), 0o640)
  const vanished = (p: string): fs.Stats => {
    if (p.endsWith("second.json")) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${p}'`), { code: "ENOENT" })
    }
    return fs.lstatSync(p)
  }
  expect(byName(await runChecks(dir, paths, { lstat: vanished })).connections).toEqual({
    name: "connections",
    status: "ok",
    detail: `${folder} is private`,
  })
})

test("a lock file in connections is private", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir, { llm_config: { provider: "anthropic", api_key: KEY, model: "claude-x" } })
  const folder = path.join(paths.office, "connections")
  const got = byName(await runChecks(dir, paths))
  expect(got.provider!.status).toBe("ok")
  expect(fs.lstatSync(path.join(folder, ".lock")).isFile()).toBe(true)
  expect(got.connections).toEqual({ name: "connections", status: "ok", detail: `${folder} is private` })
})

test("a provider whose folder lock isnt private fails", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir, { llm_config: { provider: "anthropic", api_key: KEY, model: "claude-x" } })
  fs.chmodSync(path.join(paths.office, "connections", ".lock"), 0o644)
  const got = byName(await runChecks(dir, paths))
  const file = setupConnectionFile(paths.office)
  expect(got.provider!.status).toBe("fail")
  expect(got.provider!.detail).toStartWith(`can't read ${file}: `)
  expect(got.provider!.detail).toContain("not private")
  expect(keyShown(got)).toBe(false)
})

test("a provider composer wont take fails without showing the key", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir, { llm_config: { provider: "anthropic", api_key: KEY, [KEY]: 1 } })
  const got = byName(await runChecks(dir, paths))
  expect(got.provider!.status).toBe("fail")
  expect(got.provider!.detail).toContain("extra field")
  expect(keyShown(got)).toBe(false)
})

test("a saved key is reported but not shown", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir, { llm_config: { provider: "anthropic", api_key: KEY, model: "claude-x" } })
  const got = byName(await runChecks(dir, paths))
  expect(got.provider).toEqual({ name: "provider", status: "ok", detail: "anthropic, key saved" })
})

test("a key with no model warns and names the model onboard saves", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir, PROVIDER)
  const got = byName(await runChecks(dir, paths))
  expect(got.provider).toEqual({
    name: "provider",
    status: "warn",
    detail: "anthropic, key saved, but no model, so runs fail; `opencorp onboard` saves claude-sonnet-4-5",
  })
  expect(keyShown(got)).toBe(false)
})

test("a key for an endpoint of your own with no model fails", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir, {
    llm_config: { provider: "openai", base_url: "https://llm.example/v1", api_key: KEY },
  })
  const got = byName(await runChecks(dir, paths))
  const file = setupConnectionFile(paths.office)
  expect(got.provider).toEqual({
    name: "provider",
    status: "fail",
    detail:
      `${file}: llm_config.model is missing, and an endpoint of your own has no default model;` +
      " run `opencorp onboard`",
  })
  expect(keyShown(got)).toBe(false)
})

test("an unloaded launch agent fails", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const got = byName(await runChecks(dir, paths, { runner: new Runner([[["launchctl", "print"], 113, ""]]) }))
  expect(got.service!.status).toBe("fail")
  expect(got.service!.detail).toContain("run `opencorp onboard`")
})

test("a systemd service without linger warns that it stops at logout", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir, undefined, "systemd")
  const unit = systemd.unitName(launchFor(dir, paths))
  const runner = new Runner([[["loginctl"], 0, "", "Linger=no\n"]])
  const got = byName(await runChecks(dir, paths, { runner, platform: "linux" }))
  expect(got.service!.status).toBe("warn")
  expect(got.service!.detail).toContain("loginctl enable-linger")
  expect(got.service!.detail).toContain(unit)
  expect(runner.calls).toContainEqual(["loginctl", "show-user", "501", "--property=Linger"])
})

test("a systemd service with linger is ok", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir, undefined, "systemd")
  const unit = systemd.unitName(launchFor(dir, paths))
  const runner = new Runner([[["loginctl"], 0, "", "Linger=yes\n"]])
  const got = byName(await runChecks(dir, paths, { runner, platform: "linux" }))
  expect(got.service).toEqual({ name: "service", status: "ok", detail: `systemd: ${unit} is enabled` })
})

test("an office that keeps failing to start is a crash loop", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  fs.writeFileSync(path.join(paths.office, "office.log"), "starting\nopencorp office: the company repo has no .git\n\n")
  const got = byName(await runChecks(dir, paths))
  expect(got.office!.status).toBe("fail")
  expect(got.office!.detail).toContain("opencorp office: the company repo has no .git")
  expect(got.office!.detail).toContain("Fix that, then run `opencorp start`.")
})

test("a failed office start names the type the log above it holds", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const log = [
    logLine("ERROR", "opencorp.daemon.main", "the office failed to start: TypeError"),
    "    at start (office.ts:1:1)",
    "opencorp office: the office failed to start (see the log above)",
  ].join("\n")
  fs.writeFileSync(path.join(paths.office, "office.log"), `${log}\n`)
  const got = byName(await runChecks(dir, paths))
  expect(got.office!.detail).toContain("its last start failed: opencorp office: the office failed to start: TypeError")
  expect(got.office!.detail).not.toContain("see the log above")
})

test.each(["file", "directory", "symlink"])("something other than a socket at the socket path fails [%s]", async (
  kind,
) => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const sock = path.join(paths.office, "office.sock")
  if (kind === "file") fs.writeFileSync(sock, "")
  else if (kind === "directory") fs.mkdirSync(sock)
  else fs.symlinkSync(path.join(dir, "elsewhere.sock"), sock)
  const got = byName(await runChecks(dir, paths))
  expect(got.office).toEqual({
    name: "office",
    status: "fail",
    detail: `${sock} is not a socket; remove it, then run \`opencorp start\``,
  })
})

test("a symlink at the socket path is never asked anything even when something answers", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  fs.symlinkSync(path.join(dir, "other.sock"), path.join(paths.office, "office.sock"))
  const asked: string[] = []
  const host = makeHost(dir, new Runner(), { answers: async () => true })
  const found = await doctor.checks(paths.home, {
    host,
    command: COMMAND,
    repo: path.join(dir, "repo"),
    probe: async () => null,
    codex: async () => ({ name: "codex", status: "ok", detail: "stand-in" }),
    environ: {},
    hq: async () => (asked.push("hq"), "unreachable"),
    office: async () => (asked.push("office"), "unreachable"),
  })
  expect(byName(found).office!.status).toBe("fail")
  expect(asked).toEqual([])
})

test("a daemon that holds the home but doesnt answer is named with the restart", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const real = launchFor(dir, paths).home
  const live = await standIn(`daemon --home ${real}`)
  fs.writeFileSync(path.join(paths.office, "office.pid"), `${live.pid}\n`)
  const got = byName(await runChecks(dir, paths, { environ: { PATH: path.dirname(ps()) } }))
  expect(got.office!.status).toBe("warn")
  expect(got.office!.detail).toContain(
    `pid ${live.pid} is running but doesn't answer on ${path.join(paths.office, "office.sock")} (still starting,` +
      " or hung); if it stays that way, run `opencorp restart`",
  )
})

/** A log of a start, then the crash marker with two frames. */
function crashedLog(): string {
  return (
    `${logLine("INFO", "opencorp.daemon.main", "office listening")}\n` +
    `${logLine("ERROR", "opencorp.daemon.main", "office crashed: TypeError")}\n` +
    "    at f (x.ts:1:1)\n    at g (y.ts:2:2)\n"
  )
}

test("an office that crashed with the crash marker fails", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  fs.writeFileSync(path.join(paths.office, "office.log"), crashedLog())
  const got = byName(await runChecks(dir, paths))
  expect(got.office!.status).toBe("fail")
  expect(got.office!.detail).toContain("its last start failed: office crashed: TypeError")
  expect(got.office!.detail).toContain("Its stack is in the log; fix the cause, then run `opencorp start`.")
  expect(got.office!.detail).not.toContain("x.ts")
  expect(got.office!.detail).not.toContain("y.ts")
})

test("a crash marker never shows more than the error type", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const log = `${logLine("ERROR", "opencorp.daemon.main", "office crashed: TypeError token=abc")}\n    at f (x.ts:1:1)\n`
  fs.writeFileSync(path.join(paths.office, "office.log"), log)
  const got = byName(await runChecks(dir, paths))
  expect(got.office!.status).toBe("warn")
  expect(got.office!.detail).not.toContain("token=abc")
})

test("a symlinked office log is named, not read", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const target = path.join(dir, "elsewhere.log")
  fs.writeFileSync(target, "opencorp office: the company repo has no .git\n")
  fs.symlinkSync(target, path.join(paths.office, "office.log"))
  const got = byName(await runChecks(dir, paths))
  expect(got.office!.status).toBe("warn")
  const log = launchFor(dir, paths).log
  expect(got.office!.detail).toContain(`${log} is a symlink, which doctor doesn't read`)
  expect(got.office!.detail).not.toContain("no .git")
})

test("an office log that isnt a regular file is no crash", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  fs.mkdirSync(path.join(paths.office, "office.log"))
  const got = byName(await runChecks(dir, paths))
  expect(got.office!.status).toBe("warn")
})

test("a stopped offices record that is a FIFO reads as not installed without blocking", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const record = path.join(paths.office, "install.json")
  fs.rmSync(record)
  fifo(record)
  const began = performance.now()
  const got = byName(await runChecks(dir, paths))
  expect(performance.now() - began).toBeLessThan(2000)
  expect(got.service!.detail).toContain("not installed")
})

test("an office log that is a symlink is no crash and shows nothing of its target", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const target = path.join(dir, "elsewhere.log")
  fs.writeFileSync(target, "opencorp office: SENTINEL\n")
  fs.symlinkSync(target, path.join(paths.office, "office.log"))
  const got = byName(await runChecks(dir, paths))
  expect(got.office!.status).toBe("warn")
  expect(got.office!.detail).not.toContain("SENTINEL")
})

test("an office log that is a FIFO is no crash, without blocking", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  fifo(path.join(paths.office, "office.log"))
  const began = performance.now()
  const got = byName(await runChecks(dir, paths))
  expect(performance.now() - began).toBeLessThan(2000)
  expect(got.office!.status).toBe("warn")
})

test("the crash marker is found at the end of a long log", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const info = `${logLine("INFO", "opencorp.daemon.main", "office listening")}\n`
  fs.writeFileSync(path.join(paths.office, "office.log"), info.repeat(Math.ceil((100 * 1024) / info.length)) + crashedLog())
  const got = byName(await runChecks(dir, paths))
  expect(got.office!.status).toBe("fail")
  expect(got.office!.detail).toContain("its last start failed: office crashed: TypeError")
})

test("a crash marker followed by a later start is not a crash", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const later = `${logLine("INFO", "opencorp.daemon.main", "office listening")}\n`
  fs.writeFileSync(path.join(paths.office, "office.log"), crashedLog() + later)
  const got = byName(await runChecks(dir, paths))
  expect(got.office!.status).toBe("warn")
  expect(got.office!.detail).not.toContain("office crashed")
})

test("a duplicate start is not a failed start", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  fs.writeFileSync(path.join(paths.office, "office.log"), "starting\nopencorp office: office already running (pid 7)\n")
  const got = byName(await runChecks(dir, paths))
  expect(got.office!.status).toBe("warn")
  expect(got.office!.detail).not.toContain("already running")
})

test("a sandbox that cant start fails", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const got = byName(await runChecks(dir, paths, { probe: async () => "sandbox-exec: Operation not permitted" }))
  expect(got.sandbox).toEqual({ name: "sandbox", status: "fail", detail: "sandbox-exec: Operation not permitted" })
})

/** A fake codex on a PATH under `dir`; `login status` prints what real Codex does (on stderr) unless told
 *  otherwise. Returns the env to run it with. */
function fakeCodex(dir: string, loginExit: number, loginErr?: string, loginOut = ""): Record<string, string> {
  const bin = path.join(dir, "bin")
  fs.mkdirSync(bin)
  const err = loginErr ?? (loginExit === 0 ? "Logged in using ChatGPT\n" : "Not logged in\n")
  fs.writeFileSync(path.join(dir, "login.err"), err)
  fs.writeFileSync(path.join(dir, "login.out"), loginOut)
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.130.0";;\n` +
      `login) cat "${dir}/login.out"; cat "${dir}/login.err" >&2; exit ${loginExit};; esac\n`,
    { mode: 0o755 },
  )
  return { PATH: `${bin}:/usr/bin:/bin`, HOME: dir }
}

/** A `checks` run on a fresh machine whose stand-in codex check records what it was given. */
async function checksSeeingCodex(
  dir: string,
  environ: Record<string, string>,
  {
    paths = new OfficePaths(path.join(dir, "home")),
    runner = new Runner(),
    platform = "darwin" as NodeJS.Platform,
  } = {},
) {
  const seen: { env: Record<string, string>; environ: Record<string, string | undefined>; mode: string | null }[] = []
  const found = await doctor.checks(paths.home, {
    host: makeHost(dir, runner, { platform }),
    command: COMMAND,
    repo: path.join(dir, "repo"),
    probe: async () => null,
    codex: async (env, environ, mode) => {
      seen.push({ env, environ, mode })
      return { name: "codex", status: "ok", detail: "stand-in" }
    },
    environ,
    hq: async () => "unreachable",
    office: async () => "unreachable",
  })
  return { found, seen }
}

test("codex on the office path and signed in is ok", async () => {
  const check = await doctor.codexCheck(fakeCodex(tempDir(), 0), {})
  expect(check.status).toBe("ok")
  expect(check.detail).toContain("codex-cli 0.130.0")
})

test("codex signed out or missing is a warning", async () => {
  const dir = tempDir()
  const codex = path.join(dir, "bin", "codex")
  expect(await doctor.codexCheck(fakeCodex(dir, 1), {})).toEqual({
    name: "codex",
    status: "warn",
    detail: `codex-cli 0.130.0 at ${codex} is signed out; run \`${codex} login\``,
  })
  const missing = await doctor.codexCheck({ PATH: path.join(dir, "nowhere") }, {})
  expect(missing.status).toBe("warn")
  expect(missing.detail).toContain("not on the office's PATH")
})

test("a codex login status that fails otherwise shows its first line", async () => {
  const dir = tempDir()
  const env = fakeCodex(dir, 1, "\nError loading configuration: unknown field `modle` in config.toml\nat line 3\n")
  const codex = path.join(dir, "bin", "codex")
  expect(await doctor.codexCheck(env, {})).toEqual({
    name: "codex",
    status: "warn",
    detail:
      `codex-cli 0.130.0 at ${codex}: \`${codex} login status\`` +
      " failed: Error loading configuration: unknown field `modle` in config.toml",
  })
})

test("codex is signed out when any line says so", async () => {
  const dir = tempDir()
  const env = fakeCodex(dir, 1, "WARNING: proceeding, even though we could not update PATH\nNot logged in\n")
  const codex = path.join(dir, "bin", "codex")
  expect(await doctor.codexCheck(env, {})).toEqual({
    name: "codex",
    status: "warn",
    detail: `codex-cli 0.130.0 at ${codex} is signed out; run \`${codex} login\``,
  })
})

test("a failed codex login status shows its error line over a warning", async () => {
  const env = fakeCodex(
    tempDir(),
    1,
    "WARNING: proceeding, even though we could not update PATH\nError loading configuration: unknown field `modle`\n",
  )
  expect((await doctor.codexCheck(env, {})).detail).toEndWith(
    "login status` failed: Error loading configuration: unknown field `modle`",
  )
})

test("codex color codes are dropped before matching and showing", async () => {
  const dir = tempDir()
  const env = fakeCodex(dir, 1, "\x1b[33mWARNING: odd\x1b[0m\n\x1b[1;31mError\x1b[0m checking login status: denied\n")
  expect((await doctor.codexCheck(env, {})).detail).toEndWith(
    "login status` failed: Error checking login status: denied",
  )
  fs.writeFileSync(path.join(dir, "login.err"), "\x1b[2mNot logged in\x1b[0m\n")
  expect((await doctor.codexCheck(env, {})).detail).toEndWith(
    `is signed out; run \`${path.join(dir, "bin", "codex")} login\``,
  )
})

test("a failed codex version line is cut short and uncolored", async () => {
  const dir = tempDir()
  const env = fakeCodex(dir, 0)
  const codex = path.join(dir, "bin", "codex")
  fs.writeFileSync(
    codex,
    '#!/bin/sh\nprintf "\\033[31mboom %s\\033[0m\\n" "$(printf "y%.0s" $(seq 1 300))" >&2\nexit 3\n',
  )
  expect(await doctor.codexCheck(env, {})).toEqual({
    name: "codex",
    status: "fail",
    detail: `${codex} --version failed: ` + `boom ${"y".repeat(300)}`.slice(0, 200),
  })
})

test("a failed codex version shows only its first printable line", async () => {
  const dir = tempDir()
  const env = fakeCodex(dir, 0)
  const codex = path.join(dir, "bin", "codex")
  fs.writeFileSync(codex, "#!/bin/sh\nprintf '\\033]0;pwned\\007\\none\\ntwo\\n\\033]0;pwned\\007three' >&2\nexit 3\n")
  expect(await doctor.codexCheck(env, {})).toEqual({
    name: "codex",
    status: "fail",
    detail: `${codex} --version failed: one`,
  })
})

test("a codex login status line loses its escapes and control characters", async () => {
  const dir = tempDir()
  const env = fakeCodex(dir, 1, "\x1b]0;x\x07Error: bad\x07 config\r\nmore\n")
  const check = await doctor.codexCheck(env, {})
  expect(check.detail).toEndWith("login status` failed: Error: bad config")
  fs.writeFileSync(path.join(dir, "login.err"), "\x1b]0;x\x07Not logged in\r\n")
  const out = await doctor.codexCheck(env, {})
  expect(out.detail).toContain("is signed out")
  for (const c of ["\x1b", "\x07", "\r"]) {
    expect(check.detail).not.toContain(c)
    expect(out.detail).not.toContain(c)
  }
})

test("a codex version is shown uncolored and cut short", async () => {
  const dir = tempDir()
  const env = fakeCodex(dir, 0)
  const codex = path.join(dir, "bin", "codex")
  fs.writeFileSync(
    codex,
    '#!/bin/sh\ncase "$1" in --version) printf "\\n\\033[32mcodex-cli 1.2.3\\033[0m\\nsecond line\\n";; login) exit 0;; esac\n',
  )
  expect((await doctor.codexCheck(env, {})).detail).toBe(`codex-cli 1.2.3 at ${codex}, signed in`)
  fs.writeFileSync(
    codex,
    '#!/bin/sh\ncase "$1" in --version) printf "v%s\\n" "$(printf "9%.0s" $(seq 1 300))";; login) exit 0;; esac\n',
  )
  expect((await doctor.codexCheck(env, {})).detail).toBe(`v${"9".repeat(199)} at ${codex}, signed in`)
})

test("a failed codex login status falls back to stdout then the exit code", async () => {
  const dir = tempDir()
  const env = fakeCodex(dir, 2, "", "something odd\n")
  expect((await doctor.codexCheck(env, {})).detail).toEndWith("login status` failed: something odd")
  fs.writeFileSync(path.join(dir, "login.out"), "")
  expect((await doctor.codexCheck(env, {})).detail).toEndWith("login status` failed: exit 2")
})

test("a failed codex login status line is cut short", async () => {
  const env = fakeCodex(tempDir(), 1, `Error checking login status: ${"x".repeat(500)}\n`)
  const check = await doctor.codexCheck(env, {})
  expect(check.status).toBe("warn")
  expect(check.detail).toEndWith(`failed: Error checking login status: ${"x".repeat(171)}`)
})

test("a codex that hangs or cant run fails the check", async () => {
  const dir = tempDir()
  const env = fakeCodex(dir, 0)
  const codex = path.join(dir, "bin", "codex")
  fs.writeFileSync(codex, "#!/bin/sh\nsleep 5\n")
  expect(await doctor.codexCheck(env, {}, null, 500)).toEqual({
    name: "codex",
    status: "fail",
    detail: `${codex} --version didn't answer in 0.5 s`,
  })
  fs.writeFileSync(codex, "#!/nonexistent/sh\n")
  const broken = await doctor.codexCheck(env, {})
  expect(broken.status).toBe("fail")
  expect(broken.detail).toStartWith(`${codex} can't run`)
})

test("a codex wrapper whose inner command is missing is a failed version", async () => {
  const dir = tempDir()
  const env = fakeCodex(dir, 0)
  const codex = path.join(dir, "bin", "codex")
  fs.writeFileSync(codex, "#!/bin/sh\nopencorp-no-such-command --version\n")
  const check = await doctor.codexCheck(env, {})
  expect(check.status).toBe("fail")
  expect(check.detail).toStartWith(`${codex} --version failed: `)
  expect(check.detail).toContain("opencorp-no-such-command")
  expect(check.detail).toContain("not found")
})

test("checks run the codex check they are given in the app servers environment", async () => {
  const dir = tempDir()
  const environ = { PATH: "/usr/bin:/bin", HOME: dir, OPENAI_API_KEY: "sk-secret" }
  const { found, seen } = await checksSeeingCodex(dir, environ)
  expect(found.at(-1)).toEqual({ name: "codex", status: "ok", detail: "stand-in" })
  const inherited: readonly string[] = INHERITED_ENV
  expect(seen).toHaveLength(1)
  for (const key of Object.keys(seen[0]!.env)) expect(inherited.includes(key) || key.startsWith("LC_")).toBe(true)
  expect(seen[0]!.env).not.toHaveProperty("OPENAI_API_KEY")
})

test("opencorp codex bin names the codex the check runs", async () => {
  const dir = tempDir()
  const env = fakeCodex(dir, 0)
  const other = path.join(dir, "codex-dev")
  fs.writeFileSync(other, '#!/bin/sh\ncase "$1" in --version) echo "codex-cli 9.9.9";; login) exit 0;; esac\n', {
    mode: 0o755,
  })
  expect(await doctor.codexCheck(env, { OPENCORP_CODEX_BIN: other })).toEqual({
    name: "codex",
    status: "ok",
    detail: `codex-cli 9.9.9 at ${other}, signed in`,
  })
  const linked = path.join(dir, "bin", "codex-dev")
  fs.symlinkSync(other, linked)
  expect(await doctor.codexCheck(env, { OPENCORP_CODEX_BIN: "codex-dev" })).toEqual({
    name: "codex",
    status: "ok",
    detail: `codex-cli 9.9.9 at ${linked}, signed in`,
  })
})

test("an opencorp codex bin the office cant find is a warning even with codex on the path", async () => {
  const check = await doctor.codexCheck(fakeCodex(tempDir(), 0), { OPENCORP_CODEX_BIN: "/nowhere/codex" })
  expect(check.status).toBe("warn")
  expect(check.detail).toContain(
    "OPENCORP_CODEX_BIN names /nowhere/codex, which isn't an executable the office can find",
  )
})

test("the check runs codex with the offices codex home when set", async () => {
  const dir = tempDir()
  const env = fakeCodex(dir, 0)
  fs.writeFileSync(
    path.join(dir, "bin", "codex"),
    '#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.130.0";; login) [ "$CODEX_HOME" = /x/home ];; esac\n',
  )
  expect((await doctor.codexCheck(env, { CODEX_HOME: "/x/home" })).status).toBe("ok")
  expect((await doctor.codexCheck(env, {})).status).toBe("warn")
  expect(env).not.toHaveProperty("CODEX_HOME")
})

test("checks give the codex check the offices environment to find codex", async () => {
  const dir = tempDir()
  const { seen } = await checksSeeingCodex(dir, {
    PATH: "/usr/bin:/bin",
    HOME: dir,
    CODEX_HOME: "/x/home",
    OPENCORP_CODEX_BIN: "/x/codex",
  })
  const { env, environ } = seen[0]!
  expect(environ.CODEX_HOME).toBe("/x/home")
  expect(environ.OPENCORP_CODEX_BIN).toBe("/x/codex")
  expect(env).not.toHaveProperty("CODEX_HOME")
  expect(env).not.toHaveProperty("OPENCORP_CODEX_BIN")
})

test("the codex check runs with where tls finds ca certificates when set", async () => {
  const dir = tempDir()
  const { seen } = await checksSeeingCodex(dir, {
    PATH: "/usr/bin:/bin",
    HOME: dir,
    SSL_CERT_FILE: "/etc/pki/tls/certs/ca-bundle.crt",
    SSL_CERT_DIR: "/etc/pki/tls/certs",
    OPENAI_API_KEY: "sk-secret",
  })
  expect(seen[0]!.env.SSL_CERT_FILE).toBe("/etc/pki/tls/certs/ca-bundle.crt")
  expect(seen[0]!.env.SSL_CERT_DIR).toBe("/etc/pki/tls/certs")
  expect(seen[0]!.env).not.toHaveProperty("OPENAI_API_KEY")
})

test("codex advice says how the office picks up a change under its service", async () => {
  const missing = { PATH: path.join(tempDir(), "nowhere") }
  for (const mode of ["launchd", "systemd"]) {
    const managed = await doctor.codexCheck(missing, {}, mode)
    expect(managed.detail).toContain("then `opencorp stop` and `opencorp onboard` again from that shell")
    expect(managed.detail).not.toContain("opencorp restart")
    const override = await doctor.codexCheck(missing, { OPENCORP_CODEX_BIN: "/nowhere/codex" }, mode)
    expect(override.detail).toContain("then `opencorp stop` and `opencorp onboard` again from that shell")
  }
  for (const mode of ["tmux", "background", null]) {
    expect((await doctor.codexCheck(missing, {}, mode)).detail).toContain("then `opencorp restart` from that shell")
  }
})

test("checks give the codex check the offices recorded service mode", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir, undefined, "systemd")
  const runner = new Runner([[["loginctl"], 0, "", "Linger=yes\n"]])
  const { seen } = await checksSeeingCodex(dir, {}, { paths, runner, platform: "linux" })
  expect(seen.map((s) => s.mode)).toEqual(["systemd"])
})

test("a codex that says nothing is still described", async () => {
  const dir = tempDir()
  const env = fakeCodex(dir, 0)
  const codex = path.join(dir, "bin", "codex")
  fs.writeFileSync(codex, '#!/bin/sh\ncase "$1" in --version) exit 3;; esac\n')
  expect(await doctor.codexCheck(env, {})).toEqual({
    name: "codex",
    status: "fail",
    detail: `${codex} --version failed: exit 3`,
  })
  fs.writeFileSync(codex, "#!/bin/sh\nexit 0\n")
  expect(await doctor.codexCheck(env, {})).toEqual({
    name: "codex",
    status: "ok",
    detail: `${codex} (no version printed), signed in`,
  })
})

test("hq status is read with this devices token", async () => {
  const office = makeOffice()
  const home = tempDir()
  const token = newToken()
  giveDevice(office.paths.company, CEO, "mac", token) // enforced from now on
  await writeIdentity(identityPath(home), new Identity(CEO, "mac", token))
  attach(office, { log: () => {}, listen: false })
  const { sock } = await served(office, { tokens: true })
  const status = await doctor.hqStatus(sock, await readIdentity(identityPath(home)), 10_000)
  if (typeof status === "string") throw new Error(`unread: ${status}`)
  expect(status.socket.endsWith("hq.sock")).toBe(true)
  expect(doctor.report(doctor.hqChecks(status, home, home))).not.toContain(token)
  fs.unlinkSync(identityPath(home))
  const gone = await readIdentity(identityPath(home))
  expect(gone).toBeUndefined()
  expect(await doctor.hqStatus(sock, gone, 10_000)).toBe("refused") // 401
})

test("an office without hq or no office at all is unreachable", async () => {
  const { sock } = await served(makeOffice()) // HQ not attached: 501
  expect(await doctor.hqStatus(sock, undefined)).toBe("unreachable")
  expect(await doctor.hqStatus(path.join(shortDir(), "nothing.sock"), undefined)).toBe("unreachable")
})

/** A stand-in office on a unix socket answering every request with `status` and `body`, or never when `body` is
 *  undefined; closed when the test finishes. */
async function answering(status: number, body?: string): Promise<string> {
  const server = http.createServer((_req, res) => {
    if (body !== undefined) res.writeHead(status, { "content-type": "application/json" }).end(body)
  })
  // Registered before shortDir's removal, so the server is closed first.
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const sock = path.join(shortDir(), "o.sock")
  await new Promise<void>((resolve) => server.listen(sock, resolve))
  return sock
}

test("an office from before hq is unreachable", async () => {
  const sock = await answering(404, JSON.stringify({ error: "no_route" }))
  expect(await doctor.hqStatus(sock, undefined)).toBe("unreachable")
})

test("an office that doesnt answer in time is unreachable", async () => {
  const sock = await answering(200)
  expect(await doctor.hqStatus(sock, undefined, 200)).toBe("unreachable")
})

/** An HQ status listening on its web port with a current app, with `tcp` over its TCP fields. */
function status(tcp: Partial<HqStatus["tcp"]> = {}): HqStatus {
  return {
    socket: "/h/office/hq.sock",
    tcp: { enabled: true, port: 49380, listening: true, error: null, next_retry_at: null, ...tcp },
    url: "http://127.0.0.1:49380/",
    health: { ok: true, office: { api: "0.0.1+aaa" }, app: { build: "b", api: "0.0.1+aaa" } },
    warnings: [],
  }
}

test("hq listening and a current app", () => {
  const dir = tempDir()
  const got = byName(doctor.hqChecks(status(), dir, path.join(dir, "repo")))
  expect(got.hq!.status).toBe("ok")
  expect(got.hq!.detail).toContain("http://127.0.0.1:49380/")
  expect(got["web app"]!.status).toBe("ok")
})

test("a taken port names the fix", () => {
  const dir = tempDir()
  const got = byName(doctor.hqChecks(status({ listening: false, error: "Address already in use" }), dir, dir))
  expect(got.hq!.status).toBe("warn")
  expect(got.hq!.detail).toContain("Address already in use")
  expect(got.hq!.detail).toContain("hq.json")
})

test("a port not bound yet says so without a fix", () => {
  const dir = tempDir()
  const got = byName(doctor.hqChecks(status({ listening: false }), dir, dir)).hq!
  expect(got.status).toBe("warn")
  expect(got.detail).toContain("isn't listening yet (HQ is binding it)")
  expect(got.detail).not.toContain("hq.json")
  expect(got.detail).not.toContain("restart")
})

test("a web port server that ended is told to restart", () => {
  const dir = tempDir()
  const s = status({ listening: false, error: "its server ended (it stopped)" })
  const got = byName(doctor.hqChecks(s, dir, dir)).hq!
  expect(got.status).toBe("warn")
  expect(got.detail).toContain("server ended (it stopped)")
  expect(got.detail).toContain("`opencorp restart`")
  expect(got.detail).not.toContain("hq.json")
  expect(got.detail).not.toContain("isn't free")
})

test("tcp off points at pair", () => {
  const dir = tempDir()
  const got = byName(doctor.hqChecks(status({ enabled: false, listening: false }), dir, dir))
  expect(got.hq!.status).toBe("ok")
  expect(got.hq!.detail).toContain("opencorp pair")
})

test("an unbuilt or stale app warns", () => {
  const dir = tempDir()
  fs.mkdirSync(path.join(dir, "packages", "app"), { recursive: true })
  const s = status()
  s.health.app = null
  expect(byName(doctor.hqChecks(s, dir, dir))["web app"]!.detail).toContain("bun run build")
  s.health.app = { build: "b", api: "0.0.1+bbb" }
  expect(byName(doctor.hqChecks(s, dir, dir))["web app"]!.detail).toContain("doesn't match")
})

test("an install without the apps sources says it has no web app", () => {
  const dir = tempDir()
  const s = status()
  s.health.app = null
  const got = byName(doctor.hqChecks(s, dir, path.join(dir, "site-packages")))["web app"]!
  expect(got.status).toBe("warn")
  expect(got.detail).toContain("this install has no web app")
  expect(got.detail).toContain(`"app_dir" in ${path.join(dir, "hq.json")}`)
  expect(got.detail).toContain(`v${VERSION}`)
  expect(got.detail).not.toContain("bun")
})

for (const enabled of [true, false]) {
  test(`hq sock not listening warns and says to restart [${enabled}]`, () => {
    const dir = tempDir()
    const s = { ...status({ enabled, listening: enabled }), socket_error: "AF_UNIX path too long" }
    const got = byName(doctor.hqChecks(s, dir, dir))
    expect(got.hq!.status).toBe("warn")
    expect(got.hq!.detail.startsWith("not listening on /h/office/hq.sock: AF_UNIX")).toBe(true)
    expect(got.hq!.detail).toContain("`opencorp restart`")
    if (enabled) {
      // The web port is a separate line, so its own state isn't lost.
      expect(got["hq port"]!.status).toBe("ok")
      expect(got["hq port"]!.detail).toContain("http://127.0.0.1:49380/")
    } else {
      expect(got).not.toHaveProperty("hq port")
    }
  })
}

for (const enabled of [true, false]) {
  test(`a socket file gone from under the office warns and says to restart [${enabled}]`, () => {
    const dir = tempDir()
    const gone = "the socket file is gone; run `opencorp restart`"
    const got = byName(doctor.hqChecks(status({ enabled, listening: enabled }), dir, dir, gone))
    expect(got.hq).toEqual({ name: "hq", status: "warn", detail: `not listening on /h/office/hq.sock: ${gone}` })
    if (enabled) {
      expect(got["hq port"]).toEqual({ name: "hq port", status: "ok", detail: "web app at http://127.0.0.1:49380/" })
    } else {
      expect(got).not.toHaveProperty("hq port")
    }
  })
}

test("the offices own socket error comes before what doctor found at the path", () => {
  const dir = tempDir()
  const s = { ...status(), socket_error: "AF_UNIX path too long" }
  const got = byName(doctor.hqChecks(s, dir, dir, "the socket file is gone; run `opencorp restart`"))
  expect(got.hq!.detail).toContain("AF_UNIX path too long")
  expect(got.hq!.detail).not.toContain("gone")
})

test("a running offices hq line says when its socket file is gone or replaced", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const running = (sock: Sock) => runningChecks(dir, paths, info(launchFor(dir, paths).home), {}, { sock })
  expect(byName(await running("socket")).hq!.status).toBe("ok")
  expect(byName(await running("missing")).hq).toEqual({
    name: "hq",
    status: "warn",
    detail: "not listening on /h/office/hq.sock: the socket file is gone; run `opencorp restart`",
  })
  const file = byName(await running("file")).hq!
  expect(file.status).toBe("warn")
  expect(file.detail).toContain("something else is at that path; remove it and run `opencorp restart`")
  const odd = byName(await running("throws")).hq!
  expect(odd.status).toBe("warn")
  expect(odd.detail).toContain("can't check it (EACCES)")
})

test("an hq status without a socket path is not looked for", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const hq = { ...status(), socket: null } as unknown as HqStatus
  const got = byName(await runningChecks(dir, paths, info(launchFor(dir, paths).home), {}, { hq, sock: "missing" }))
  expect(got.hq!.status).toBe("ok")
})

test("hq sock and a taken port are two warnings", () => {
  const dir = tempDir()
  const s = { ...status({ listening: false, error: "Address already in use" }), socket_error: "Permission denied" }
  const got = byName(doctor.hqChecks(s, dir, dir))
  expect(got.hq!.status).toBe("warn")
  expect(got.hq!.detail).toContain("Permission denied")
  expect(got["hq port"]!.status).toBe("warn")
  expect(got["hq port"]!.detail).toContain("Address already in use")
})

test("the offices warnings are shown", () => {
  const dir = tempDir()
  const s = { ...status(), warnings: ["the web port is on and this host has other users (ann): ..."] }
  const shown = doctor.hqChecks(s, dir, dir).filter((c) => c.name === "hq warning")
  expect(shown.map((c) => c.detail)).toEqual(s.warnings)
  expect(shown.every((c) => c.status === "warn")).toBe(true)
})

test("the port checks say where the web port is and never mention the web app", () => {
  const dir = tempDir()
  const listening = doctor.hqPortChecks(status(), dir)
  expect(listening.map((c) => [c.name, c.status])).toEqual([["hq", "ok"]])
  const [taken, ...rest] = doctor.hqPortChecks(status({ listening: false, error: "Address already in use" }), dir)
  expect(rest).toEqual([])
  expect(taken!.status).toBe("warn")
  expect(taken!.detail).toStartWith("port 49380 isn't free (Address already in use)")
  expect(taken!.detail).toContain(`set another "port" in ${path.join(dir, "hq.json")}`)
  const both = { ...status({ listening: false, error: "Address already in use" }), socket_error: "Permission denied" }
  expect(doctor.hqPortChecks(both, dir).map((c) => [c.name, c.status])).toEqual([
    ["hq", "warn"],
    ["hq port", "warn"],
  ])
  const unbuilt = status()
  unbuilt.health.app = null
  expect(doctor.hqPortChecks(unbuilt, dir).some((c) => c.name === "web app")).toBe(false)
})

test("the port checks say when the socket file is gone from under the office", () => {
  const dir = tempDir()
  const gone = "the socket file is gone; run `opencorp restart`"
  expect(doctor.hqPortChecks(status(), dir, gone)).toEqual([
    { name: "hq", status: "warn", detail: `not listening on /h/office/hq.sock: ${gone}` },
    { name: "hq port", status: "ok", detail: "web app at http://127.0.0.1:49380/" },
  ])
})

test("a taken port gives the json to write", () => {
  const dir = tempDir()
  const got = byName(doctor.hqChecks(status({ listening: false, error: "Address already in use" }), dir, dir))
  expect(got.hq!.detail).toContain('for example {"port": 49390}')
  expect(got.hq!.detail).toContain("create the file if it doesn't exist; keep any keys it already has")
})

test("an answer that isnt an hq status is unreadable", async () => {
  const bodies = [
    "<html>",
    '{"ok": true}',
    '{"socket": "/s", "tcp": [], "url": null, "health": {}}',
    "[1]",
    JSON.stringify({ ...status(), warnings: [1] }),
  ]
  for (const body of bodies) {
    const sock = await answering(200, body)
    expect(await doctor.hqStatus(sock, undefined, 10_000), body).toBe("unreadable")
  }
  const sock = await answering(200, JSON.stringify(status()))
  expect(await doctor.hqStatus(sock, undefined, 10_000)).toEqual(status())
})

test("a refused device is told to log in", () => {
  const dir = tempDir()
  const [got, ...rest] = doctor.hqChecks("refused", dir, dir)
  expect(rest).toEqual([])
  expect(got!.status).toBe("warn")
  expect(got!.detail).toContain("`opencorp login`")
  expect(got!.detail).not.toContain("restart")
})

test("an unreachable hq is told to restart", () => {
  const dir = tempDir()
  const [got, ...rest] = doctor.hqChecks("unreachable", dir, dir)
  expect(rest).toEqual([])
  expect(got!.status).toBe("warn")
  expect(got!.detail).toContain("`opencorp restart`")
  expect(got!.detail).not.toContain("login")
})

/** What an office running this code for `home` would answer on `GET /office`, with `over` over its fields. */
function info(home: string, over: Partial<OfficeInfo> = {}): OfficeInfo {
  return {
    pid: 42,
    home,
    started_at: "2026-10-25T10:00:00.000Z",
    version: VERSION,
    tools: {},
    guards: { install: [], tools: [], path: [] },
    ...over,
  }
}

/** What `lstat` finds at HQ's socket path: a socket, nothing, a regular file, or an error it can't say more of. */
type Sock = "socket" | "missing" | "file" | "throws"

/** A stand-in `lstat` result (or error) for HQ's socket path. */
function fakeStat(sock: Sock): fs.Stats {
  if (sock === "missing") throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })
  if (sock === "throws") throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
  return { isSocket: () => sock === "socket" } as fs.Stats
}

/** `checks` on a running office at `paths`, whose `GET /hq` answers `hq` (default `status()`) and `GET /office`
 *  answers `office`, with `environ` as the shell's environment and `loadIdentity` reading the identity; `lstat` finds
 *  `sock` at HQ's socket path. */
function runningChecks(
  dir: string,
  paths: OfficePaths,
  office: OfficeInfo | service.Unread,
  environ: Record<string, string> = {},
  {
    sock = "socket",
    hq = status(),
    loadIdentity,
  }: Pick<doctor.CheckOptions, "loadIdentity"> & { sock?: Sock; hq?: HqStatus | service.Unread } = {},
): Promise<Check[]> {
  return doctor.checks(paths.home, {
    host: makeHost(dir, new Runner(), { answers: async () => true }),
    command: COMMAND,
    repo: path.join(dir, "repo"),
    probe: async () => null,
    codex: async () => ({ name: "codex", status: "ok", detail: "stand-in" }),
    environ,
    hq: async () => hq,
    office: async () => office,
    lstat: (p) => (typeof hq !== "string" && p === hq.socket ? fakeStat(sock) : fs.lstatSync(p)),
    loadIdentity,
  })
}

test("a running office reports hq", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const found = await runningChecks(dir, paths, info(launchFor(dir, paths).home))
  const got = byName(found)
  expect(got.hq!.status).toBe("ok")
  expect(got.version).toEqual({ name: "version", status: "ok", detail: "pid 42 runs the current code" })
  expect(got.tools!.status).toBe("ok")
  expect(got.office!.detail).toContain("(pid 42)") // from GET /office; there is no pidfile
  expect(got.connections).toBeUndefined() // none saved; the lstat stand-in reads the real folder
  expect(found.map((c) => c.name).slice(found.findIndex((c) => c.name === "office"))).toEqual([
    "office",
    "pidfile",
    "version",
    "tools",
    "hq",
    "web app",
    "sandbox",
    "codex",
  ])
})

test("a pidfile that disagrees with the office is a warning with the fix", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const home = launchFor(dir, paths).home
  const pidfile = path.join(paths.office, "office.pid")
  fs.writeFileSync(pidfile, "49\n")
  let got = byName(await runningChecks(dir, paths, info(home, { pid: 50 })))
  expect(got.office!.detail).toContain("(pid 50)")
  expect(got.pidfile).toEqual({
    name: "pidfile",
    status: "warn",
    detail: "office.pid says 49 but the office is pid 50; `opencorp restart` rewrites it",
  })
  fs.rmSync(pidfile)
  got = byName(await runningChecks(dir, paths, info(home, { pid: 50 })))
  expect(got.pidfile!.detail).toBe(
    "office.pid is missing or unreadable but the office is pid 50; `opencorp restart` rewrites it",
  )
  fs.writeFileSync(pidfile, "50\n")
  expect(byName(await runningChecks(dir, paths, info(home, { pid: 50 }))).pidfile).toBeUndefined()
  // Another home's office says nothing about this one's pidfile.
  expect(byName(await runningChecks(dir, paths, info("/elsewhere", { pid: 51 }))).pidfile).toBeUndefined()
})

test("a pidfile that isnt a regular file is to be removed before a restart", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const home = launchFor(dir, paths).home
  fs.symlinkSync(path.join(dir, "elsewhere"), path.join(paths.office, "office.pid"))
  const got = byName(await runningChecks(dir, paths, info(home, { pid: 50 })))
  expect(got.pidfile).toEqual({
    name: "pidfile",
    status: "warn",
    detail:
      `${path.join(home, "office", "office.pid")} is not a regular file, and the office's next start refuses it;` +
      " remove it before the next `opencorp restart` (the office is pid 50)",
  })
})

test("a pidfile that is a symlink or fifo shows no pid and never hangs", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const pidfile = path.join(paths.office, "office.pid")
  const target = path.join(dir, "secret")
  fs.writeFileSync(target, "12345\n")
  fs.symlinkSync(target, pidfile)
  const linked = byName(await runningChecks(dir, paths, "unreachable"))
  expect(linked.office!.detail).toContain("(pid ?)")
  fs.rmSync(pidfile)
  execFileSync("mkfifo", [pidfile])
  expect(byName(await runningChecks(dir, paths, "unreachable")).office!.detail).toContain("(pid ?)")
})

test("a pidfile that is a symlink shows no pid and nothing of its target", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir, PROVIDER)
  fs.symlinkSync(setupConnectionFile(paths.office), path.join(paths.office, "office.pid"))
  // With no answer from the office, the pid could come only from the pidfile.
  const found = await runningChecks(dir, paths, "unreachable")
  expect(byName(found).office!.detail).toContain("(pid ?)")
  expect(doctor.report(found)).not.toContain(KEY)
})

test("an office older than the code is told to restart", () => {
  const dir = tempDir()
  const run = launchFor(dir, new OfficePaths(path.join(dir, "home")))
  const office = info(run.home)
  const started = Date.parse(office.started_at)
  const old = doctor.versionCheck(run, office, started + 60_000)
  expect(old.status).toBe("warn")
  expect(old.detail).toBe("the office started before its code last changed; restart it to run the new code")
  expect(doctor.versionCheck(run, office, started - 60_000)).toEqual({
    name: "version",
    status: "ok",
    detail: "pid 42 runs the current code",
  })
})

test("an office of another version or home is told so", () => {
  const dir = tempDir()
  const run = launchFor(dir, new OfficePaths(path.join(dir, "home")))
  const elsewhere = doctor.versionCheck(run, info("/somewhere/else"), 0)
  expect(elsewhere.status).toBe("warn")
  expect(elsewhere.detail).toBe("pid 42 is not this office's daemon: it serves /somewhere/else")
  const older = doctor.versionCheck(run, info(run.home, { version: "0.0.0-old" }), 0)
  expect(older.status).toBe("warn")
  expect(older.detail).toBe(`the office runs 0.0.0-old and this install is ${VERSION}; restart it to run the new code`)
})

test("the newest source covers the office protocol cli and yian", () => {
  const checkout = path.join(tempDir(), "checkout")
  const entry = path.join(checkout, "packages/cli/src/main.ts")
  const files: [string, number][] = [
    [entry, 100],
    [path.join(checkout, "packages/office/src/daemon/x.ts"), 200],
    [path.join(checkout, "packages/protocol/src/y.ts"), 300],
    [path.join(checkout, "packages/yian/src/deep/er/z.ts"), 400],
    [path.join(checkout, "packages/app/src/later.ts"), 900], // not code the office runs
  ]
  for (const [file, when] of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "")
    fs.utimesSync(file, when, when)
  }
  expect(doctor.newestSource(["/usr/local/bin/bun", "--smol", entry])).toBe(400_000)
  fs.utimesSync(entry, 500, 500)
  expect(doctor.newestSource(["/usr/local/bin/bun", entry])).toBe(500_000)
  expect(doctor.newestSource(COMMAND)).toBe(0) // a compiled binary
})

test("every source root the doctor watches exists in this checkout", () => {
  const checkout = fs.realpathSync(fileURLToPath(new URL("../../../..", import.meta.url)))
  const missing = doctor
    .sourceRoots(checkout)
    .filter((root) => !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory())
  expect(missing).toEqual([])
})

test("an office that cant say what it runs warns on the version line", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  for (const why of ["refused", "unreachable", "unreadable"] as const) {
    const got = byName(await runningChecks(dir, paths, why))
    expect(got.version).toEqual({ name: "version", status: "warn", detail: doctor.VERSION_UNREAD[why] })
    expect(got.tools).toBeUndefined()
    expect(got.hq!.status).toBe("ok")
  }
  expect(doctor.VERSION_UNREAD.refused).toContain("`opencorp login`")
  expect(doctor.VERSION_UNREAD.unreachable).toContain("`opencorp restart`")
})

/** `paths` with the CEO's identity saved in its home. */
async function withIdentity(paths: OfficePaths): Promise<string> {
  const file = identityPath(paths.home)
  await writeIdentity(file, new Identity("ngocbh", "mac", newToken()))
  return file
}

test("an unreadable identity gets its own line, and version and hq don't say log in", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const file = await withIdentity(paths)
  fs.chmodSync(file, 0o644)
  const got = byName(await runningChecks(dir, paths, "refused", {}, { hq: "refused" }))
  expect(got.identity!.status).toBe("warn")
  expect(got.identity!.detail).toContain(`\`chmod 600 ${launchFor(dir, paths).home}/identity.json\``)
  for (const line of [got.version!, got.hq!]) {
    expect(line.status).toBe("warn")
    expect(line.detail).toContain("see the identity line")
    expect(line.detail).not.toContain("opencorp login")
  }
})

test("a home that isn't private points the identity line at the home line", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  await withIdentity(paths)
  fs.chmodSync(paths.home, 0o755)
  const got = byName(await runningChecks(dir, paths, "refused", {}, { hq: "refused" }))
  expect(got.home!.status).toBe("warn")
  expect(got.identity!.status).toBe("warn")
  expect(got.identity!.detail).toContain("see the home line")
  expect(got.identity!.detail).not.toContain("chmod 700")
})

test("a folder problem the home line doesn't see goes on the identity line", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const problem = new IdentityUnreadable("folder", "/h must be a directory of yours, not a symlink")
  const got = byName(
    await runningChecks(dir, paths, "refused", {}, {
      loadIdentity: async () => {
        throw problem
      },
    }),
  )
  expect(got.home!.status).toBe("ok")
  expect(got.identity).toEqual({ name: "identity", status: "warn", detail: problem.message })
})

test("a missing identity on a refusing office still says log in; a readable one adds no line", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const missing = byName(await runningChecks(dir, paths, "refused"))
  expect(missing.identity).toBeUndefined()
  expect(missing.version!.detail).toContain("`opencorp login`")
  await withIdentity(paths)
  const readable = byName(await runningChecks(dir, paths, info(launchFor(dir, paths).home)))
  expect(readable.identity).toBeUndefined()
  expect(readable.version!.status).toBe("ok")
})

test("office info is read with this devices token", async () => {
  const office = makeOffice({ tools: { git: "/usr/bin/git" } })
  const home = tempDir()
  const token = newToken()
  giveDevice(office.paths.company, CEO, "mac", token) // enforced from now on
  await writeIdentity(identityPath(home), new Identity(CEO, "mac", token))
  const { sock } = await served(office, { tokens: true })
  const got = await service.officeInfo(sock, await readIdentity(identityPath(home)), 10_000)
  if (typeof got === "string") throw new Error(`unread: ${got}`)
  expect(got.pid).toBe(process.pid)
  expect(got.home).toBe(office.paths.home)
  expect(got.tools).toEqual({ git: "/usr/bin/git" })
  const run = launchFor(home, new OfficePaths(home))
  expect(doctor.report([doctor.versionCheck(run, got, 0), doctor.toolsCheck(got)])).not.toContain(token)
  expect(await service.officeInfo(sock, undefined, 10_000)).toBe("refused") // 401
})

test("an answer that isnt office info is unreadable", async () => {
  for (const body of ["<html>", '{"ok": true}', "[1]"]) {
    const sock = await answering(200, body)
    expect(await service.officeInfo(sock, undefined, 10_000), body).toBe("unreadable")
  }
  expect(await service.officeInfo(await answering(404, "{}"), undefined, 10_000)).toBe("unreachable")
})

/** An executable file in a fresh temp dir. */
function program(): string {
  const file = path.join(tempDir(), "prog")
  fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 })
  return file
}

test("every pinned tool still there is ok", () => {
  const got = doctor.toolsCheck(info("/h", { tools: { git: program(), ps: program() } }))
  expect(got.status).toBe("ok")
  expect(got.detail).toBe("every program the office runs is where it found it at start")
})

test("a pinned tool that vanished is told to restart the office", () => {
  const gone = path.join(tempDir(), "gone")
  const noGit = doctor.toolsCheck(info("/h", { tools: { git: gone, ps: program() } }))
  expect(noGit.status).toBe("fail")
  expect(noGit.detail).toBe(
    `\`git\` at ${gone} is gone, so the office can't run it; ` +
      "restart the office (`opencorp restart`) so it looks for them on its PATH again",
  )
  const noPs = doctor.toolsCheck(info("/h", { tools: { git: program(), ps: gone } }))
  expect(noPs.status).toBe("warn")
  expect(noPs.detail).toContain(`\`ps\` at ${gone} is gone`)
})

test.skipIf(!sandboxAvailable())("the sandbox probe runs the file helper under its profile", async () => {
  expect(await doctor.sandboxProblem(path.join(tempDir(), "home"))).toBeNull()
})

test("a helper inside the office home fails the sandbox check", async () => {
  // The checkout root holds the helper's source, so no sandboxed call is ever made.
  const root = fs.realpathSync(fileURLToPath(new URL("../../../..", import.meta.url)))
  const { helper } = helperCommand()
  const file = "entry" in helper ? helper.entry : helper.binary
  const found = await doctor.checks(root, {
    host: makeHost(tempDir(), new Runner()),
    command: COMMAND,
    repo: root,
    codex: async () => ({ name: "codex", status: "ok", detail: "stand-in" }),
    environ: {},
    hq: async () => "unreachable",
    office: async () => "unreachable",
  })
  expect(byName(found).sandbox).toEqual({
    name: "sandbox",
    status: "fail",
    detail: `the file helper ${file} lies inside the office home ${root}`,
  })
})

/** The office's store at `paths` made by the daemon's own code, holding a worked folder for each of `cwds`. */
function storeWith(paths: OfficePaths, ...cwds: string[]): void {
  const store = new Store(paths.store)
  try {
    for (const cwd of cwds) store.touchWorkedFolder(CEO, cwd)
  } finally {
    store.close()
  }
}

/** `dir`'s folders `names` made, each as its realpath. */
function folders(dir: string, ...names: string[]): string[] {
  return names.map((name) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true })
    return fs.realpathSync(path.join(dir, name))
  })
}

test("a worked folder holding the install fails the folders check", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const [work] = folders(dir, "work")
  const entry = path.join(dir, "work/checkout/packages/cli/src/main.ts")
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry, "")
  storeWith(paths, path.join(dir, "work"))
  const found = await runChecks(dir, paths, { command: [process.execPath, entry] })
  expect(byName(found).folders).toEqual({
    name: "folders",
    status: "fail",
    detail: `workspace ${work} contains ${work}/checkout, where the office or a program it runs is installed; use a project folder`,
  })
  expect(found.map((c) => c.name).slice(-3)).toEqual(["sandbox", "folders", "codex"])
  expect(doctor.exitCode(found)).toBe(1)
})

test("a worked folder holding a pinned tool or a path entry fails the folders check", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const [work, other] = folders(dir, "work/bin", "other/bin").map((bin) => path.dirname(bin))
  fs.writeFileSync(path.join(dir, "work/bin/git"), "#!/bin/sh\n", { mode: 0o755 })
  storeWith(paths, path.join(dir, "other"), path.join(dir, "work"), path.join(dir, "gone"))
  const environ = { PATH: `${dir}/work/bin:${dir}/other/bin` }
  expect(byName(await runChecks(dir, paths, { environ })).folders).toEqual({
    name: "folders",
    status: "fail",
    detail:
      `workspace ${other} contains ${other}/bin, a folder on the office's PATH; use a project folder; ` +
      `workspace ${work} contains ${work}/bin/git, a program the office runs; use a project folder`,
  })
})

test("the folders check finds tool install folders against the host's home", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  fs.mkdirSync(path.join(dir, "bin"))
  fs.writeFileSync(path.join(dir, "bin/git"), "#!/bin/sh\n", { mode: 0o755 })
  folders(dir, "work")
  storeWith(paths, path.join(dir, "work"))
  // The host's home is `dir`, so `dir/bin/git` must not make `dir` itself an install folder.
  expect(byName(await runChecks(dir, paths, { environ: { PATH: `${dir}/bin` } })).folders).toEqual({
    name: "folders",
    status: "ok",
    detail: "no worked folder holds the office install, a program it runs or a folder on its PATH",
  })
})

test("the folders check keeps tool install folders clear of the office home", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  fs.mkdirSync(path.join(paths.home, "bin"))
  fs.writeFileSync(path.join(paths.home, "bin/git"), "#!/bin/sh\n", { mode: 0o755 })
  fs.mkdirSync(path.join(paths.worktrees, "w"), { recursive: true })
  storeWith(paths, path.join(paths.worktrees, "w"))
  // `<office home>/bin/git` must not make the office home, which holds the run worktrees, an install folder.
  expect(byName(await runChecks(dir, paths, { environ: { PATH: `${paths.home}/bin` } })).folders).toEqual({
    name: "folders",
    status: "ok",
    detail: "no worked folder holds the office install, a program it runs or a folder on its PATH",
  })
})

test("the folders check uses the tools the daemon pinned", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const [work] = folders(dir, "work/bin").map((bin) => path.dirname(bin))
  fs.writeFileSync(path.join(dir, "work/bin/git"), "#!/bin/sh\n", { mode: 0o755 })
  storeWith(paths, path.join(dir, "work"))
  const environ = { PATH: "/usr/bin:/bin" }
  const office = info(launchFor(dir, paths).home, {
    guards: { install: [], tools: [path.join(dir, "work/bin/git")], path: [] },
  })
  expect(byName(await runningChecks(dir, paths, office, environ)).folders).toEqual({
    name: "folders",
    status: "fail",
    detail: `workspace ${work} contains ${work}/bin/git, a program the office runs; use a project folder`,
  })
  // The caller's view finds nothing wrong there.
  expect(byName(await runChecks(dir, paths, { environ })).folders).toEqual({
    name: "folders",
    status: "ok",
    detail: "no worked folder holds the office install, a program it runs or a folder on its PATH",
  })
})

test("an office without a store has no folders line", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  expect(byName(await runChecks(dir, paths)).folders).toBeUndefined()
})

test("a stopped offices store is read without its wal files", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const [work] = folders(dir, "work")
  storeWith(paths, path.join(dir, "work"))
  const environ = { PATH: `${dir}/work` }
  const expected: Check = {
    name: "folders",
    status: "fail",
    detail: `workspace ${work} contains ${work}, a folder on the office's PATH; use a project folder`,
  }
  expect(byName(await runChecks(dir, paths, { environ })).folders).toEqual(expected)
  for (const sidecar of ["-wal", "-shm"]) fs.rmSync(paths.store + sidecar, { force: true })
  expect(byName(await runChecks(dir, paths, { environ })).folders).toEqual(expected)
})

const MOVE_ASIDE =
  "move it aside (the office then starts with an empty store and its records are lost) or restore it from a backup"

test("a store that isnt a database fails its own line and has no folders line", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  fs.writeFileSync(paths.store, "not a database ".repeat(100))
  const store = new OfficePaths(launchFor(dir, paths).home).store
  const found = await runChecks(dir, paths)
  expect(byName(found).store).toEqual({
    name: "store",
    status: "fail",
    detail: `the store ${store} isn't a SQLite database (SQLITE_NOTADB); ${MOVE_ASIDE}`,
  })
  expect(byName(found).folders).toBeUndefined()
  expect(doctor.exitCode(found)).toBe(1)
})

test("an office without a store has no store line", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  expect(byName(await runChecks(dir, paths)).store).toBeUndefined()
})

test("a store that is a symlink fails and its target is never opened", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  const fifo = path.join(dir, "fifo")
  execFileSync("mkfifo", [fifo])
  fs.symlinkSync(fifo, paths.store)
  const store = new OfficePaths(launchFor(dir, paths).home).store
  expect(byName(await runChecks(dir, paths)).store).toEqual({
    name: "store",
    status: "fail",
    detail: `store file ${store} is not a regular file; ${MOVE_ASIDE}`,
  })
})

test("a store newer than the code fails with both versions and a good one is ok", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  storeWith(paths)
  const store = new OfficePaths(launchFor(dir, paths).home).store
  expect(byName(await runChecks(dir, paths)).store).toEqual({
    name: "store",
    status: "ok",
    detail: `${store} (schema version ${latestVersion()})`,
  })
  const db = openSqlite(paths.store)
  db.exec(`PRAGMA user_version = ${latestVersion() + 1}`)
  db.close()
  const got = byName(await runChecks(dir, paths)).store!
  expect(got.status).toBe("fail")
  expect(got.detail).toContain(`store is at version ${latestVersion() + 1}, newer than this code (${latestVersion()})`)
})

