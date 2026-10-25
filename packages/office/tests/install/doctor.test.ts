/** Python's `tests/install/test_doctor.py`. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { writeCompany } from "../../src/company_template/index.ts"
import { OfficePaths } from "../../src/daemon/office.ts"
import * as doctor from "../../src/install/doctor.ts"
import type { Check } from "../../src/install/doctor.ts"
import { SET_UP, setupConnectionFile } from "../../src/install/onboard.ts"
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
    command: ["/opt/opencorp/bin/opencorp"],
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

test("a home others can read warns", async () => {
  const dir = tempDir()
  const paths = await onboarded(dir)
  fs.chmodSync(paths.home, 0o755)
  const got = byName(await runChecks(dir, paths))
  expect(got.home!.status).toBe("warn")
  expect(got.home!.detail).toContain("0755, not 0700")
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
