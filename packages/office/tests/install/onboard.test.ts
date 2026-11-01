/** Onboarding this machine: the home, the company clone and join, this device, the model check and the service
 *  start. */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { expect, onTestFinished, test } from "bun:test"
import type { Device } from "@opencorp/protocol"
import { loadFlow } from "@ngocbh/yian"
import { lockFile } from "@ngocbh/yian/platform"
import { stringify } from "yaml"
import { deviceName, Identity, readIdentity, writeIdentity } from "../../src/auth/identity.ts"
import { hashPassword } from "../../src/auth/passwords.ts"
import { newToken, tokenSha256 } from "../../src/auth/tokens.ts"
import { Provider } from "../../src/chat/provider.ts"
import { loadRepo } from "../../src/company/loader.ts"
import { writeCompany } from "../../src/company_template/index.ts"
import { makeOfficeDir } from "../../src/daemon/sockets.ts"
import {
  makeHome,
  modelProblem,
  officeRunning,
  type OnboardOptions,
  onboard,
  ownerDefaults,
  redact,
  runSetup,
  setupConnectionFile,
  stopToTopUp,
  WHO,
} from "../../src/install/onboard.ts"
import * as fallback from "../../src/install/fallback.ts"
import { launch } from "../../src/install/launch.ts"
import { OnboardError, TRIES, TtyPrompter } from "../../src/install/prompts.ts"
import { selfSpawnEnv } from "../../src/platform.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { fakeLlm, keyCopies, MIXED_KEY, refusingLlm } from "../chat/helpers.ts"
import { git, gitEnv } from "../company/helpers.ts"
import { request } from "../daemon/helpers.ts"
import { shortDir, tempDir } from "../helpers.ts"
import { daemonHost, killedAtEnd, makeHost, NO_LISTING, Runner, Script, specifiers } from "./helpers.ts"

const KEY = "sk-test-0000000000000000"
const PROVIDER_JSON = '{"llm_config": {"provider": "openai"}}'
const PASSWORD = "pw-sentinel-77ab"

const OFFICE = fileURLToPath(new URL("../..", import.meta.url))
const ONBOARD = fileURLToPath(new URL("../../src/install/onboard.ts", import.meta.url))
const PROVIDER = fileURLToPath(new URL("../../src/chat/provider.ts", import.meta.url))
const FAKE_LLM = fileURLToPath(new URL("../../src/testing/fake_llm.ts", import.meta.url))

test("the owner defaults come from the login", () => {
  expect(ownerDefaults("ngocbh", "Hong Ngoc Bui,,,")).toEqual(["Hong Ngoc Bui", "ngocbh"])
  expect(ownerDefaults("Ngoc_Bui", "")).toEqual(["Ngoc_Bui", "ngoc-bui"])
})

/** A company at `home` made as `opencorp init` makes it, with `handle` as CEO and no device. */
async function company(home: string, handle = "me"): Promise<string> {
  const root = path.join(home, "company")
  await writeCompany(root, path.join(home, "office", "worktrees"), { company: "Acme", owner: { handle, name: "Me" } })
  return root
}

/** A fresh provider on stdin. */
function provider(): Readable {
  return Readable.from([PROVIDER_JSON])
}

/** The options every test passes: listers and a model check that reach no provider; git without the user's
 *  config; a stand-in host, so no test reaches the real service tools; and a login no company lists, so no test
 *  reads the account database. */
function base(dir: string): OnboardOptions {
  return {
    listers: NO_LISTING,
    checkModel: async () => null,
    environ: gitEnv(process.env),
    host: makeHost(dir, new Runner()),
    loginDefaults: () => ["Someone", "someone-unlisted"],
  }
}

/** A writable that keeps what is written; not a terminal. */
function collector(): { stream: Writable; text: () => string } {
  let text = ""
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      text += chunk.toString()
      done()
    },
  })
  return { stream, text: () => text }
}

/** A terminal prompter with no one to ask, reading from an empty pipe; `preset` answers questions by their text. */
function nonInteractive(preset: Record<string, string> = {}): TtyPrompter {
  const output = collector().stream
  return new TtyPrompter({ interactive: false, preset, input: Readable.from([""]), output, env: {} })
}

/** What `promise` rejects with. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("it resolved")
}

test("a file home is not a directory", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  fs.writeFileSync(home, "")
  const run = new Runner()
  const error = await rejection(onboard(home, new Script(), { ...base(dir), host: makeHost(dir, run) }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toBe(`${fs.realpathSync(home)} is not a directory`)
  expect(run.calls).toEqual([])
  expect(fs.readFileSync(home, "utf8")).toBe("")
})

test("lint errors stop onboarding before anything runs", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const root = await company(home)
  fs.writeFileSync(path.join(root, "company.yaml"), "name: Acme\nceo: nobody\n")
  const run = new Runner()
  const error = await rejection(onboard(home, new Script(), { ...base(dir), host: makeHost(dir, run) }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("company.unknown_ceo")
  expect(run.calls).toEqual([])
  expect(fs.existsSync(path.join(home, "office", "install.json"))).toBe(false)
  expect(fs.existsSync(setupConnectionFile(path.join(home, "office")))).toBe(false)
})

test("an existing company without an identity suggests login", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  await company(home)
  const ask = new Script()
  await onboard(home, ask, {
    ...base(dir),
    stdin: provider(),
    host: makeHost(dir, new Runner(), { answers: async () => true }),
  })
  expect(ask.seen).toContain("This device has no identity yet; run `opencorp login` to use opencorp from it.")
  expect(fs.existsSync(path.join(home, "identity.json"))).toBe(false)
  expect(ask.seen.filter((line) => line.startsWith("Step "))).toEqual([
    "Step 1 of 4: Company",
    "Step 2 of 4: This device",
    "Step 3 of 4: Model",
    "Step 4 of 4: Office",
  ])
})

test("onboard saves no provider whose model doesnt answer", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  await company(home)
  const error = await rejection(
    onboard(home, new Script(), {
      ...base(dir),
      checkModel: async () => "Connection error",
      stdin: provider(),
      host: makeHost(dir, new Runner(), { answers: async () => true }),
    }),
  )
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toBe("the model didn't answer: Connection error")
  expect(fs.existsSync(setupConnectionFile(path.join(home, "office")))).toBe(false)
})

test("an office started by hand is left alone", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  await company(home)
  const ask = new Script()
  await onboard(home, ask, {
    ...base(dir),
    stdin: provider(),
    host: makeHost(dir, new Runner(), { answers: async () => true }),
  })
  expect(ask.seen.some((line) => line.includes("not started by a service"))).toBe(true)
})

/** Onboards the company made at `home` to the end, beside a running office, with `environ` as the caller's env;
 *  returns what it said. */
