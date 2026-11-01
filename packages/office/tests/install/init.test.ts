/** `opencorp init`: the model, the company from the flags or the interview with its teammates, the CEO's password,
 *  this device and the remote, then onboarding this machine. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import { expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { ToolContext } from "@ngocbh/yian"
import { lockFile } from "@ngocbh/yian/platform"
import { parse } from "yaml"
import { deviceName, readIdentity } from "../../src/auth/identity.ts"
import { checkPassword } from "../../src/auth/passwords.ts"
import { tokenSha256 } from "../../src/auth/tokens.ts"
import type { Draft, InitOutput } from "../../src/company/draft.ts"
import { CompanyGit, CompanyGitError } from "../../src/company/git.ts"
import { lint } from "../../src/company/lint.ts"
import { loadRepo } from "../../src/company/loader.ts"
import { companyState, missingFiles, writeCompany } from "../../src/company_template/index.ts"
import * as fallback from "../../src/install/fallback.ts"
import { type InitOptions, init } from "../../src/install/init.ts"
import {
  Asking,
  askPasswordTool,
  askRemoteTool,
  CONFIRM,
  type Known,
  ModelError,
  NO_REMOTE,
  passwordStep,
  REMOTE,
  remoteStep,
} from "../../src/install/interview.ts"
import { launch, officeAnswers } from "../../src/install/launch.ts"
import {
  GIT_ACCESS,
  makeHome,
  onboard,
  redact,
  SET_UP_AGAIN,
  setupConnectionFile,
  TRY_AGAIN,
} from "../../src/install/onboard.ts"
import { KeyboardInterrupt, NoTerminal, OnboardError, TtyPrompter } from "../../src/install/prompts.ts"
import { selfSpawnEnv } from "../../src/platform.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { fakeLlm } from "../chat/helpers.ts"
import { git, gitEnv } from "../company/helpers.ts"
import { shortDir, tempDir } from "../helpers.ts"
import { daemonHost, flowReplies, killedAtEnd, makeHost, NO_LISTING, Runner, Script } from "./helpers.ts"

// Hashing the password with scrypt and the company's git take a while.
setDefaultTimeout(30_000)

const KEY = "sk-ant-sentinel-1c9e04b7a2d6"
const PASSWORD = "pw-sentinel-5d1f"
const FLAGS: Known = { company: "Acme", name: "Me", handle: "me" }

/** A provider on stdin, so the model step asks nothing. */
function providerStdin(): Readable {
  return Readable.from([JSON.stringify({ llm_config: LLM_CONFIG })])
}

/** A prompter with no one at the terminal, so the company comes from the flags; it gives `PASSWORD` twice and then
 *  `remote` typed (none when empty). */
function scripted(remote = ""): Script {
  return new Script([PASSWORD, PASSWORD, remote || "1"], { interactive: false })
}

/** What `stopping` throws: distinct from init's own errors, so a test can't match one of them by mistake. */
const STOP = "stopped at the service install"

/** A host where nothing real runs and the first command onboarding runs, the service install's, stops it. */
function stopping(dir: string) {
  return makeHost(dir, {
    run: async () => {
      throw new OnboardError(STOP)
    },
  })
}

/** The options every test passes: listers and a model check that reach no provider; git without the user's
 *  config; the `stopping` host; and a fixed login, so no test reads the account database. */
function base(dir: string): InitOptions {
  return {
    listers: NO_LISTING,
    checkModel: async () => null,
    environ: gitEnv(process.env),
    host: stopping(dir),
    loginDefaults: () => ["Me", "me"],
  }
}

/** Runs init at `<dir>/home` with the provider on stdin. */
function runInit(dir: string, ask: Script | TtyPrompter, known: Known = FLAGS, extra: Partial<InitOptions> = {}) {
  return init(path.join(dir, "home"), ask, { ...base(dir), known, stdin: providerStdin(), ...extra })
}

/** An interview that returns `draft` without a model, asking for the password and the remote as its nodes do. */
function interviewed(draft: Draft): Pick<InitOptions, "interview"> {
  return {
    interview: async (_file, prompter, known) => [
      { ...draft, owner: { ...draft.owner, passwordHash: await passwordStep(prompter) } },
      await remoteStep(prompter, known.remote ?? ""),
    ],
  }
}

/** An interview that fails with a `ModelError` for its first `failures` calls, then returns `draft` as
 *  `interviewed` does; `calls` gets each call's arguments. */
function failingInterview(draft: Draft, failures = 1) {
  const real = interviewed(draft).interview!
  const calls: unknown[][] = []
  const interview: typeof real = async (...args) => {
    calls.push(args)
    if (calls.length <= failures) throw new ModelError("the model couldn't run the interview: Connection error")
    return real(...args)
  }
  return { interview, calls }
}

