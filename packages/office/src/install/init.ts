/** `opencorp init`: ask for the model; run the init flow with it, which interviews the owner for the company, its CEO
 *  and its first teammates, then asks for a password and a remote; write the company, push it, and onboard this
 *  machine. */
import path from "node:path"
import type { Readable } from "node:stream"
import { agentFiles } from "../chat/hire.ts"
import type { Draft } from "../company/draft.ts"
import { CompanyGitError } from "../company/git.ts"
import { isNew, writeCompany } from "../company_template/index.ts"
import { strip } from "../perm/redact.ts"
import { strerror } from "../sandbox/fs_helper.ts"
import { shQuote } from "./fallback.ts"
import { fallbackDraft, initFlow, type Known, ModelError, passwordStep, remoteStep, STEPS } from "./interview.ts"
import { defaultHost, type Env, type Host, type Launch, launch } from "./launch.ts"
import {
  type Answers,
  askProvider,
  checkSocket,
  ensureProvider,
  GIT_ACCESS,
  type Listers,
  type LoginDefaults,
  loginDefaults,
  makeDevice,
  makeHome,
  type ModelCheck,
  modelFailed,
  onboardLocked,
  redact,
  setupConnectionFile,
  setupLock,
  userGit,
} from "./onboard.ts"
import { OnboardError, type Prompter } from "./prompts.ts"
import type * as service from "./service.ts"

/**
 * Adds `url` as `origin` to the company at `company` and pushes `main` to it, tracking it, with the user's git in
 * `environ`; resolves whether that worked.
 *
 * A failure is only a warning: the company is made, and the warning says how to retry.
 */
export async function push(company: string, url: string, prompter: Prompter, environ: Env): Promise<boolean> {
  const where = shQuote(company)
  const added = await userGit(["-C", company, "remote", "add", "origin", url], { env: environ })
  if (added.code !== 0) {
    prompter.say(
      `Warning: couldn't add the remote: ${redact(strip(added.stderr))}. Add it and push with` +
        ` \`git -C ${where} remote add origin URL && git -C ${where} push -u origin main\`.`,
    )
    return false
  }
  const pushed = await userGit(["-C", company, "push", "-u", "origin", "main"], { env: environ })
  if (pushed.code !== 0) {
    prompter.say(
      `Warning: couldn't push to the remote: ${redact(strip(pushed.stderr))}; ${GIT_ACCESS},` +
        ` then retry with \`git -C ${where} push -u origin main\`.`,
    )
    return false
  }
  prompter.say(
    `Remote: pushed the company to ${redact(url)}; other machines join it with` +
      ` \`opencorp onboard --from ${shQuote(redact(url))}\`.`,
  )
  return true
}

/** How `init` runs. */
export interface InitOptions {
  /** Lists deployments and models to pick from. */
  listers: Listers
  /** Checks the model answers before the provider is saved (`modelProblem` in production). */
  checkModel: ModelCheck
  /** What the owner gave as flags; the interview starts from it. */
  known?: Known
  /** The service manager to run the office under; `auto` (the default) takes the first that works. */
  mode?: service.Mode | "auto"
  /** A provider as JSON, which replaces the saved one. */
  stdin?: Readable
  /** This machine (`defaultHost()` by default). */
  host?: Host
  /** The caller's environment: the daemon's is taken from it, and the user's git runs in it (`process.env` by
   *  default). */
  environ?: Env
  /** Whether this device is listed for the CEO, its token saved in `identity.json` (default true). */
  device?: boolean
  /** This account's default name and handle (`loginDefaults` by default). */
  loginDefaults?: LoginDefaults
  /** Runs the init flow (`initFlow` by default). */
  interview?: typeof initFlow
}

/**
 * Creates the company at `home`, then sets up this machine's office with `onboard`.
 *
 * The model comes first: the office's setup connection from `stdin` or asked for. The company, its CEO (you), its
 * first teammates, the CEO's password hash and the remote come from the init flow with that model, which starts
 * from `known`. Without a terminal, they come from `known` and defaults, with the password and the remote asked
 * here. The company is one commit, each teammate with a seeded `profile.md`. The CEO's `person.yaml` holds only
 * the hash of their password, which is asked without echo (and skipped without a terminal); with `device`, it
 * lists this device, whose token goes in `identity.json`. The remote, `known.remote` or asked for, is added and
 * pushed to.
 *
 * Holds the setup lock (see `setupLock`) from the home onward. Rejects with `OnboardError` when a company already
 * exists here, another init or onboard holds the lock, or a step failed.
 */