async function onboardRunning(dir: string, home: string, more: Partial<OnboardOptions> = {}): Promise<string[]> {
  const ask = new Script()
  await onboard(home, ask, {
    ...base(dir),
    stdin: provider(),
    host: makeHost(dir, new Runner(), { answers: async () => true }),
    ...more,
  })
  return ask.seen
}

/** The caller's env without OPENCORP_HOME. */
function noHomeEnv(): Record<string, string> {
  const { OPENCORP_HOME: _, ...rest } = gitEnv(process.env)
  return rest
}

test("--from on a home that has a company says it was ignored", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  await company(home)
  const seen = await onboardRunning(dir, home, { source: "https://example.com/acme.git" })
  const repo = seen.filter((line) => line.startsWith("Company repo:"))
  expect(repo).toEqual([
    `Company repo: up to date at ${path.join(fs.realpathSync(home), "company")} (--from ignored: there's a company here already)`,
  ])
  expect(seen.join("\n")).not.toContain("example.com")
  // Nor is a missing template file's line silent about it.
  const other = path.join(dir, "other")
  const root = await company(other)
  fs.unlinkSync(path.join(root, "shared/flows/side_chat.yaml"))
  git(root, "commit", "-qam", "drop a flow")
  const running = await onboardRunning(dir, other, { source: "https://example.com/acme.git" })
  expect(running.filter((line) => line.startsWith("Company repo:"))[0]).toEndWith(
    "(--from ignored: there's a company here already)",
  )
})

test("an office a client here wouldn't find ends with how to reach it", async () => {
  const dir = tempDir()
  for (const name of ["home", "my home"]) {
    const home = path.join(dir, name)
    await company(home)
    const seen = await onboardRunning(dir, home, { environ: noHomeEnv() })
    expect(seen.at(-1)).toBe(
      "Done. This office isn't the one `opencorp` finds in this shell, so first run " +
        `\`export OPENCORP_HOME=${fallback.shQuote(fs.realpathSync(home))}\` (add it to your shell profile to keep it), ` +
        "then run `opencorp` in a project folder to talk to your team.",
    )
  }
  expect(fallback.shQuote(fs.realpathSync(path.join(dir, "my home")))).toStartWith("'")
})

test("an office a client here finds ends with the plain line", async () => {
  const dir = tempDir()
  const plain = "Done. Run `opencorp` in a project folder to talk to your team."
  const home = path.join(dir, "home")
  await company(home)
  expect((await onboardRunning(dir, home, { environ: { ...noHomeEnv(), OPENCORP_HOME: home } })).at(-1)).toBe(plain)
  // makeHost's user home is `dir`, so `dir/.opencorp` is the default home.
  const usual = path.join(dir, ".opencorp")
  await company(usual)
  expect((await onboardRunning(dir, usual, { environ: noHomeEnv() })).at(-1)).toBe(plain)
})

test("a running office is not topped up behind its back", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const root = await company(home)
  fs.unlinkSync(path.join(root, "shared/flows/side_chat.yaml"))
  fs.unlinkSync(path.join(root, "shared/flows/profile_manager.yaml"))
  git(root, "commit", "-qam", "drop two flows")
  const head = git(root, "rev-parse", "HEAD")
  const ask = new Script()
  await onboard(home, ask, {
    ...base(dir),
    stdin: provider(),
    host: makeHost(dir, new Runner(), { answers: async () => true }),
  })
  expect(ask.seen.join("\n")).toContain(
    "The office is running; run `opencorp stop`, then `opencorp onboard` again to add 2 template files.",
  )
  expect(fs.existsSync(path.join(root, "shared/flows/side_chat.yaml"))).toBe(false)
  expect(git(root, "rev-parse", "HEAD")).toBe(head)
})

test("a running office without a company is not written to", async () => {
  const dir = tempDir()
  const error = await rejection(
    onboard(path.join(dir, "home"), new Script(), {
      ...base(dir),
      host: makeHost(dir, new Runner(), { answers: async () => true }),
    }),
  )
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toMatch(/running, but .* has no company yet/)
  expect(fs.existsSync(path.join(dir, "home", "company"))).toBe(false)
})

