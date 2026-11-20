/** `opencorp init`: ask for the model, a password and a remote on the terminal; then interview the owner, in a chat
 *  with OpenCorp, for the company, its CEO and its first teammates; write the company, push it, and onboard this
 *  machine, asking nothing more. */
import path from "node:path"
import type { Readable } from "node:stream"
import type { ModelCheck } from "../../models/check.ts"
import { agentFiles } from "../../company/hire.ts"
import type { Draft } from "../../company/draft.ts"
import { CompanyGitError } from "../../company/git.ts"
import { companyState, writeCompany } from "../../company/template.ts"
import { redactUrls, strip } from "../../util/redact.ts"
import type { Env } from "../../util/env.ts"
import { strerror } from "../../util/errors.ts"
import { shQuote } from "../../runtime/service/fallback.ts"
import {
  facts,
  fallbackDraft,
  interview,
  type InterviewChat,
  type Known,
  passwordStep,
  remoteStep,
  STEPS,
} from "./interview.ts"
import { defaultHost, type Host, type Launch, launch } from "../../runtime/service/launch.ts"
import {
  askProvider,
  checkSocket,
  damageMessage,
  ensureProvider,
  GIT_ACCESS,
  type Listers,
  type LoginDefaults,
  loginDefaults,
  makeDevice,
  makeHome,
  modelAnswers,
  officeRunning,
  onboardLocked,
  setupConnectionFile,
  setupLock,
  setupProvider,
  type SubscriptionAuth,
  userGit,
} from "./onboard.ts"
import { askingNothing, OnboardError, type Prompter } from "./prompts.ts"
import { CHANGE, CONFIRM, CREATE, summary } from "./tools/propose_company.ts"
import type * as service from "../../runtime/service/service.ts"

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
      `Warning: couldn't add the remote: ${redactUrls(strip(added.stderr))}. Add it and push with` +
        ` \`git -C ${where} remote add origin URL && git -C ${where} push -u origin main\`.`,
    )
    return false
  }
  const pushed = await userGit(["-C", company, "push", "-u", "origin", "main"], { env: environ })
  if (pushed.code !== 0) {
    prompter.say(
      `Warning: couldn't push to the remote: ${redactUrls(strip(pushed.stderr))}; ${GIT_ACCESS},` +
        ` then retry with \`git -C ${where} push -u origin main\`.`,
    )
    return false
  }
  prompter.say(
    `Remote: pushed the company to ${redactUrls(url)}; other machines join it with` +
      ` \`opencorp onboard --from ${shQuote(redactUrls(url))}\`.`,
  )
  return true
}

/** What the company step says before the interview's chat opens. */
export const COMPANY_CHAT = "Tell OpenCorp about you, the company and your first AI teammates, in a chat in the TUI."
/** Why the company comes from the flags, where there's no chat. */
export const NO_CHAT =
  "There's no terminal the TUI can draw on, so the company comes from your flags and defaults: " +
  "--company, --name, --handle, --title, --agent and --agent-handle."
/** Why init stopped when the owner didn't confirm the company from the flags. */
export const NOT_CREATED =
  "the company wasn't created; change it with --company, --name, --handle, --title, --agent or --agent-handle, " +
  "or run `opencorp init` in a terminal the TUI can draw on"

/** Shows `draft`, the company from the flags and defaults, and asks the owner to create it. Rejects with
 *  `OnboardError` when they don't. */
async function confirmed(prompter: Prompter, draft: Draft): Promise<void> {
  prompter.say(NO_CHAT)
  for (const line of summary(draft)) prompter.say(line)
  if ((await prompter.choose(CONFIRM, [CREATE, CHANGE], CREATE)) !== CREATE) throw new OnboardError(NOT_CREATED)
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
  /** Runs the interview's chat with OpenCorp, with the TUI on it; where the TUI can't draw there is none, and the
   *  company comes from `known` and defaults, shown to the owner to confirm. */
  chat?: InterviewChat
  /** Makes yian's `OpenAIAuth` for a ChatGPT sign-in or its refresh (the real one by default). */
  auth?: SubscriptionAuth
}