/** A bare repo at `target` whose default branch is main. */
function bare(target: string): string {
  git(path.dirname(target), "init", "-q", "--bare", "-b", "main", target)
  return target
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
  const error = await rejection(init(home, new Script(), { ...base(dir), stdin: providerStdin() }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toBe(`${fs.realpathSync(home)} is not a directory`)
  expect(fs.readFileSync(home, "utf8")).toBe("")
})

const ACME: Draft = {
  company: "Acme",
  owner: { handle: "ngocbh", name: "Hong Ngoc Bui", title: "CEO" },
  team: [
    { name: "Lan", handle: "lan", title: "QA", about: "Tests every release." },
    { name: "Minh", handle: "minh-dev", title: "Engineer", about: "" },
  ],
}

test("init trims a teammate's name and title as a hire does", async () => {
  const dir = tempDir()
  const company = path.join(dir, "home", "company")
  const padded = { ...ACME, team: [{ name: " Minh ", handle: "minh-dev", title: "Engineer\t", about: "" }] }
  await expect(runInit(dir, new Script([PASSWORD, PASSWORD, "1"]), FLAGS, interviewed(padded))).rejects.toThrow(STOP)
  const minh = loadRepo(company).people.get("minh-dev")
  expect([minh?.name, minh?.title]).toEqual(["Minh", "Engineer"])
  expect(fs.readFileSync(path.join(company, "people/minh-dev/profile.md"), "utf8")).toBe("# Minh, Engineer\n")
})

test("init makes the company its ceo and seeded teammates in one commit", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const company = path.join(home, "company")
  const ask = new Script([PASSWORD, PASSWORD, "1"])
  await expect(runInit(dir, ask, FLAGS, interviewed(ACME))).rejects.toThrow(STOP)
  const repo = loadRepo(company)
  expect([repo.company?.name, repo.company?.ceo]).toEqual(["Acme", "ngocbh"])
  expect(Object.fromEntries([...repo.people].map(([h, p]) => [h, [p.kind, p.title, p.manager]]))).toEqual({
    ngocbh: ["human", "CEO", null],
    lan: ["agent", "QA", "ngocbh"],
    "minh-dev": ["agent", "Engineer", "ngocbh"],
  })
  expect(fs.readFileSync(path.join(company, "people/lan/profile.md"), "utf8")).toBe(
    "# Lan, QA\n\nTests every release.\n",
  )
  expect(fs.readFileSync(path.join(company, "people/minh-dev/profile.md"), "utf8")).toBe("# Minh, Engineer\n")
  expect(await lint(repo)).toEqual([])
  expect(missingFiles(company)).toEqual([])
  expect(git(company, "log", "--format=%s").split("\n")).toEqual(["init: create the company"])
  expect(git(company, "status", "--porcelain")).toBe("")
  expect(ask.seen).toContain(`Company repo: created at ${company}, with you as CEO and Lan (@lan), Minh (@minh-dev)`)
  expect(ask.seen.filter((line) => line.startsWith("Step "))).toEqual([
    "Step 1 of 5: Model",
    "Step 2 of 5: Company",
    "Step 3 of 5: Password",
    "Step 4 of 5: Remote",
    "Step 5 of 5: This machine",
  ])
})

test("the model is asked first", async () => {
  const dir = tempDir()
  const ask = new Script(["openai", "", "", PASSWORD, PASSWORD, "1"])
  await expect(init(path.join(dir, "home"), ask, { ...base(dir), ...interviewed(ACME) })).rejects.toThrow(STOP)
  expect(ask.seen.slice(0, 3)).toEqual([
    "Step 1 of 5: Model",
    "Your agents think with this model; its key stays in this office, readable only by you.",
    "Model provider",
  ])
  const file = setupConnectionFile(path.join(dir, "home", "office"))
  expect(ask.seen).toContain(`Model provider: saved to ${file}`)
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ llm_config: { provider: "openai" } })
})

test("the provider from the first step is kept by the last", async () => {
  const dir = tempDir()
  const ask = new Script(["openai", "", "", PASSWORD, PASSWORD, "1"])
  const host = makeHost(dir, new Runner())
  // The stand-in office never starts.
  const error = await rejection(init(path.join(dir, "home"), ask, { ...base(dir), ...interviewed(ACME), host }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("did not answer")
  const file = setupConnectionFile(path.join(dir, "home", "office"))
  expect(ask.seen).toContain(`Model provider: saved to ${file}`)
  expect(ask.seen).toContain(`Model provider: up to date at ${file}`)
  expect(ask.seen.filter((line) => line === "Model provider")).toHaveLength(1)
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ llm_config: { provider: "openai" } })
})