test("onboard over a locked office that doesnt answer writes nothing", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const root = await company(home)
  fs.unlinkSync(path.join(root, "shared/flows/side_chat.yaml"))
  git(root, "commit", "-qam", "drop a flow")
  const head = git(root, "rev-parse", "HEAD")
  const ask = new Script()
  const seen: string[] = []
  const host = makeHost(dir, new Runner(), {
    locked: (lockPath) => {
      seen.push(lockPath)
      return true
    },
  })
  // The office never answers, so the service step fails after its wait; the company must be left alone first.
  await onboard(home, ask, { ...base(dir), stdin: provider(), host }).catch(() => {})
  expect(seen).toEqual([path.join(fs.realpathSync(home), "office", "office.lock")])
  expect(ask.seen.join("\n")).toContain(stopToTopUp(1))
  expect(fs.existsSync(path.join(root, "shared/flows/side_chat.yaml"))).toBe(false)
  expect(git(root, "rev-parse", "HEAD")).toBe(head)

  const fresh = path.join(dir, "fresh")
  const error = await rejection(onboard(fresh, new Script(), { ...base(dir), host }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toMatch(/running, but .* has no company yet/)
  expect(fs.existsSync(path.join(fresh, "company"))).toBe(false)
})

test("a lock that cant be checked stops onboard", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const root = await company(home)
  fs.unlinkSync(path.join(root, "shared/flows/side_chat.yaml"))
  git(root, "commit", "-qam", "drop a flow")
  const head = git(root, "rev-parse", "HEAD")
  const host = makeHost(dir, new Runner(), {
    locked: () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
    },
  })
  const error = await rejection(onboard(home, new Script(), { ...base(dir), stdin: provider(), host }))
  expect(error).toBeInstanceOf(OnboardError)
  const lock = path.join(fs.realpathSync(home), "office", "office.lock")
  expect(error.message).toBe(`can't tell whether the office is running: can't check ${lock}: Permission denied`)
  expect(git(root, "rev-parse", "HEAD")).toBe(head)
})

test("the default lock check sees a lock held by another process", async () => {
  const dir = shortDir()
  const one = launch(path.join(dir, "home"), { environ: {}, userHome: dir })
  makeOfficeDir(one.office)
  const host = { ...makeHost(dir, new Runner()), locked: undefined }
  expect(await officeRunning(one, host)).toBe(false)
  const lock = path.join(one.office, "office.lock")
  const code = [
    'import { lockFile } from "@ngocbh/yian/platform"',
    `const held = lockFile(${JSON.stringify(lock)}, { private: true })`,
    'console.log("held")',
    "setInterval(() => {}, 60_000)",
  ].join("\n")
  const child = Bun.spawn([process.execPath, "--no-install", "--no-env-file", "--config=/dev/null", "-e", code], {
    cwd: OFFICE,
    env: { PATH: process.env.PATH },
    stdout: "pipe",
    stderr: "inherit",
  })
  try {
    const reader = child.stdout.getReader()
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toBe("held\n")
    expect(await officeRunning(one, host)).toBe(true)
  } finally {
    child.kill("SIGKILL")
    await child.exited
  }
  expect(child.killed || child.exitCode !== null).toBe(true)
  expect(await officeRunning(one, host)).toBe(false)
})

/** Onboards with auto, then again from a shell with another env; returns the second run's commands. */
async function onboardTwice(dir: string, platform: NodeJS.Platform, started: string[][]): Promise<string[][]> {
  const home = path.join(dir, "home")
  await company(home)
  const run = new Runner()
  const host = makeHost(dir, run, {
    platform,
    answers: async () => run.calls.some((call) => started.some((s) => isDeepStrictEqual(call.slice(0, 3), s))),
  })
  await onboard(home, new Script(), {
    ...base(dir),
    stdin: provider(),
    host,
    environ: { PATH: "/usr/bin", LC_TERMINAL_VERSION: "3.5.0" },
  })
  const first = run.calls.length
  await onboard(home, new Script(), {
    ...base(dir),
    stdin: provider(),
    host,
    environ: { PATH: "/opt/homebrew/bin:/usr/bin", LC_TERMINAL_VERSION: "3.6.0" },
  })
  return run.calls.slice(first)
}

test("a second onboard from another shell leaves a running launch agent alone", async () => {
  const again = await onboardTwice(tempDir(), "darwin", [["launchctl", "bootstrap", "gui/501"]])
  expect(again.map((call) => call[1])).toEqual(["print"])
})

test("a second onboard from another shell leaves a running systemd unit alone", async () => {
  const again = await onboardTwice(tempDir(), "linux", [["systemctl", "--user", "restart"]])
  expect(again.map((call) => call[2])).toEqual(["is-enabled"])
})

/** Options that stop onboarding once this device is done: the model check throws, before anything is saved. */
function stopAfterTheDevice(): Pick<OnboardOptions, "stdin" | "checkModel"> {
  return {
    stdin: provider(),
    checkModel: async () => {
      throw new OnboardError("stop")
    },
  }
}

/** A company whose humans are `humans` (the first is CEO), pushed to a bare repo; resolves the bare repo's path.
 *  `passwords` and `devices` give humans, by handle, a password's hash and a device list. */
