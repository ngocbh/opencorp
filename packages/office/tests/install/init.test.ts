/** `opencorp init`: the model, the company from the flags or the interview with its teammates, the CEO's password,
 *  this device and the remote, then onboarding this machine. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import { expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { parse } from "yaml"
import { deviceName, readIdentity } from "../../src/auth/identity.ts"
import { checkPassword } from "../../src/auth/passwords.ts"
import { tokenSha256 } from "../../src/auth/tokens.ts"
import type { Draft } from "../../src/company/draft.ts"
import { CompanyGit, CompanyGitError } from "../../src/company/git.ts"
import { lint } from "../../src/company/lint.ts"
import { loadRepo } from "../../src/company/loader.ts"
import { isNew, missingFiles, writeCompany } from "../../src/company_template/index.ts"
import { type InitOptions, init } from "../../src/install/init.ts"
import { CONFIRM, type Known, passwordStep, REMOTE, remoteStep } from "../../src/install/interview.ts"
import { GIT_ACCESS, redact } from "../../src/install/onboard.ts"
import { KeyboardInterrupt, NoTerminal, OnboardError, TtyPrompter } from "../../src/install/prompts.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { git, gitEnv } from "../company/helpers.ts"
import { tempDir } from "../helpers.ts"
import { makeHost, NO_LISTING, Runner, Script } from "./helpers.ts"

// Hashing the password with scrypt and the company's git take a while.
setDefaultTimeout(30_000)

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

/** A host where nothing real runs and the first command onboarding runs, the service install's, stops it. */
function stopping(dir: string) {
  return makeHost(dir, {
    run: async () => {
      throw new OnboardError("stop")
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

const ACME: Draft = {
  company: "Acme",
  owner: { handle: "ngocbh", name: "Hong Ngoc Bui", title: "CEO" },
  team: [
    { name: "Lan", handle: "lan", title: "QA", about: "Tests every release." },
    { name: "Minh", handle: "minh-dev", title: "Engineer", about: "" },
  ],
}

test("init makes the company its ceo and seeded teammates in one commit", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const company = path.join(home, "company")
  const ask = new Script([PASSWORD, PASSWORD, "1"])
  await expect(runInit(dir, ask, FLAGS, interviewed(ACME))).rejects.toThrow("stop")
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

test("without a terminal the flags make the company without asking to confirm", async () => {
  const dir = tempDir()
  const ask = scripted()
  const known: Known = { company: "Acme", name: "Bo", handle: "bo", agent: "Lan", agent_handle: "lan" }
  const interview = async (): Promise<never> => {
    throw new Error("the flow ran")
  }
  await expect(runInit(dir, ask, known, { interview })).rejects.toThrow("stop")
  const repo = loadRepo(path.join(dir, "home", "company"))
  expect(repo.company?.name).toBe("Acme")
  expect(new Set(repo.people.keys())).toEqual(new Set(["bo", "lan"]))
  expect(ask.seen).not.toContain(CONFIRM)
})

test("flags that clash without a terminal stop before the company is made", async () => {
  const dir = tempDir()
  const error = await rejection(runInit(dir, scripted(), { handle: "me", agent_handle: "me" }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("@me is taken; pass --agent-handle")
  expect(await isNew(path.join(dir, "home", "company"))).toBe(true)
})

test("init registers this device for the ceo in the first commit", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const ask = scripted()
  await expect(runInit(dir, ask)).rejects.toThrow("stop")
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
  await expect(runInit(dir, ask)).rejects.toThrow("stop")
  const first = parse(git(company, "show", "HEAD:people/me/person.yaml"))
  expect(await checkPassword(PASSWORD, first.password_hash)).toBe(true)
  expect(ask.seen.filter((line) => line.includes(PASSWORD))).toEqual([])
  expect(git(company, "log", "-p", "--all")).not.toContain(PASSWORD)
  expect(await lint(loadRepo(company))).toEqual([])
})

test("a short or mistyped password is asked again", async () => {
  const dir = tempDir()
  const ask = new Script(["eleven-char", PASSWORD, "typo-typo", PASSWORD, PASSWORD, "1"], { interactive: false })
  await expect(runInit(dir, ask)).rejects.toThrow("stop")
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
  await expect(runInit(dir, ask)).rejects.toThrow("stop")
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
  await expect(runInit(dir, scripted())).rejects.toThrow("stop")
  const me = (await readIdentity(path.join(home, "identity.json")))!
  expect(me.handle).toBe("me")
  expect(me.token).not.toBe("act_old")
})

test("no device leaves the company open without tokens", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  await expect(runInit(dir, scripted(), FLAGS, { device: false })).rejects.toThrow("stop")
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
  await expect(runInit(dir, scripted())).rejects.toThrow("stop")
  expect(await lint(loadRepo(company))).toEqual([])
  expect(git(company, "status", "--porcelain")).toBe("")
})

/** Runs init as `an` of Acme until the company's first commit, which fails; returns the company's path. */
async function stopBeforeTheFirstCommit(dir: string): Promise<string> {
  const commit = spyOn(CompanyGit.prototype, "commit").mockImplementation(async () => {
    throw new CompanyGitError("killed")
  })
  try {
    await expect(runInit(dir, scripted(), { company: "Acme", name: "An", handle: "an" })).rejects.toThrow("killed")
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
  await expect(runInit(dir, scripted(), { company: "Beta", name: "Bo", handle: "bo" })).rejects.toThrow("stop")
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
  await expect(runInit(dir, scripted())).rejects.toThrow("stop")
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

test("a remote is added and pushed to with main tracking it", async () => {
  const dir = tempDir()
  const remote = bare(path.join(dir, "acme.git"))
  const ask = scripted(remote)
  await expect(runInit(dir, ask)).rejects.toThrow("stop")
  const company = path.join(dir, "home", "company")
  expect(git(remote, "rev-parse", "main")).toBe(git(company, "rev-parse", "HEAD"))
  expect(git(company, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main")
  expect(ask.seen.some((line) => line.startsWith("Remote: pushed the company to"))).toBe(true)
})

test("a remote flag is used without asking", async () => {
  const dir = tempDir()
  const remote = bare(path.join(dir, "acme.git"))
  const ask = new Script([PASSWORD, PASSWORD], { interactive: false })
  await expect(runInit(dir, ask, { ...FLAGS, remote })).rejects.toThrow("stop")
  expect(git(remote, "rev-parse", "main")).toBe(git(path.join(dir, "home", "company"), "rev-parse", "HEAD"))
  expect(ask.seen).not.toContain(REMOTE)
})

test("a push that fails is a warning with the retry and init goes on", async () => {
  const dir = tempDir()
  const nowhere = path.join(dir, "nowhere.git")
  const ask = scripted(nowhere)
  // It got past the remote, to onboarding.
  await expect(runInit(dir, ask)).rejects.toThrow("stop")
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
  await expect(runInit(dir, ask, FLAGS, { environ })).rejects.toThrow("stop")
  expect(ask.seen.some((line) => line.startsWith("Warning: couldn't push"))).toBe(true)
  expect(ask.seen.filter((line) => line.includes("ghp_sentinel42"))).toEqual([])
  expect(redact(url)).toBe("http://***@127.0.0.1:9/acme.git")
})

test("the remote is asked before the company is written", async () => {
  const dir = tempDir()
  const ask = scripted()
  await expect(runInit(dir, ask)).rejects.toThrow("stop")
  const created = ask.seen.findIndex((line) => line.startsWith("Company repo: created at"))
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
  expect(await isNew(path.join(dir, "home", "company"))).toBe(true)
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