test("the flow with a model makes the company and never sends a secret", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const company = path.join(home, "company")
  const remote = bare(path.join(dir, "remote-sentinel-3b8e.git"))
  const out: InitOutput = {
    company: "Acme",
    owner: { name: "Hong Ngoc Bui", handle: "ngocbh", title: "CEO" },
    teammates: [{ name: "Lan", handle: "lan", title: "QA", about: "Tests every release." }],
  }
  const fake = await fakeLlm()
  fake.script(...flowReplies("Tell me about the company.", out))
  const ask = new Script(["Acme; I'm ngocbh; hire Lan for QA", "1", PASSWORD, PASSWORD, remote])
  const provider = { llm_config: { ...LLM_CONFIG, api_key: KEY }, env: fake.env() }
  const stdin = Readable.from([JSON.stringify(provider)])
  await expect(init(home, ask, { ...base(dir), stdin })).rejects.toThrow(STOP)
  const sent = JSON.stringify(fake.requests())
  const repo = loadRepo(company)
  expect([repo.company?.name, repo.company?.ceo]).toEqual(["Acme", "ngocbh"])
  expect(Object.fromEntries([...repo.people].map(([h, p]) => [h, [p.kind, p.title]]))).toEqual({
    ngocbh: ["human", "CEO"],
    lan: ["agent", "QA"],
  })
  expect(fs.readFileSync(path.join(company, "people/lan/profile.md"), "utf8")).toBe(
    "# Lan, QA\n\nTests every release.\n",
  )
  expect(ask.seen).toContain("Tell me about the company.")
  expect(ask.seen).toContain(CONFIRM)
  expect(sent).toContain("Acme; I'm ngocbh; hire Lan for QA")
  const hashed = parse(git(company, "show", "HEAD:people/ngocbh/person.yaml")).password_hash
  for (const secret of [PASSWORD, KEY, "remote-sentinel-3b8e", hashed]) expect(sent).not.toContain(secret)
  expect(git(remote, "rev-parse", "main")).toBe(git(company, "rev-parse", "HEAD"))
  expect(ask.seen.filter((line) => line.startsWith("Step "))).toEqual([
    "Step 1 of 5: Model",
    "Step 2 of 5: Company",
    "Step 3 of 5: Password",
    "Step 4 of 5: Remote",
    "Step 5 of 5: This machine",
  ])
})

test("without a terminal the flags make the company without asking to confirm", async () => {
  const dir = tempDir()
  const ask = scripted()
  const known: Known = { company: "Acme", name: "Bo", handle: "bo", agent: "Lan", agent_handle: "lan" }
  const interview = async (): Promise<never> => {
    throw new Error("the flow ran")
  }
  await expect(runInit(dir, ask, known, { interview })).rejects.toThrow(STOP)
  const repo = loadRepo(path.join(dir, "home", "company"))
  expect(repo.company?.name).toBe("Acme")
  expect(new Set(repo.people.keys())).toEqual(new Set(["bo", "lan"]))
  expect(ask.seen).not.toContain(CONFIRM)
})

test("a failed interview can be tried again with the same model", async () => {
  const dir = tempDir()
  const { interview, calls } = failingInterview(ACME)
  const ask = new Script(["openai", "", "", "1", PASSWORD, PASSWORD, "1"])
  await expect(init(path.join(dir, "home"), ask, { ...base(dir), interview })).rejects.toThrow(STOP)
  expect(calls).toHaveLength(2)
  expect(ask.seen).toContain("The model couldn't run the interview: Connection error")
  expect(ask.offered).toContainEqual([TRY_AGAIN, SET_UP_AGAIN])
  expect(loadRepo(path.join(dir, "home", "company")).company?.name).toBe("Acme")
})

test("a failed interview can set up the model again", async () => {
  const dir = tempDir()
  const { interview } = failingInterview(ACME)
  const ask = new Script(["openai", "", "", "2", "anthropic", KEY, "", PASSWORD, PASSWORD, "1"])
  await expect(init(path.join(dir, "home"), ask, { ...base(dir), interview })).rejects.toThrow(STOP)
  const file = setupConnectionFile(path.join(dir, "home", "office"))
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
    llm_config: { provider: "anthropic", api_key: KEY, model: "claude-sonnet-4-5" },
  })
  expect(ask.seen.filter((line) => line.includes(KEY))).toEqual([])
})

test("setting the model up again starts from step ones answers", async () => {
  const dir = tempDir()
  const { interview } = failingInterview(ACME)
  const ask = new Script(["openai", KEY, "gpt-x", "2", "", "", "", PASSWORD, PASSWORD, "1"])
  await expect(init(path.join(dir, "home"), ask, { ...base(dir), interview })).rejects.toThrow(STOP)
  const file = setupConnectionFile(path.join(dir, "home", "office"))
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
    llm_config: { provider: "openai", api_key: KEY, model: "gpt-x" },
  })
  expect(ask.seen).toContain("openai API key (empty keeps the one you just typed; not shown)")
})

test("the model is checked before it is saved", async () => {
  const dir = tempDir()
  const problems: (string | null)[] = ["Connection error", null]
  const checkModel = async () => problems.shift() ?? null
  const ask = new Script(["openai", "", "", "1", PASSWORD, PASSWORD, "1"])
  await expect(
    init(path.join(dir, "home"), ask, { ...base(dir), ...interviewed(ACME), checkModel }),
  ).rejects.toThrow(STOP)
  expect(ask.seen).toContain("The model didn't answer: Connection error")
  expect(problems).toEqual([])
})