async function published(
  dir: string,
  humans: string[] = ["ceo", "lan"],
  passwords: Record<string, string> = {},
  devices: Record<string, Device[]> = {},
): Promise<string> {
  const src = await company(path.join(dir, "src"), humans[0])
  for (const handle of humans.slice(1)) {
    fs.mkdirSync(path.join(src, "people", handle))
    const name = handle.slice(0, 1).toUpperCase() + handle.slice(1)
    fs.writeFileSync(
      path.join(src, "people", handle, "person.yaml"),
      `handle: ${handle}\nname: ${name}\nkind: human\ntitle: Engineer\nmanager: ${humans[0]}\n`,
    )
  }
  for (const [handle, password] of Object.entries(passwords)) {
    const line = `password_hash: ${JSON.stringify(await hashPassword(password))}\n`
    fs.appendFileSync(path.join(src, "people", handle, "person.yaml"), line)
  }
  for (const [handle, listed] of Object.entries(devices)) {
    fs.appendFileSync(path.join(src, "people", handle, "person.yaml"), stringify({ devices: listed }))
  }
  if (humans.length > 1 || Object.keys(passwords).length > 0 || Object.keys(devices).length > 0) {
    git(src, "add", "-A")
    git(src, "commit", "-qm", "hire the humans")
  }
  const remote = path.join(dir, "acme.git")
  cloneQuietly(["--bare", src, remote])
  return remote
}

/** `git clone -q <args>` without the user's git config; throws on a failure. */
function cloneQuietly(args: string[]): void {
  const done = spawnSync("git", ["clone", "-q", ...args], { env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] })
  if (done.status !== 0) throw new Error(`git clone failed: ${done.stderr?.toString() ?? done.error}`)
}

test("onboard clones the company and commits this device for the human you pick", async () => {
  const dir = tempDir()
  const remote = await published(dir)
  const home = path.join(dir, "home")
  const ask = new Script(["lan"])
  const error = await rejection(onboard(home, ask, { ...base(dir), ...stopAfterTheDevice(), source: remote }))
  expect(error.message).toBe("stop")
  const me = (await readIdentity(path.join(home, "identity.json")))!
  expect([me.handle, me.device]).toEqual(["lan", deviceName()])
  const root = path.join(home, "company")
  expect(loadRepo(root).people.get("lan")!.devices).toEqual([{ name: me.device, token_sha256: tokenSha256(me.token) }])
  expect(git(root, "log", "-1", "--format=%s")).toBe(`devices(@lan): add ${me.device}`)
  expect(git(root, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main")
  expect(git(root, "status", "--porcelain")).toBe("")
  expect(fs.readdirSync(home).sort()).toEqual([".lock", "company", "identity.json", "office"])
  expect(ask.offered).toEqual([["ceo", "lan"]])
  expect(ask.seen.filter((line) => line.startsWith("The company's"))).toEqual([])
  expect(ask.seen.filter((line) => line.includes(me.token))).toEqual([])
  expect(ask.seen.join("\n")).not.toContain("--from ignored")
})

test("joining as a human with a password needs it", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const ask = new Script(["lan", "wrong-password", PASSWORD])
  const source = await published(dir, undefined, { lan: PASSWORD })
  const error = await rejection(onboard(home, ask, { ...base(dir), ...stopAfterTheDevice(), source }))
  expect(error.message).toBe("stop")
  const me = (await readIdentity(path.join(home, "identity.json")))!
  expect(me.handle).toBe("lan")
  expect(loadRepo(path.join(home, "company")).people.get("lan")!.devices.map((d) => d.name)).toEqual([me.device])
  expect(ask.seen.filter((line) => line === "@lan's password (not shown)")).toHaveLength(2)
  expect(ask.seen).toContain("That doesn't work: wrong password")
  expect(ask.seen.filter((line) => line.includes(PASSWORD))).toEqual([])
})

test("a password that never matches stops and leaves no company", async () => {
  const dir = tempDir()
  const source = await published(dir, undefined, { lan: PASSWORD })
  const ask = new Script(["lan", ...Array<string>(TRIES).fill("nope-nope")])
  const error = await rejection(onboard(path.join(dir, "home"), ask, { ...base(dir), source }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("wrong password for @lan")
  expect(fs.readdirSync(path.join(dir, "home")).sort()).toEqual(["office"])
})

test("without a terminal for the password the company joins without this device", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const source = await published(dir, undefined, { lan: PASSWORD })
  const error = await rejection(
    onboard(home, nonInteractive({ [WHO]: "lan" }), { ...base(dir), ...stopAfterTheDevice(), source }),
  )
  expect(error.message).toBe("stop")
  expect(fs.existsSync(path.join(home, "identity.json"))).toBe(false)
  expect(loadRepo(path.join(home, "company")).people.get("lan")!.devices).toEqual([])
  expect(git(path.join(home, "company"), "log", "-1", "--format=%s")).toBe("hire the humans")
})

test("a human without a password joins and is told to set one", async () => {
  const dir = tempDir()
  const ask = new Script(["lan"])
  const source = await published(dir)
  const error = await rejection(onboard(path.join(dir, "home"), ask, { ...base(dir), ...stopAfterTheDevice(), source }))
  expect(error.message).toBe("stop")
  expect((await readIdentity(path.join(dir, "home", "identity.json")))!.handle).toBe("lan")
  expect(ask.seen).toContain(
    "@lan has no password yet; set one with `opencorp password` so a new device has to give it",
  )
})

/** Onboards the existing company at `home`, on a running office; resolves to what onboarding said. */
async function onboardExisting(dir: string, home: string): Promise<string[]> {
  const ask = new Script()
  await onboard(home, ask, {
    ...base(dir),
    stdin: provider(),
    host: makeHost(dir, new Runner(), { answers: async () => true }),
  })
  return ask.seen
}

test("an existing company with an unreadable identity says why", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  await company(home)
  fs.chmodSync(home, 0o700) // as onboarding leaves it; writeIdentity refuses a home that isn't private
  const file = path.join(home, "identity.json")
  await writeIdentity(file, new Identity("me", "mac", newToken()))
  fs.chmodSync(file, 0o644)
  const seen = await onboardExisting(dir, home)
  const said = seen.filter((line) => line.startsWith("This device's identity can't be used:"))
  expect(said).toHaveLength(1)
  expect(said[0]).toContain(`\`chmod 600 ${file}\``)
  expect(seen.some((line) => line.includes("no identity yet"))).toBe(false)
  expect(fs.statSync(file).mode & 0o777).toBe(0o644)
})

test("an existing company that doesn't list this device's token says so, not acting as", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  await company(home)
  fs.chmodSync(home, 0o700) // as onboarding leaves it; writeIdentity refuses a home that isn't private
  const file = path.join(home, "identity.json")
  await writeIdentity(file, new Identity("me", "mac", newToken()))
  const seen = await onboardExisting(dir, home)
  expect(seen).toContain(
    `This device's identity (${file}) is @me's mac, but the company doesn't list its token; \`opencorp login\` says how to get it listed.`,
  )
  expect(seen.some((line) => line.includes("acting as"))).toBe(false)
})