/**
 * Creates the company at `home`, then sets up this machine's office with `onboard`.
 *
 * Everything is asked before the chat, and nothing after it. The model comes first: the office's setup connection
 * from `stdin`, kept from an earlier run (checked again where the chat will run), or asked for. Then the CEO's password, asked without
 * echo (and skipped without a terminal), of which `person.yaml` holds only the hash, and the remote, `known.remote`
 * or asked for. Then the company, its CEO (you) and its first teammates: from the interview's `chat` with OpenCorp on
 * that model, which starts from `known`; where there's no chat, from `known` and defaults, shown to the owner to
 * confirm; and with no one to ask, from `known` and defaults alone. The company is one commit, each teammate with a
 * seeded `memory/profile.md`; with `device`, the CEO's `person.yaml` lists this device, whose token goes in
 * `identity.json`. The remote is added and pushed to.
 *
 * Holds the setup lock (see `setupLock`) from the home onward. Rejects with `OnboardError` when a company already
 * exists here, another init or onboard holds the lock, a step failed or the owner didn't confirm the company, and
 * with `KeyboardInterrupt` when they left the chat.
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

/** Throws `OnboardError` when there's a company at `company` already, or something init can't make one over. */
async function noCompanyYet(company: string): Promise<void> {
  const state = await companyState(company)
  if (state.kind === "damaged") throw new OnboardError(damageMessage(company, state))
  if (state.kind === "ok") {
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
  // One that holds its lock but doesn't answer is running too.
  if (await officeRunning(one, host)) {
    throw new OnboardError(
      `the office is running, but ${company} has no company yet; run \`opencorp stop\`, then \`opencorp init\` again`,
    )
  }

  prompter.step(
    1,
    STEPS,
    "Model",
    "Your agents think with this model; its key stays in this office, readable only by you.",
  )
  const file = setupConnectionFile(one.office)
  const { listers, checkModel, auth } = options
  const chat = prompter.interactive ? options.chat : undefined
  let wrote = await ensureProvider(one.office, prompter, { listers, stdin: options.stdin, checkModel, auth })
  // Where the chat will run, one kept from an earlier run is checked as a new one is: a model that stopped answering
  // is set up again here, before the chat needs it. Without a chat, init asks the model nothing.
  if (!wrote && chat !== undefined && !(await modelAnswers(prompter, await setupProvider(file), checkModel))) {
    await askProvider(one.office, prompter, { listers, checkModel, auth })
    wrote = true
  }
  prompter.say(`Model provider: ${wrote ? "saved to" : "up to date at"} ${file}`)

  // Before the password, so flags that can't make a company, or a user id with no account, stop init first.
  const told = chat === undefined ? null : facts(known, defaults)
  const fallback = chat === undefined ? fallbackDraft(known, defaults) : null

  const passwordHash = await passwordStep(prompter)
  const url = await remoteStep(prompter, known.remote ?? "")

  let draft: Draft
  if (told !== null) {
    prompter.step(4, STEPS, "Company", COMPANY_CHAT)
    draft = await interview(chat!, { file, sessions: path.join(one.office, "setup"), facts: told, environ })
  } else {
    prompter.step(4, STEPS, "Company", "Your company, you as its CEO, and your first AI teammate.")
    draft = fallback!
    if (prompter.interactive) await confirmed(prompter, draft)
  }
  draft = { ...draft, owner: { ...draft.owner, passwordHash } }
  // Checked once more before identity.json is replaced, since the steps above can take a while.
  await noCompanyYet(company)
  const owner = (options.device ?? true) ? await makeDevice(one.home, draft.owner) : draft.owner

  const extra: Record<string, Uint8Array> = {}
  for (const t of draft.team) {
    // Trimmed as the hire API trims them, so person.yaml holds what a hire would have written.
    const hire = { name: t.name.trim(), handle: t.handle, title: t.title.trim(), manager: owner.handle }
    const [, files] = agentFiles(hire, t.about)
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
  // The provider stdin was used up by the model step; onboard finds the file it wrote and keeps it. Everything was
  // asked before the chat, so this asks nothing.
  await onboardLocked(one, askingNothing(prompter), {
    listers,
    checkModel,
    auth,
    mode: options.mode,
    host,
    environ,
    steps: false,
    loginDefaults: defaults,
  })
}