test("a home too long for the socket is refused before anything is written", async () => {
  const dir = tempDir()
  const home = path.join(dir, "h".repeat(120))
  const error = await rejection(init(home, scripted(), { ...base(dir), known: FLAGS, stdin: providerStdin() }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("socket path too long")
  expect(error.message).toContain("--home")
  expect(fs.existsSync(home)).toBe(false)
})

const BUSY = "another `opencorp init` or `opencorp onboard` is running on"

/** Takes the setup lock of the office at `home`, making the office dir first. */
function holdSetupLock(home: string) {
  makeHome(home)
  return lockFile(path.join(home, "office", "setup.lock"), { private: true })
}

test("init is refused while another setup holds the lock, and writes nothing", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const lock = holdSetupLock(home)
  try {
    const error = await rejection(runInit(dir, scripted()))
    expect(error).toBeInstanceOf(OnboardError)
    expect(error.message).toContain(BUSY)
    expect(fs.existsSync(path.join(home, "company"))).toBe(false)
    expect(fs.existsSync(path.join(home, "identity.json"))).toBe(false)
    expect(fs.existsSync(setupConnectionFile(path.join(home, "office")))).toBe(false)
  } finally {
    lock.release()
  }
})

test("init checks for a company again once it has the lock", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const staged = path.join(dir, "staged")
  await writeCompany(staged, path.join(dir, "wt"), { company: "Acme", owner: { handle: "me", name: "Me" } })
  const lock = holdSetupLock(home)
  const pending = runInit(dir, scripted())
  try {
    // Init is now waiting on the lock: the company it checked for before is made meanwhile.
    await Bun.sleep(20)
    fs.renameSync(staged, path.join(home, "company"))
  } finally {
    lock.release()
  }
  const error = await rejection(pending)
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("there's already a company")
  expect(fs.existsSync(path.join(home, "identity.json"))).toBe(false)
  expect(fs.existsSync(setupConnectionFile(path.join(home, "office")))).toBe(false)
})

test("two inits at once leave one consistent company", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const results = await Promise.allSettled([runInit(dir, scripted()), runInit(dir, scripted())])
  const messages = results.map((r) => (r.status === "rejected" ? (r.reason as Error).message : "resolved")).sort()
  expect(messages.filter((m) => m === STOP)).toHaveLength(1)
  const other = messages.find((m) => m !== STOP)!
  expect(other.includes(BUSY) || other.includes("there's already a company"), other).toBe(true)
  const company = path.join(home, "company")
  expect(git(company, "log", "--format=%s").split("\n")).toEqual(["init: create the company"])
  const me = (await readIdentity(path.join(home, "identity.json")))!
  const devices = parse(git(company, "show", "HEAD:people/me/person.yaml")).devices
  expect(devices).toEqual([{ name: me.device, token_sha256: tokenSha256(me.token) }])
})

test("the setup lock is free after a failed init", async () => {
  const dir = tempDir()
  await expect(runInit(dir, scripted())).rejects.toThrow(STOP)
  lockFile(path.join(dir, "home", "office", "setup.lock"), { private: true }).release()
})

/** Ways a company can be damaged after init made it, and what refusing it tells the owner to do. */
const DAMAGES: [string, (company: string) => void, string][] = [
  [
    "company.yaml removed in a commit",
    (company) => {
      git(company, "rm", "-q", "company.yaml")
      git(company, "commit", "-qm", "drop company.yaml")
    },
    "log -- company.yaml",
  ],
  ["no .git", (company) => fs.rmSync(path.join(company, ".git"), { recursive: true }), "move it away"],
  ["company.yaml deleted", (company) => fs.unlinkSync(path.join(company, "company.yaml")), "checkout -- company.yaml"],
]

test.each(DAMAGES)("init refuses a damaged company and leaves it alone [%s]", async (_, damage, fix) => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const company = path.join(home, "company")
  await expect(runInit(dir, scripted())).rejects.toThrow(STOP)
  damage(company)
  const before = () => [
    fs.readFileSync(path.join(home, "identity.json")),
    fs.readFileSync(path.join(company, "people", "me", "person.yaml")),
    fs.existsSync(path.join(company, ".git")) ? git(company, "log", "--format=%H") : "",
  ]
  const kept = before()
  const ask = scripted()
  const error = await rejection(runInit(dir, ask))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain(fix)
  expect(error.message).toContain(company)
  expect(before()).toEqual(kept)
  expect(ask.seen).not.toContain("Step 1 of 5: Model")
})

test("a company that is a file is refused before identity.json is written", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  fs.mkdirSync(home)
  fs.writeFileSync(path.join(home, "company"), "")
  const error = await rejection(runInit(dir, scripted()))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("is not a directory")
  expect(error.message).toContain("move it away")
  expect(fs.readdirSync(home)).toEqual(["company"])
})