test("an identity the company already lists is kept and nothing is asked", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  fs.mkdirSync(home)
  // writeIdentity refuses an existing folder that isn't private.
  fs.chmodSync(home, 0o700)
  const me = new Identity("lan", "old-mac", newToken())
  await writeIdentity(path.join(home, "identity.json"), me)
  const source = await published(dir, undefined, { lan: PASSWORD }, {
    lan: [{ name: "old-mac", token_sha256: tokenSha256(me.token) }],
  })
  const ask = new Script() // no answers: nothing may be asked
  const error = await rejection(onboard(home, ask, { ...base(dir), ...stopAfterTheDevice(), source }))
  expect(error.message).toBe("stop")
  expect(await readIdentity(path.join(home, "identity.json"))).toEqual(me)
  expect(git(path.join(home, "company"), "log", "-1", "--format=%s")).toBe("hire the humans")
  expect(ask.seen).toContain(
    `This device: old-mac, acting as @lan (its token is in ${path.join(home, "identity.json")})`,
  )
})

test("onboard asks for the repo when not given one", async () => {
  const dir = tempDir()
  const remote = await published(dir, ["ceo"])
  const ask = new Script([remote, ""]) // the only human is the default
  const error = await rejection(onboard(path.join(dir, "home"), ask, { ...base(dir), ...stopAfterTheDevice() }))
  expect(error.message).toBe("stop")
  expect((await readIdentity(path.join(dir, "home", "identity.json")))!.handle).toBe("ceo")
})

test("the human named like this login is the default", async () => {
  const dir = tempDir()
  const source = await published(dir)
  const error = await rejection(
    onboard(path.join(dir, "home"), new Script([""]), {
      ...base(dir),
      ...stopAfterTheDevice(),
      source,
      loginDefaults: () => ["Lan", "lan"],
    }),
  )
  expect(error.message).toBe("stop")
  expect((await readIdentity(path.join(dir, "home", "identity.json")))!.handle).toBe("lan")
})

test("no human to default to and no answer stops without a company", async () => {
  const dir = tempDir()
  const source = await published(dir)
  const error = await rejection(
    onboard(path.join(dir, "home"), nonInteractive(), {
      ...base(dir),
      source,
      loginDefaults: () => ["X", "someone-else"],
    }),
  )
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("no usable answer")
  expect(fs.readdirSync(path.join(dir, "home")).sort()).toEqual(["office"])
})

test("no pick with no default says who to pick and names the flag", async () => {
  const dir = tempDir()
  const ask = new Script(Array<string>(TRIES).fill(""))
  const source = await published(dir)
  const error = await rejection(
    onboard(path.join(dir, "home"), ask, { ...base(dir), source, loginDefaults: () => ["X", "someone-else"] }),
  )
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("no usable answer")
  const pick = "That doesn't work: say which one you are (@ceo, @lan), or pass --handle"
  expect(ask.seen.filter((line) => line === pick)).toHaveLength(TRIES)
})

test("a device name the human already uses gets a suffix", async () => {
  const dir = tempDir()
  const source = await published(dir, ["ceo"])
  const work = path.join(dir, "work")
  cloneQuietly([source, work])
  const person = path.join(work, "people/ceo/person.yaml")
  fs.appendFileSync(person, `devices:\n- name: ${deviceName()}\n  token_sha256: ${"ab".repeat(32)}\n`)
  git(work, "commit", "-qam", "another office")
  git(work, "push", "-q", "origin", "main")
  const error = await rejection(
    onboard(path.join(dir, "home"), new Script([""]), { ...base(dir), ...stopAfterTheDevice(), source }),
  )
  expect(error.message).toBe("stop")
  const me = (await readIdentity(path.join(dir, "home", "identity.json")))!
  expect(me.device).toBe(`${deviceName().slice(0, 60)}-2`)
  const listed = loadRepo(path.join(dir, "home", "company")).people.get("ceo")!.devices.map((d) => d.name)
  expect(listed).toEqual([deviceName(), me.device])
})

test.each([
  ["empty", () => new Script([""])],
  ["non-interactive", nonInteractive],
] as const)("no company and no repo suggests init [%s]", async (_name, prompter) => {
  const dir = tempDir()
  const error = await rejection(onboard(path.join(dir, "home"), prompter(), base(dir)))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toMatch(
    /no company at .*; run `opencorp init` to create one, or `opencorp onboard --from URL`/,
  )
  expect(fs.existsSync(path.join(dir, "home", "company"))).toBe(false)
})

