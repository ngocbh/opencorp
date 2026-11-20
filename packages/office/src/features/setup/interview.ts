/** `opencorp init`'s interview, a chat with OpenCorp that proposes the company on a card; the draft without a chat;
 *  and the password and remote steps init asks before it. */
import path from "node:path"
import { hashPassword, passwordProblem } from "../../runtime/auth/passwords.ts"
import { providerSecrets } from "../../models/check.ts"
import type { Provider } from "../../models/provider.ts"
import { type Draft, fieldProblems } from "../../company/draft.ts"
import type { BuiltinChat, BuiltinSession, ChatEnd } from "../../runtime/sessions/builtin.ts"
import { workerEnv } from "../../runtime/worker/spawn.ts"
import type { Env } from "../../util/env.ts"
import { newId } from "../../util/ids.ts"
import { pyJson, redact, strip } from "../../util/redact.ts"
import { messageOf } from "../../util/sockets.ts"
import { embedded } from "../../platform.ts"
import { Proposal, proposeCompanyTool } from "./tools/propose_company.ts"
import initYaml from "./flows/init.yaml" with { type: "file" }
import { type LoginDefaults, loginDefaults, setupProvider, signInRemedy, slug } from "./onboard.ts"
import { KeyboardInterrupt, NoTerminal, OnboardError, type Prompter, TRIES, clean } from "./prompts.ts"

/** The `opencorp init` flag that sets each draft field a problem can be about. */
export const FLAGS: Readonly<Record<string, string>> = {
  company: "--company",
  "owner.name": "--name",
  "owner.handle": "--handle",
  "teammate.name": "--agent",
  "teammate.handle": "--agent-handle",
}

/** What the owner gave as command-line flags; a field is set when it is a non-empty string. */
export interface Known {
  readonly company?: string
  /** The owner's name. */
  readonly name?: string
  /** The owner's handle. */
  readonly handle?: string
  /** The owner's title. */
  readonly title?: string
  /** The first teammate's name. */
  readonly agent?: string
  /** The first teammate's handle; snake case, as the model is told it. */
  readonly agent_handle?: string
  /** The git remote URL. */
  readonly remote?: string
}

/** `Known`'s fields in the order the model is told them. Not `remote`: a remote URL can hold credentials, so it
 *  never reaches the model. */
const FIELDS = ["company", "name", "handle", "title", "agent", "agent_handle"] as const

/** What the interview is told: the flags the owner `given`, and `suggested` defaults for the owner. */
export interface Facts {
  readonly given: Readonly<Record<string, string>>
  readonly suggested: { readonly name: string; readonly handle: string; readonly title: string }
}

/** What the interview is told about `known`: `given`, the fields that are set, and `suggested` defaults for the
 *  owner from `defaults`. Throws `OnboardError` when the user id has no account. */
export function facts(known: Known, defaults: LoginDefaults = loginDefaults): Facts {
  const [name, handle] = defaults()
  const given: Record<string, string> = {}
  for (const field of FIELDS) if (known[field]) given[field] = known[field]
  return { given, suggested: { name, handle, title: "CEO" } }
}

/** The draft without an interview: `known`, with defaults for the rest and one teammate. Throws `OnboardError`
 *  when the draft has problems, the message naming the flag to pass for each, or when the user id has no
 *  account. */
export function fallbackDraft(known: Known, defaults: LoginDefaults = loginDefaults): Draft {
  const [name, handle] = defaults()
  const agent = known.agent || "Minh"
  const draft: Draft = {
    company: known.company || "My company",
    owner: { handle: known.handle || handle, name: known.name || name, title: known.title || "CEO" },
    team: [{ name: agent, handle: known.agent_handle || slug(agent) || "agent", title: "Engineer", about: "" }],
  }
  const problems = fieldProblems(draft)
  if (problems.length > 0) {
    const hints = problems
      .map(([field, why]) => (field !== null && Object.hasOwn(FLAGS, field) ? `${why}; pass ${FLAGS[field]}` : why))
      .join("; ")
    throw new OnboardError(`can't set up the company without a terminal: ${hints}`)
  }
  return draft
}

/** The steps: the model, your password, the remote, the company, and this machine. */
export const STEPS = 5

/** The question for a new password. */
export const YOUR_PASSWORD =
  "Your password, to log in new devices with (at least 12 characters, one you use nowhere else; not shown)"
/** The question that repeats the password. */
export const PASSWORD_AGAIN = "Your password again"
/** The question for the git remote. */
export const REMOTE = "Git remote URL (type it, or pick None for now)"
/** `REMOTE`'s one option. */
export const NO_REMOTE = "None for now"

/** Shows the password step and resolves to the hash of a new password, asked twice without echo; null when
 *  there's no terminal to ask on. Rejects with `OnboardError` when no password worked. */
