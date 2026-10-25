/** Python's `tests/install/test_doctor.py`. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { writeCompany } from "../../src/company_template/index.ts"
import { logLine } from "../../src/daemon/http.ts"
import { OfficePaths } from "../../src/daemon/office.ts"
import * as doctor from "../../src/install/doctor.ts"
import type { Check } from "../../src/install/doctor.ts"
import { INHERITED_ENV, launch } from "../../src/install/launch.ts"
import * as launchd from "../../src/install/launchd.ts"
import { SET_UP, setupConnectionFile } from "../../src/install/onboard.ts"
import * as systemd from "../../src/install/systemd.ts"
import { writePrivate } from "../../src/secrets.ts"
import { git } from "../company/helpers.ts"
import { tempDir } from "../helpers.ts"
import { makeHost, Runner } from "./helpers.ts"

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
    probe = async () => null,
    platform = "darwin",
    lstat,
  }: {
    runner?: Runner
    answers?: boolean
    probe?: (officeHome: string) => Promise<string | null>
    platform?: NodeJS.Platform
    lstat?: (p: string) => fs.Stats
  } = {},
): Promise<Check[]> {
  const host = makeHost(dir, runner, { answers: async () => answers, platform })
  return doctor.checks(paths.home, {
    host,
    command: COMMAND,
    repo: path.join(dir, "repo"),
    probe,
    codex: async () => ({ name: "codex", status: "ok", detail: "stand-in" }),
    environ: {},
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
      `${paths.company} has no company yet (no company.yaml, or no first commit);` +
      " run `opencorp init` to finish it",
  })
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
    "The office is running; stop it and run `opencorp onboard` again to add 1 template file.",
  )
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
  expect(got.office!.detail).toContain("Run `opencorp start`.")
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

test("an office log that isnt a regular file is no crash", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  fs.mkdirSync(path.join(paths.office, "office.log"))
  const got = byName(await runChecks(dir, paths))
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
    expect(managed.detail).toContain("stop the office and run `opencorp onboard` again from that shell")
    expect(managed.detail).not.toContain("opencorp restart")
    const override = await doctor.codexCheck(missing, { OPENCORP_CODEX_BIN: "/nowhere/codex" }, mode)
    expect(override.detail).toContain("stop the office and run `opencorp onboard` again from that shell")
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