test("a home too long for the socket is refused before anything is written", async () => {
  const dir = tempDir()
  const home = path.join(dir, "h".repeat(120))
  const error = await rejection(onboard(home, new Script(), { ...base(dir), source: path.join(dir, "x.git") }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("socket path too long")
  expect(error.message).toContain("--home")
  expect(error.message).not.toContain("can't clone")
  expect(fs.existsSync(home)).toBe(false)
})

test("onboard is refused while another setup holds the lock", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const remote = await published(dir)
  makeHome(home)
  const lock = lockFile(path.join(home, "office", "setup.lock"), { private: true })
  try {
    const error = await rejection(onboard(home, new Script(["lan"]), { ...base(dir), source: remote }))
    expect(error).toBeInstanceOf(OnboardError)
    expect(error.message).toContain("another `opencorp init` or `opencorp onboard` is running on")
    expect(fs.readdirSync(home)).toEqual(["office"])
  } finally {
    lock.release()
  }
})

test("a setup lock that isnt a lock file is an onboard error", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const file = path.join(home, "office", "setup.lock")
  makeHome(home)
  fs.symlinkSync("/nonexistent", file)
  let error = await rejection(onboard(home, new Script(), base(dir)))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain(file)
  fs.unlinkSync(file)
  fs.writeFileSync(file, "not a database, and long enough to be read as one's header\n".repeat(4), { mode: 0o600 })
  error = await rejection(onboard(home, new Script(), base(dir)))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain(file)
})

test("a repo that cant be cloned leaves nothing behind", async () => {
  const dir = tempDir()
  const error = await rejection(
    onboard(path.join(dir, "home"), new Script(), { ...base(dir), source: path.join(dir, "nowhere.git") }),
  )
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toMatch(/can't clone .*; if git needs a login or a new host key, set that up in/s)
  expect(error.message).toMatch(/ a terminal first .*then run `opencorp onboard` again$/s)
  expect(fs.readdirSync(path.join(dir, "home")).sort()).toEqual(["office"])
})

test("a repo without a company is refused and removed", async () => {
  const dir = tempDir()
  const src = path.join(dir, "src")
  fs.mkdirSync(src)
  git(src, "init", "-q", "-b", "main")
  fs.writeFileSync(path.join(src, "README.md"), "hi\n")
  git(src, "add", "-A")
  git(src, "commit", "-qm", "readme")
  const error = await rejection(onboard(path.join(dir, "home"), new Script(), { ...base(dir), source: src }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("isn't a company repo")
  expect(fs.readdirSync(path.join(dir, "home")).sort()).toEqual(["office"])
})

test("company files without a repo are not cloned over", async () => {
  const dir = tempDir()
  const root = path.join(dir, "home", "company")
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, "company.yaml"), 'name: "Acme"\nceo: "me"\n')
  const error = await rejection(
    onboard(path.join(dir, "home"), new Script(), { ...base(dir), source: path.join(dir, "x.git") }),
  )
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("holds files but no git repo")
  expect(fs.readdirSync(root)).toEqual(["company.yaml"])
})

test("a company init left unfinished is not cloned over", async () => {
  const dir = tempDir()
  const root = path.join(dir, "home", "company")
  fs.mkdirSync(root, { recursive: true })
  git(root, "init", "-q", "-b", "main")
  fs.writeFileSync(path.join(root, "company.yaml"), 'name: "Acme"\nceo: "me"\n')
  const error = await rejection(
    onboard(path.join(dir, "home"), new Script(), { ...base(dir), source: path.join(dir, "x.git") }),
  )
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("run `opencorp init` to finish it")
  expect(fs.readdirSync(root).sort()).toEqual([".git", "company.yaml"])
})

test("a company that is a file is refused before the clone", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const remote = await published(dir)
  fs.mkdirSync(home)
  fs.writeFileSync(path.join(home, "company"), "")
  const error = await rejection(onboard(home, new Script(["lan"]), { ...base(dir), source: remote }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("is not a directory")
  expect(fs.readdirSync(home)).toEqual(["company"])
})

test("a damaged company is refused, not topped up", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const root = await company(home)
  fs.rmSync(path.join(home, "office"), { recursive: true, force: true })
  git(root, "rm", "-q", "company.yaml")
  git(root, "commit", "-qm", "drop company.yaml")
  const head = git(root, "rev-parse", "HEAD")
  const error = await rejection(onboard(home, new Script(), base(dir)))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("log -- company.yaml")
  expect(fs.readdirSync(home)).toEqual(["company"])
  expect(git(root, "rev-parse", "HEAD")).toBe(head)
  expect(git(root, "status", "--porcelain")).toBe("")
})

/** A prompter that puts a non-empty folder at `company` when it's asked which human you are. */
class CompanyAppears extends Script {
  constructor(private readonly company: string) {
    super(["lan"])
  }

  override async choose(question: string, options: readonly string[], defaultAnswer = "", typed = false) {
    fs.mkdirSync(this.company, { recursive: true })
    fs.writeFileSync(path.join(this.company, "x"), "")
    return super.choose(question, options, defaultAnswer, typed)
  }
}

test("a company that appears while you pick who you are is an onboard error", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const remote = await published(dir)
  const error = await rejection(
    onboard(home, new CompanyAppears(path.join(home, "company")), { ...base(dir), source: remote }),
  )
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain(`can't move the clone into ${path.join(home, "company")}`)
  expect(fs.existsSync(path.join(home, ".company-clone"))).toBe(false)
})