export async function init(home: string, prompter: Prompter, options: InitOptions): Promise<void> {
  const environ = options.environ ?? process.env
  const one = launch(home, { environ, userHome: (options.host ?? defaultHost()).userHome })
  const company = path.join(one.home, "company")
  checkSocket(one.socket)
  await noCompanyYet(company)
  makeHome(one.home)
  const lock = await setupLock(one)
  try {
    // Checked again: another init or onboard may have made the company while this one waited.
    await noCompanyYet(company)
    await initLocked(one, prompter, options)
  } finally {
    lock.release()
  }
}

/** Throws `OnboardError` when there's a company at `company` already. */
async function noCompanyYet(company: string): Promise<void> {
  if (!(await isNew(company))) {
    throw new OnboardError(
      `there's already a company at ${company}; run \`opencorp onboard\` to set up this office for it`,
    )
  }
}

/** As `init`, for the office at `one`, whose home `init` made and whose setup lock it holds. */
async function initLocked(one: Launch, prompter: Prompter, options: InitOptions): Promise<void> {
  const host = options.host ?? defaultHost()
  const environ = options.environ ?? process.env
  const known = options.known ?? {}
  const defaults = options.loginDefaults ?? loginDefaults
  const company = path.join(one.home, "company")
  const worktrees = path.join(one.office, "worktrees")
  if (await host.answers(one.socket)) {
    throw new OnboardError(
      `the office is running, but ${company} has no company yet; stop it and run \`opencorp init\` again`,
    )
  }

  prompter.step(
    1,
    STEPS,
    "Model",
    "Your agents think with this model; its key stays in this office, readable only by you.",
  )
  const file = setupConnectionFile(one.office)
  // So setting the model up again in step 2 starts from step 1's answers.
  const answers: Answers = {}
  const { listers, checkModel } = options
  const wrote = await ensureProvider(one.office, prompter, { listers, stdin: options.stdin, checkModel, last: answers })
  prompter.say(`Model provider: ${wrote ? "saved to" : "up to date at"} ${file}`)

  prompter.step(
    2,
    STEPS,
    "Company",
    "Tell the model about you, the company and your first AI teammates; it asks until it has what it needs.",
  )
  let draft: Draft
  let url: string
  if (prompter.interactive) {
    const interview = options.interview ?? initFlow
    for (;;) {
      try {
        ;[draft, url] = await interview(file, prompter, known, defaults)
        break
      } catch (error) {
        if (!(error instanceof ModelError)) throw error
        if (await modelFailed(prompter, error.message)) {
          await askProvider(one.office, prompter, { listers, checkModel, last: answers })
        }
      }
    }
  } else {
    // Without a terminal there's nothing for a model to ask, so no flow runs: the flags and defaults make the
    // company, and the password and remote steps run as they would in the flow.
    draft = fallbackDraft(known, defaults)
    draft = { ...draft, owner: { ...draft.owner, passwordHash: await passwordStep(prompter) } }
    url = await remoteStep(prompter, known.remote ?? "")
  }
  // Checked once more before identity.json is replaced, since the steps above can take a while.
  await noCompanyYet(company)
  const owner = (options.device ?? true) ? await makeDevice(one.home, draft.owner) : draft.owner

  const extra: Record<string, Uint8Array> = {}
  for (const t of draft.team) {
    const [, files] = agentFiles({ name: t.name, handle: t.handle, title: t.title, manager: owner.handle }, t.about)
    for (const [rel, text] of Object.entries(files)) extra[rel] = Buffer.from(text)
  }
  try {
    await writeCompany(company, worktrees, { company: draft.company, owner, extra })
  } catch (error) {
    if (!(error instanceof RangeError || error instanceof CompanyGitError || strerror(error) !== undefined)) {
      throw error
    }
    throw new OnboardError(`can't write the company repo at ${company}: ${(error as Error).message}`)
  }
  const hired = draft.team.map((t) => `${t.name} (@${t.handle})`).join(", ") || "no one yet"
  prompter.say(`Company repo: created at ${company}, with you as CEO and ${hired}`)
  if (url) await push(company, url, prompter, environ)
  else prompter.say("Remote: none; the company lives only on this machine for now.")

  prompter.step(5, STEPS, "This machine", "The office service and this device, as `opencorp onboard` sets them up.")
  // The provider stdin was used up by the model step; onboard finds the file it wrote and keeps it.
  await onboardLocked(one, prompter, {
    listers,
    checkModel,
    mode: options.mode,
    host,
    environ,
    steps: false,
    loginDefaults: defaults,
  })
}