test("flags that clash without a terminal stop before the company is made", async () => {
  const dir = tempDir()
  const error = await rejection(runInit(dir, scripted(), { handle: "me", agent_handle: "me" }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("@me is taken; pass --agent-handle")
  expect(await companyState(path.join(dir, "home", "company"))).toEqual({ kind: "absent" })
})

test("init registers this device for the ceo in the first commit", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const ask = scripted()
  await expect(runInit(dir, ask)).rejects.toThrow(STOP)
  const me = (await readIdentity(path.join(home, "identity.json")))!
  expect([me.handle, me.device]).toEqual(["me", deviceName()])
  expect(fs.statSync(path.join(home, "identity.json")).mode & 0o777).toBe(0o600)
  const first = git(path.join(home, "company"), "show", "HEAD:people/me/person.yaml")
  expect(parse(first).devices).toEqual([{ name: me.device, token_sha256: tokenSha256(me.token) }])
  expect(ask.seen.filter((line) => line.includes(me.token))).toEqual([])
  expect(ask.seen).toContain(
    `This device: ${me.device}, acting as @me (its token is in ${path.join(home, "identity.json")})`,
  )
})

test("init keeps only the hash of the ceos password in the first commit", async () => {
  const dir = tempDir()
  const company = path.join(dir, "home", "company")
  const ask = scripted()
  await expect(runInit(dir, ask)).rejects.toThrow(STOP)
  const first = parse(git(company, "show", "HEAD:people/me/person.yaml"))
  expect(await checkPassword(PASSWORD, first.password_hash)).toBe(true)
  expect(ask.seen.filter((line) => line.includes(PASSWORD))).toEqual([])
  expect(git(company, "log", "-p", "--all")).not.toContain(PASSWORD)
  expect(await lint(loadRepo(company))).toEqual([])
})

test("a short or mistyped password is asked again", async () => {
  const dir = tempDir()
  const ask = new Script(["eleven-char", PASSWORD, "typo-typo", PASSWORD, PASSWORD, "1"], { interactive: false })
  await expect(runInit(dir, ask)).rejects.toThrow(STOP)
  expect(ask.seen).toContain(
    "Your password, to log in new devices with (at least 12 characters, one you use nowhere else; not shown)",
  )
  expect(ask.seen).toContain("That doesn't work: use at least 12 characters")
  expect(ask.seen).toContain("That doesn't work: the two passwords differ")
  const me = loadRepo(path.join(dir, "home", "company")).people.get("me")!
  expect(await checkPassword(PASSWORD, me.password_hash)).toBe(true)
})

/** A prompter with no terminal to read a secret from. */
class NoTerminalScript extends Script {
  override async secret(question: string): Promise<string> {
    this.seen.push(question)
    throw new NoTerminal("no terminal")
  }
}

test("without a terminal the ceo gets no password and is told how to set one", async () => {
  const dir = tempDir()
  const ask = new NoTerminalScript([""], { interactive: false })
  await expect(runInit(dir, ask)).rejects.toThrow(STOP)
  expect(loadRepo(path.join(dir, "home", "company")).people.get("me")!.password_hash).toBeNull()
  expect(ask.seen).toContain(
    "Password: none, since there's no terminal to ask on; set one later with `opencorp password`",
  )
})

test("init replaces an old identity", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  fs.mkdirSync(home)
  fs.writeFileSync(path.join(home, "identity.json"), '{"handle": "old", "device": "old", "token": "act_old"}')
  await expect(runInit(dir, scripted())).rejects.toThrow(STOP)
  const me = (await readIdentity(path.join(home, "identity.json")))!
  expect(me.handle).toBe("me")
  expect(me.token).not.toBe("act_old")
})

test("no device leaves the company open without tokens", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  await expect(runInit(dir, scripted(), FLAGS, { device: false })).rejects.toThrow(STOP)
  expect(fs.existsSync(path.join(home, "identity.json"))).toBe(false)
  expect(loadRepo(path.join(home, "company")).people.get("me")!.devices).toEqual([])
})

test("init refuses a company that exists and suggests onboard", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const company = path.join(home, "company")
  await writeCompany(company, path.join(home, "office", "worktrees"), {
    company: "Acme",
    owner: { handle: "me", name: "Me" },
  })
  const head = git(company, "rev-parse", "HEAD")
  const error = await rejection(init(home, new Script(), base(dir)))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toMatch(/already a company at .*; run `opencorp onboard`/)
  expect(git(company, "rev-parse", "HEAD")).toBe(head)
})

test("a company whose first write stopped early is finished", async () => {
  const dir = tempDir()
  const company = path.join(dir, "home", "company")
  fs.mkdirSync(company, { recursive: true })
  git(company, "init", "-q", "-b", "main")
  fs.writeFileSync(path.join(company, "company.yaml"), 'name: "Acme"\nceo: "me"\n')
  await expect(runInit(dir, scripted())).rejects.toThrow(STOP)
  expect(await lint(loadRepo(company))).toEqual([])
  expect(git(company, "status", "--porcelain")).toBe("")
})