test("a second onboard of a cloned company changes nothing and asks nothing", async () => {
  const dir = tempDir()
  const remote = await published(dir)
  const home = path.join(dir, "home")
  const first = await rejection(
    onboard(home, new Script(["lan"]), { ...base(dir), ...stopAfterTheDevice(), source: remote }),
  )
  expect(first.message).toBe("stop")
  const head = git(path.join(home, "company"), "rev-parse", "HEAD")
  const identity = fs.readFileSync(path.join(home, "identity.json"), "utf8")
  const again = new Script()
  const error = await rejection(onboard(home, again, { ...base(dir), ...stopAfterTheDevice(), source: remote }))
  expect(error.message).toBe("stop")
  expect(git(path.join(home, "company"), "rev-parse", "HEAD")).toBe(head)
  expect(fs.readFileSync(path.join(home, "identity.json"), "utf8")).toBe(identity)
  expect(again.seen.some((line) => line.startsWith("This device: "))).toBe(true)
})

test(
  "a cloned office takes this devices token",
  async () => {
    const spawned = killedAtEnd()
    const dir = shortDir()
    const source = await published(tempDir())
    // Python's `no_web_port`: HQ stays off its TCP port, which the owner's own office holds.
    fs.mkdirSync(path.join(dir, "office"), { mode: 0o700 })
    fs.writeFileSync(path.join(dir, "office", "hq.json"), '{"tcp": false}')
    const environ = { ...gitEnv(selfSpawnEnv(process.env)), HOME: tempDir() }
    try {
      await onboard(dir, new Script(["lan", "openai", "", ""]), {
        source,
        mode: "background",
        host: daemonHost(dir, spawned),
        environ,
        listers: NO_LISTING,
        checkModel: async () => null,
        loginDefaults: () => ["Someone", "someone-unlisted"],
      })
      const me = (await readIdentity(path.join(dir, "identity.json")))!
      const sock = path.join(dir, "office", "office.sock")
      expect((await request(sock, "GET", "/people")).status).toBe(401)
      const whoami = await request(sock, "GET", "/whoami", { headers: me.headers() })
      expect(whoami.json()).toEqual({ person: "lan", device: me.device })
    } finally {
      await fallback.stopProcess(launch(dir, { environ, userHome: dir }))
    }
  },
  120_000,
)

test("onboard imports no daemon module but sockets", () => {
  const seen = new Set<string>()
  const walk = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    if (!file.endsWith(".ts")) return
    // Runtime imports only: a type-only import (worker/spawn.ts names daemon/office.ts's WorkerPool) is erased, so
    // it can't make a cycle with the connection routes that import onboard.ts.
    for (const name of specifiers(file, { values: true })) {
      if (name.startsWith(".")) walk(path.join(path.dirname(file), name))
    }
  }
  walk("install/onboard.ts")
  expect(seen).toContain("install/service.ts")
  expect(seen).toContain("daemon/sockets.ts")
  expect([...seen].filter((file) => file.startsWith("daemon/"))).toEqual(["daemon/sockets.ts"])
})

test("a repo url with credentials is never shown", async () => {
  const dir = tempDir()
  // A proxy would take the connection that port 9 refuses.
  const environ = Object.fromEntries(Object.entries(gitEnv(process.env)).filter(([name]) => !/_proxy$/i.test(name)))
  const error = await rejection(
    onboard(path.join(dir, "home"), new Script(), {
      ...base(dir),
      environ,
      source: "https://user:tok-0000@127.0.0.1:9/x.git",
    }),
  )
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("https://***@127.0.0.1:9/x.git")
  expect(error.message).not.toContain("tok-0000")
  expect(fs.readdirSync(path.join(dir, "home")).sort()).toEqual(["office"])
}, 30_000)

test("the users git runs in the callers env", async () => {
  const dir = tempDir()
  const empty = path.join(dir, "bin")
  fs.mkdirSync(empty)
  const error = await rejection(
    onboard(path.join(dir, "home"), new Script(), {
      ...base(dir),
      environ: { PATH: empty },
      source: path.join(dir, "x.git"),
    }),
  )
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("can't run git")
})

test("an existing home is made private", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  fs.mkdirSync(home)
  fs.chmodSync(home, 0o755)
  const error = await rejection(onboard(home, new Script([""]), base(dir)))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("no company at")
  expect(fs.statSync(home).mode & 0o777).toBe(0o700)
  expect(fs.statSync(path.join(home, "office")).mode & 0o777).toBe(0o700)
})

test("a model that answers has no problem", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "OK" })
  expect(await modelProblem(Provider.parse({ llm_config: LLM_CONFIG, env: fake.env() }))).toBeNull()
  expect(fake.requests()).toHaveLength(1)
})

test("a model check given an env runs in that env", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "OK" })
  // The fake listens on a random port that only the given env names, so an answer means that env was used.
  expect(await modelProblem(Provider.parse({ llm_config: LLM_CONFIG }), { env: fake.env() })).toBeNull()
  expect(fake.requests()).toHaveLength(1)
})

test("a model that fails says why without the key", async () => {
  const fake = await fakeLlm()
  fake.script({ error: 401 })
  const problem = await modelProblem(Provider.parse({ llm_config: { ...LLM_CONFIG, api_key: KEY }, env: fake.env() }))
  expect(problem).toBeTruthy()
  expect(problem).not.toContain(KEY)
})

test("a model that quotes the key in another case or base64 says why without any copy", async () => {
  const url = await refusingLlm(`bad key: ${keyCopies(MIXED_KEY).join(" and ")}`)
  const problem = await modelProblem(
    Provider.parse({ llm_config: { ...LLM_CONFIG, api_key: MIXED_KEY }, env: { VLLM_BASE_URL: `${url}/v1` } }),
  )
  expect(problem).toContain("bad key: [redacted] and [redacted] and [redacted]")
  for (const copy of [MIXED_KEY, ...keyCopies(MIXED_KEY)]) expect(problem).not.toContain(copy)
})