export async function passwordStep(prompter: Prompter): Promise<string | null> {
  prompter.step(2, STEPS, "Password", "Your password logs in your new devices; only its hash is kept.")
  for (let i = 0; i < TRIES; i++) {
    let password: string
    try {
      password = await prompter.secret(YOUR_PASSWORD)
    } catch (error) {
      if (!(error instanceof NoTerminal)) throw error
      prompter.say("Password: none, since there's no terminal to ask on; set one later with `opencorp password`")
      return null
    }
    const why = passwordProblem(password)
    if (why) {
      prompter.say(`That doesn't work: ${why}`)
    } else if ((await prompter.secret(PASSWORD_AGAIN)) !== password) {
      prompter.say("That doesn't work: the two passwords differ")
    } else {
      return hashPassword(password)
    }
  }
  throw new OnboardError("no usable password")
}

/** Shows the remote step and resolves to the git remote URL: `given` (from `--remote`), or the one the owner
 *  types; empty when they pick none. */
export async function remoteStep(prompter: Prompter, given: string): Promise<string> {
  prompter.step(
    3,
    STEPS,
    "Remote",
    "A git remote, such as a private GitHub repo, lets other machines join the company with " +
      "`opencorp onboard --from URL`.",
  )
  if (given) return given
  const picked = await prompter.choose(REMOTE, [NO_REMOTE], NO_REMOTE, true)
  return picked === NO_REMOTE ? "" : strip(picked)
}

/** The owner's first message in the interview's chat: their choice to set up the company. */
export const INTERVIEW_FIRST = "Set up my company"

/** Runs the interview's session on the no-office host with the TUI on it (see `BuiltinChat`); its session drives no
 *  terminal. */
export type InterviewChat = BuiltinChat<never>

/** What the interview runs on, and what it is told. */
export interface InterviewOptions {
  /** The office's setup connection, `connections/office.json`, whose model the interview runs on. */
  readonly file: string
  /** Where the interview's sessions go, `<office>/setup`: each in a folder of its own, apart from the daemon's. */
  readonly sessions: string
  /** What the owner gave as flags, and the suggested defaults. */
  readonly facts: Facts
  /** The environment the session's workers start from (`process.env` by default), whose credentials are kept out of
   *  what init says. */
  readonly environ?: Env
}

/** The interview's session for the no-office host: init's flow, told `options.facts`, from the owner's choice to set
 *  up the company, on `provider`'s model, in a fresh folder under `options.sessions`. Its one tool is
 *  `propose_company`, whose Yes keeps the company in `proposal`. */
export function interviewSession(
  provider: Provider,
  options: Pick<InterviewOptions, "sessions" | "facts">,
  proposal: Proposal,
): BuiltinSession<never> {
  return {
    agent: { handle: "opencorp", name: "OpenCorp" },
    flow: { name: "init", text: embedded(initYaml).toString("utf8") },
    inputs: { known: pyJson(options.facts, true) },
    first: INTERVIEW_FIRST,
    model: { llm_config: { ...(provider.llm_config ?? {}) }, env: { ...provider.env } },
    folder: path.join(options.sessions, newId()),
    tools: (binding) => ({
      groups: { propose_company: { propose_company: proposeCompanyTool({ proposal, binding }) } },
    }),
  }
}

/**
 * The company the owner accepted in the interview: a chat with OpenCorp, run by `chat` on the model in the office's
 * setup connection (on a subscription, with the sign-in beside it). Accepted on its card, the company is the result
 * however the chat ends after.
 *
 * Rejects with `KeyboardInterrupt` when the owner left the chat first; with `OnboardError` when the chat couldn't
 * start (its host or the TUI), saying why and how to make the company without it, when the session failed (saying
 * why and that the next `opencorp init` checks the model first), or when it ended with nothing accepted, never with
 * the model's key or sign-in; and with `ProviderError` when the connection can't be used.
 */
export async function interview(chat: InterviewChat, options: InterviewOptions): Promise<Draft> {
  const provider = await setupProvider(options.file)
  const proposal = new Proposal()
  // Read at each use: the run's first model call may refresh a subscription's tokens.
  const secrets = () => providerSecrets(provider, workerEnv(options.environ ?? process.env))
  let end: ChatEnd
  try {
    end = await chat(interviewSession(provider, options, proposal))
  } catch (error) {
    if (proposal.accepted !== null) return proposal.accepted
    if (error instanceof KeyboardInterrupt) throw error
    throw new OnboardError(
      `can't run the interview's chat: ${clean(redact(messageOf(error), [], secrets()))}; run \`opencorp init\` with ` +
        "TERM=dumb to make the company from your flags, or pass the provider with --provider-stdin",
    )
  }
  if (proposal.accepted !== null) return proposal.accepted
  if (end.status === "left") throw new KeyboardInterrupt()
  if (end.status === "failed") {
    const why = redact(end.error ?? "the session failed", [], secrets())
    const message = signInRemedy(why, { refused: "sign in to ChatGPT again", retry: "OpenAI may answer later" })
    throw new OnboardError(
      `the model couldn't run the interview: ${clean(message)}; run \`opencorp init\` again: it checks the model ` +
        "first and offers to set it up again",
    )
  }
  throw new OnboardError("the interview ended before a company was accepted; run `opencorp init` again")
}