/** Runs init as `an` of Acme until the company's first commit, which fails; returns the company's path. */
async function stopBeforeTheFirstCommit(dir: string): Promise<string> {
  const commit = spyOn(CompanyGit.prototype, "commit").mockImplementation(async () => {
    throw new CompanyGitError("killed")
  })
  try {
    const error = await rejection(runInit(dir, scripted(), { company: "Acme", name: "An", handle: "an" }))
    expect(error).toBeInstanceOf(OnboardError)
    expect(error.message).toContain("killed")
  } finally {
    commit.mockRestore()
  }
  const company = path.join(dir, "home", "company")
  expect(fs.readFileSync(path.join(company, "company.yaml"), "utf8")).toContain('ceo: "an"')
  return company
}

// Strings, since bun leaves `%s` as it is for a boolean.
test.each(["false", "true"])("a second init after a stopped first write uses the new answers [%s]", async (cut) => {
  const truncate = cut === "true"
  const dir = tempDir()
  const company = await stopBeforeTheFirstCommit(dir)
  if (truncate) fs.writeFileSync(path.join(company, "company.yaml"), 'name: "Ac')
  await expect(runInit(dir, scripted(), { company: "Beta", name: "Bo", handle: "bo" })).rejects.toThrow(STOP)
  const committed = git(company, "show", "HEAD:company.yaml")
  expect(committed).toContain('name: "Beta"')
  expect(committed).toContain('ceo: "bo"')
  expect(git(company, "ls-files").split("\n")).toContain("people/bo/person.yaml")
  // A truncated company.yaml doesn't say who run 1's owner was, so their file is left.
  expect(fs.existsSync(path.join(company, "people", "an"))).toBe(truncate)
  expect(await lint(loadRepo(company))).toEqual([])
})

test("a user id without an account is an onboard error", async () => {
  const dir = tempDir()
  const userInfo = spyOn(os, "userInfo").mockImplementation(() => {
    throw new Error("uid not found")
  })
  try {
    // No stand-in login, so the real one reads the account.
    const ask = new Script([], { interactive: false })
    const error = await rejection(runInit(dir, ask, FLAGS, { loginDefaults: undefined }))
    expect(error).toBeInstanceOf(OnboardError)
    expect(error.message).toContain("no account")
  } finally {
    userInfo.mockRestore()
  }
})

test("an existing home others can read is made private", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  fs.mkdirSync(home, { mode: 0o755 })
  fs.chmodSync(home, 0o755)
  await expect(runInit(dir, scripted())).rejects.toThrow(STOP)
  expect(fs.statSync(home).mode & 0o777).toBe(0o700)
})