test("a model that never answers times out", async () => {
  const fake = await fakeLlm()
  fake.script({ hold: true })
  const started = performance.now()
  const problem = await modelProblem(Provider.parse({ llm_config: LLM_CONFIG, env: fake.env() }), { timeoutMs: 300 })
  expect(problem).toBe("timed out")
  expect(performance.now() - started).toBeLessThan(5_000)
})

test("the model checks own retry limit wins over the providers env", async () => {
  let posts = 0
  // Not the fake LLM: its errors say not to retry, so yian would never try again against it.
  const server = http.createServer((req, res) => {
    if (req.method === "POST") posts++
    req.resume()
    req.on("end", () => {
      res.writeHead(503, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "overloaded" } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  onTestFinished(() => {
    server.closeAllConnections()
    server.close()
  })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  const provider = Provider.parse({ llm_config: LLM_CONFIG, env: { VLLM_BASE_URL: url, YIAN_MODEL_RETRIES: "6" } })
  expect(await modelProblem(provider)).toBeTruthy()
  expect(posts).toBe(2)
}, 30_000)

test("a stop during the model check rejects with its reason", async () => {
  const fake = await fakeLlm()
  fake.script({ hold: true })
  const controller = new AbortController()
  const checking = modelProblem(Provider.parse({ llm_config: LLM_CONFIG, env: fake.env() }), {
    signal: controller.signal,
    timeoutMs: 10_000,
  })
  await fake.waitForRequests(1)
  const reason = new Error("stopped")
  controller.abort(reason)
  expect(await rejection(checking)).toBe(reason)
})

test("a setup run failure never shows the key or url credentials", async () => {
  const flow = await loadFlow(
    "id: fail\nname: fail\ninput:\n  text: !str\noutput: str\nkind: code\ncode: |\n  throw new Error(inputs.text)\n",
    { sourceLabel: "fail" },
  )
  const text = `bad key ${KEY} for https://user:hunter2@example.com/v1.`
  const { message } = await runSetup(
    flow,
    { text },
    Provider.parse({ llm_config: { ...LLM_CONFIG, api_key: KEY } }),
    { tools: {} },
  )
  expect(message).toContain("bad key [redacted] for https://***@example.com/v1")
  expect(message).not.toContain(KEY)
  expect(message).not.toContain("hunter2")
  expect(message!.endsWith(".")).toBe(false)
})

test("a setup run failure never shows the key in another case or base64", async () => {
  const flow = await loadFlow(
    "id: fail\nname: fail\ninput:\n  text: !str\noutput: str\nkind: code\ncode: |\n  throw new Error(inputs.text)\n",
    { sourceLabel: "fail" },
  )
  const { message } = await runSetup(
    flow,
    { text: `bad keys ${keyCopies(MIXED_KEY).join(", ")}` },
    Provider.parse({ llm_config: { ...LLM_CONFIG, api_key: MIXED_KEY } }),
    { tools: {} },
  )
  expect(message).toContain("bad keys [redacted], [redacted], [redacted]")
  for (const copy of [MIXED_KEY, ...keyCopies(MIXED_KEY)]) expect(message).not.toContain(copy)
})

test("the unknown model warning stays off the terminal", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "OK" })
  const seen: string[] = []
  const listener = (warning: Error) => seen.push(warning.message)
  process.on("warning", listener)
  try {
    const provider = Provider.parse({
      llm_config: {
        // A Chat Completions vendor with a model list (openai's key route goes to /v1/responses, which the fake
        // doesn't serve).
        provider: "deepseek",
        base_url: `${fake.baseUrl}/v1`,
        api_key: KEY,
        // Unique: yian warns once per text in a process, and test files share one.
        model: `unlisted-${crypto.randomUUID()}`,
      },
    })
    expect(await modelProblem(provider)).toBeNull()
    // A warning is emitted on the next tick.
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    process.off("warning", listener)
  }
  expect(seen.filter((message) => message.includes("known model list"))).toEqual([])
})

// No test changes process.env, so the variable sits in a child's environment.
test("a setup run sees only the office workers env and the providers", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "OK" })
  const code = [
    `import { Provider } from ${JSON.stringify(PROVIDER)}`,
    `import { modelProblem } from ${JSON.stringify(ONBOARD)}`,
    `import { LLM_CONFIG } from ${JSON.stringify(FAKE_LLM)}`,
    // The check's own limits allow one retry, so the refused connection fails well within the wait.
    "const provider = Provider.parse({ llm_config: LLM_CONFIG })",
    "console.log(JSON.stringify(await modelProblem(provider)))",
  ].join("\n")
  const child = Bun.spawn([process.execPath, "--no-install", "--no-env-file", "--config=/dev/null", "-e", code], {
    cwd: OFFICE,
    env: { PATH: process.env.PATH, VLLM_BASE_URL: `${fake.baseUrl}/v1` },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), 20_000)))
    const status = await Promise.race([child.exited, timeout])
    clearTimeout(timer)
    // Killed before the output is read: a child that timed out would keep its pipes open.
    child.kill("SIGKILL")
    const stderr = await new Response(child.stderr).text()
    expect(status, stderr).toBe(0)
    const problem: unknown = JSON.parse(await new Response(child.stdout).text())
    expect(typeof problem === "string" && problem.length > 0, stderr).toBe(true)
    expect(fake.requests()).toEqual([])
  } finally {
    child.kill("SIGKILL")
  }
}, 30_000)

test("redact takes the user and password out of urls", () => {
  expect(redact("https://user:pw@h/x and ssh://t@h")).toBe("https://***@h/x and ssh://***@h")
})