test("a running office without a company is not written to", async () => {
  const dir = tempDir()
  const host = makeHost(dir, new Runner(), { answers: async () => true })
  const error = await rejection(init(path.join(dir, "home"), new Script(), { ...base(dir), host }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toMatch(/running, but .* has no company yet/)
  expect(fs.existsSync(path.join(dir, "home", "company"))).toBe(false)
})

test("init over a locked office that doesnt answer refuses", async () => {
  const dir = tempDir()
  const seen: string[] = []
  const host = makeHost(dir, new Runner(), {
    locked: (lockPath) => {
      seen.push(lockPath)
      return true
    },
  })
  const error = await rejection(init(path.join(dir, "home"), new Script(), { ...base(dir), host }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toMatch(/running, but .* has no company yet/)
  expect(seen).toEqual([path.join(fs.realpathSync(dir), "home", "office", "office.lock")])
  expect(fs.existsSync(path.join(dir, "home", "company"))).toBe(false)
})

test("a remote is added and pushed to with main tracking it", async () => {
  const dir = tempDir()
  const remote = bare(path.join(dir, "acme.git"))
  const ask = scripted(remote)
  await expect(runInit(dir, ask)).rejects.toThrow(STOP)
  const company = path.join(dir, "home", "company")
  expect(git(remote, "rev-parse", "main")).toBe(git(company, "rev-parse", "HEAD"))
  expect(git(company, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main")
  expect(ask.seen.some((line) => line.startsWith("Remote: pushed the company to"))).toBe(true)
})

test("a remote flag is used without asking", async () => {
  const dir = tempDir()
  const remote = bare(path.join(dir, "acme.git"))
  const ask = new Script([PASSWORD, PASSWORD], { interactive: false })
  await expect(runInit(dir, ask, { ...FLAGS, remote })).rejects.toThrow(STOP)
  expect(git(remote, "rev-parse", "main")).toBe(git(path.join(dir, "home", "company"), "rev-parse", "HEAD"))
  expect(ask.seen).not.toContain(REMOTE)
})

test("a push that fails is a warning with the retry and init goes on", async () => {
  const dir = tempDir()
  const nowhere = path.join(dir, "nowhere.git")
  const ask = scripted(nowhere)
  // It got past the remote, to onboarding.
  await expect(runInit(dir, ask)).rejects.toThrow(STOP)
  const company = path.join(dir, "home", "company")
  const warning = ask.seen.find((line) => line.startsWith("Warning: couldn't push"))!
  expect(warning).toContain(GIT_ACCESS)
  expect(warning).toContain(`then retry with \`git -C ${company} push -u origin main\`.`)
  expect(git(company, "remote", "get-url", "origin")).toBe(nowhere)
  expect(ask.seen).toContain("Step 5 of 5: This machine")
})

test("a token in the remote url is never shown", async () => {
  const dir = tempDir()
  // A proxy would take the connection that port 9 refuses.
  const environ = Object.fromEntries(Object.entries(gitEnv(process.env)).filter(([name]) => !/_proxy$/i.test(name)))
  const url = "http://x-access-token:ghp_sentinel42@127.0.0.1:9/acme.git"
  const ask = scripted(url)
  await expect(runInit(dir, ask, FLAGS, { environ })).rejects.toThrow(STOP)
  expect(ask.seen.some((line) => line.startsWith("Warning: couldn't push"))).toBe(true)
  expect(ask.seen.filter((line) => line.includes("ghp_sentinel42"))).toEqual([])
  expect(redact(url)).toBe("http://***@127.0.0.1:9/acme.git")
})

/** The context of a call to the tool `toolName`, outside a run, with the owner's terminal `prompter`. */
function toolContext(toolName: string, prompter: Script): ToolContext {
  const [context, signal] = [new Asking(prompter), new AbortController().signal]
  return new ToolContext({ callId: "t", attempt: 1, toolName, runId: "", node: "", context, signal })
}

test("the password node shows step 3 and returns the hash", async () => {
  const prompter = new Script([PASSWORD, PASSWORD])
  const hash = await askPasswordTool.execute({}, toolContext("ask_password", prompter))
  expect(typeof hash).toBe("string")
  expect(hash).not.toBe(PASSWORD)
  expect(await checkPassword(PASSWORD, hash as string)).toBe(true)
  expect(prompter.seen[0]).toBe("Step 3 of 5: Password")
})

test("the remote node uses the flag or asks", async () => {
  const [flagged, none, typed] = [new Script(), new Script(["1"]), new Script(["git@example.com:a.git"])]
  expect(await askRemoteTool.execute({ given: "u" }, toolContext("ask_remote", flagged))).toBe("u")
  expect(await askRemoteTool.execute({ given: "" }, toolContext("ask_remote", none))).toBe("")
  expect(await askRemoteTool.execute({ given: "" }, toolContext("ask_remote", typed))).toBe("git@example.com:a.git")
  expect(flagged.seen).not.toContain(REMOTE)
  expect(none.seen.at(-1)).toBe(REMOTE)
  expect(typed.seen.at(-1)).toBe(REMOTE)
  expect(typed.offered).toEqual([[NO_REMOTE]])
  expect(typed.typed).toEqual([true])
})

test("the remote is asked before the company is written", async () => {
  const dir = tempDir()
  const ask = scripted()
  await expect(runInit(dir, ask)).rejects.toThrow(STOP)
  const created = ask.seen.findIndex((line) => line.startsWith("Company repo: created at"))
  expect(ask.seen).toContain("Step 3 of 5: Password")
  expect(ask.seen).toContain(REMOTE)
  expect(ask.seen.indexOf("Step 3 of 5: Password")).toBeLessThan(ask.seen.indexOf(REMOTE))
  expect(ask.seen.indexOf(REMOTE)).toBeLessThan(created)
})

/** A prompter whose owner presses Ctrl-C at the remote. */
class InterruptedAtRemote extends Script {
  override async choose(question: string, options: readonly string[], defaultAnswer = "", typed = false) {
    if (question === REMOTE) throw new KeyboardInterrupt()
    return super.choose(question, options, defaultAnswer, typed)
  }
}

test("ctrl c at the remote leaves no company", async () => {
  const dir = tempDir()
  const error = await rejection(runInit(dir, new InterruptedAtRemote([PASSWORD, PASSWORD], { interactive: false })))
  expect(error).toBeInstanceOf(KeyboardInterrupt)
  expect(await companyState(path.join(dir, "home", "company"))).toEqual({ kind: "absent" })
})

test("without anyone to ask there is no remote", async () => {
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done()
    },
  })
  const prompter = new TtyPrompter({
    interactive: false,
    preset: {},
    input: Readable.from(["2\ngit@example.com:a.git\n"]),
    output,
    env: {},
  })
  expect(await remoteStep(prompter, "")).toBe("")
})

test("on a dumb terminal the remote is typed at the list", async () => {
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done()
    },
  })
  const prompter = new TtyPrompter({
    input: Readable.from(["https://github.com/me/acme.git\n"]),
    output,
    env: { TERM: "dumb" },
  })
  expect(await remoteStep(prompter, "")).toBe("https://github.com/me/acme.git")
})

// Not interactive, so the company comes from the flags and no real model is asked; the CLI never runs init this way
// (it is interactive whenever the provider isn't on stdin).
const CEO: Known = { company: "Acme", name: "Hong Ngoc Bui", handle: "ngocbh" }

/** A short home whose office really starts in the background, and the options that run it: listers and a model
 *  check that reach no provider, git without the user's config, and a fixed login, so no test reads the account
 *  database. Call `killedAtEnd()` first, so the daemon goes before the home is removed. */
function realOffice(spawned: ReturnType<typeof killedAtEnd>) {
  const dir = shortDir()
  // Python's `no_web_port`: HQ stays off its TCP port, which the owner's own office holds.
  fs.mkdirSync(path.join(dir, "office"), { mode: 0o700 })
  fs.writeFileSync(path.join(dir, "office", "hq.json"), '{"tcp": false}')
  const environ = { ...gitEnv(selfSpawnEnv(process.env)), HOME: tempDir() }
  const options = {
    mode: "background",
    host: daemonHost(dir, spawned),
    environ,
    listers: NO_LISTING,
    checkModel: async () => null,
    loginDefaults: () => ["Hong Ngoc Bui", "ngocbh"],
  } satisfies Partial<InitOptions>
  return { dir, options, stop: () => fallback.stopProcess(launch(dir, { environ, userHome: dir })) }
}

/** Every regular file under `root` that holds `text`, links skipped. */
function holding(root: string, text: string): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) found.push(...holding(file, text))
    else if (entry.isFile() && fs.readFileSync(file).includes(text)) found.push(file)
  }
  return found
}

test(
  "init sets up the office and a second onboard changes nothing",
  async () => {
    const { dir, options, stop } = realOffice(killedAtEnd())
    const company = path.join(dir, "company")
    const connection = setupConnectionFile(path.join(dir, "office"))
    const pidfile = path.join(dir, "office", "office.pid")
    const installFile = path.join(dir, "office", "install.json")
    const first = new Script(["openai", "", "", PASSWORD, PASSWORD, "1"], { interactive: false })
    try {
      await init(dir, first, { ...options, known: CEO })
      expect(await officeAnswers(path.join(dir, "office", "office.sock"))).toBe(true)
      const repo = loadRepo(company)
      expect(await lint(repo)).toEqual([])
      expect(missingFiles(company)).toEqual([])
      expect(Object.fromEntries([...repo.people].map(([h, p]) => [h, p.kind]))).toEqual({
        ngocbh: "human",
        minh: "agent",
      })
      expect(git(company, "log", "--format=%s").split("\n")).toEqual(["init: create the company"])
      const me = (await readIdentity(path.join(dir, "identity.json")))!
      expect(repo.people.get("ngocbh")?.devices.map((d) => d.name)).toEqual([me.device])
      expect(fs.statSync(connection).mode & 0o777).toBe(0o600)
      const head = git(company, "rev-parse", "HEAD")
      const pid = fs.readFileSync(pidfile, "utf8")
      const saved = fs.statSync(connection, { bigint: true }).mtimeNs
      const installed = fs.readFileSync(installFile, "utf8")

      const again = new Script() // no answers: a second run must not ask anything
      await onboard(dir, again, options)
      expect(git(company, "rev-parse", "HEAD")).toBe(head)
      expect(fs.readFileSync(pidfile, "utf8")).toBe(pid)
      expect(fs.statSync(connection, { bigint: true }).mtimeNs).toBe(saved)
      expect(fs.readFileSync(installFile, "utf8")).toBe(installed)
      expect(again.seen.some((line) => line.includes("up to date"))).toBe(true)
    } finally {
      await stop()
    }
  },
  120_000,
)

test(
  "the key lands only in the provider file",
  async () => {
    const { dir, options, stop } = realOffice(killedAtEnd())
    const file = setupConnectionFile(path.join(dir, "office"))
    const ask = new Script(["anthropic", KEY, "", PASSWORD, PASSWORD, "1"], { interactive: false })
    try {
      await init(dir, ask, { ...options, known: CEO })
      expect(JSON.parse(fs.readFileSync(file, "utf8")).llm_config.api_key).toBe(KEY)
      const token = (await readIdentity(path.join(dir, "identity.json")))!.token
      expect(ask.seen.filter((line) => line.includes(KEY) || line.includes(token))).toEqual([])
      expect(holding(dir, KEY)).toEqual([file])
      expect(holding(dir, token)).toEqual([path.join(dir, "identity.json")])
      // Git objects are compressed, so the byte search above can't see into them.
      const objects = git(path.join(dir, "company"), "cat-file", "--batch-all-objects", "--batch")
      expect(objects.length).toBeGreaterThan(0)
      expect(objects.includes(KEY)).toBe(false)
      expect(objects.includes(token)).toBe(false)
    } finally {
      await stop()
    }
  },
  120_000,
)
