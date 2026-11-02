/** `opencorp init`'s flow (an interview that asks on the terminal, the owner's confirmation, a password and a
 *  remote), and the draft without a terminal. */
import { type FunctionTool, loadFlow, type ToolContext, tool } from "@ngocbh/yian"
import { hashPassword, passwordProblem } from "../auth/passwords.ts"
import { loadProvider, Provider } from "../chat/provider.ts"
import { type Draft, type InitOutput, draftFromOutput, draftProblems, fieldProblems } from "../company/draft.ts"
import { pyJson, strip } from "../perm/redact.ts"
import { embedded } from "../platform.ts"
import { checkCompanyTool } from "../tools/company/draft.ts"
import initYaml from "./flows/init.yaml" with { type: "file" }
import { type LoginDefaults, loginDefaults, runSetup, slug } from "./onboard.ts"
import { KeyboardInterrupt, NoTerminal, OnboardError, type Prompter, TRIES, clean } from "./prompts.ts"

/** What the owner is asked after the summary. */
export const CONFIRM = "Create this company?"
/** The answer to `CONFIRM` that creates the company. */
export const CREATE = "Yes, create it"
/** The answer to `CONFIRM` that asks for changes. */
export const CHANGE = "No, change something"
/** What the owner is asked after picking `CHANGE`. */
export const WHAT_TO_CHANGE = "What should change? (empty to talk it over)"

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

/** What the interview is told about `known`: `given`, the fields that are set, and `suggested` defaults for the
 *  owner from `defaults`. Throws `OnboardError` when the user id has no account. */
export function facts(
  known: Known,
  defaults: LoginDefaults = loginDefaults,
): { given: Record<string, string>; suggested: { name: string; handle: string; title: string } } {
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

function who(name: string, handle: string, title: string): string {
  return clean(`${name} (@${handle})` + (title ? `, ${title}` : ""))
}

/** `draft` as shown to the owner to confirm: the company, the owner, and a line for each teammate. */
export function summary(draft: Draft): string[] {
  const { owner } = draft
  const lines = [`Company: ${clean(draft.company)}`, `You: ${who(owner.name, owner.handle, owner.title ?? "CEO")}`]
  if (draft.team.length === 0) return [...lines, "Teammates: none yet"]
  lines.push("Teammates:")
  for (const t of draft.team) {
    const about = strip(clean(t.about))
    lines.push(`  ${who(t.name, t.handle, t.title)}` + (about ? `: ${about}` : ""))
  }
  return lines
}

/** The owner's terminal for one init flow run, and the error that stopped it, if one did. */
export class Asking {
  /** The `OnboardError` or `KeyboardInterrupt` that stopped the run. */
  stopped: OnboardError | KeyboardInterrupt | null = null

  constructor(readonly prompter: Prompter) {}
}

/** What `fn` resolves to, asking the owner with `state`'s prompter. An `OnboardError` or `KeyboardInterrupt`
 *  it throws is kept in `state.stopped` and rethrown, so the run's caller throws it rather than the run's
 *  failure. */
async function withOwner<T>(state: Asking, fn: (prompter: Prompter) => Promise<T>): Promise<T> {
  try {
    return await fn(state.prompter)
  } catch (error) {
    // In TS a throw inside a yian tool becomes the run's failure, so an interrupt is kept for the caller to
    // rethrow (Python's KeyboardInterrupt escaped run_flow on its own).
    if (error instanceof OnboardError || error instanceof KeyboardInterrupt) state.stopped = error
    throw error
  }
}

/**
 * The init flow's `confirm` node: check the draft in `inputs.answers` and, if it has no problems, show it and ask
 * the owner to create the company.
 *
 * Resolves to the round's `draft` (as JSON), its `changes` (the problems, or what the owner wants changed) and
 * whether the owner `accepted`.
 */
export async function confirm(
  inputs: { answers: InitOutput },
  state: Asking,
): Promise<{ draft: string; changes: string; accepted: boolean }> {
  const text = pyJson(inputs.answers, true)
  const draft = draftFromOutput(inputs.answers)
  const problems = draftProblems(draft)
  if (problems.length > 0) return { draft: text, changes: problems.join("\n"), accepted: false }
  const reply = await withOwner(state, async (prompter) => {
    for (const line of summary(draft)) prompter.say(line)
    if ((await prompter.choose(CONFIRM, [CREATE, CHANGE], CREATE)) !== CHANGE) return null
    return strip(await prompter.ask(WHAT_TO_CHANGE))
  })
  if (reply === null) return { draft: text, changes: "", accepted: true }
  const changes = reply ? `The owner wants changes: ${reply}` : "The owner wants changes; ask what to change"
  return { draft: text, changes, accepted: false }
}

/** Asks the owner `request.question`; with `request.options`, they pick one or type their own answer. A picked
 *  option goes back as the model wrote it, not as it was shown. */
export async function askUser(
  request: { question: string; options?: readonly string[] | null },
  state: Asking,
): Promise<string> {
  const options = request.options ?? []
  const question = clean(request.question)
  return withOwner(state, async (prompter) => {
    if (options.length === 0) return prompter.ask(question)
    const shown = options.map(clean)
    const picked = await prompter.choose(question, shown, "", true)
    // A typed answer, or an empty one with no option picked, goes back as it is.
    const at = shown.indexOf(picked)
    return at === -1 ? picked : options[at]!
  })
}

// The password and remote steps live here rather than in init.ts: the init flow's tools call them, and init.ts
// imports this module.

/** The steps: the model, the company, your password, the remote, and this machine. */
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
  prompter.step(3, STEPS, "Password", "Your password logs in your new devices; only its hash is kept.")
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
    4,
    STEPS,
    "Remote",
    "A git remote, such as a private GitHub repo, lets other machines join the company with " +
      "`opencorp onboard --from URL`.",
  )
  if (given) return given
  const picked = await prompter.choose(REMOTE, [NO_REMOTE], NO_REMOTE, true)
  return picked === NO_REMOTE ? "" : strip(picked)
}

/** The running init flow's terminal state: a tool's `ctx.context`. Throws when the run was given another
 *  context. */
function asking(ctx: ToolContext<unknown>): Asking {
  if (!(ctx.context instanceof Asking)) throw new Error("the init flow's tools need its Asking context")
  return ctx.context
}

/** The init flow's `confirm_company` TOOL node: `confirm` on the owner's terminal. */
export const confirmCompanyTool: FunctionTool = tool({
  name: "confirm_company",
  description: "Check the drafted company and, if it has no problems, ask the owner to create it.",
  parameters: { type: "object", properties: { answers: { type: "object" } }, required: ["answers"] },
  // The flow types this input: it is the interview's `Answers` output.
  execute: (args, ctx) => confirm(args as { answers: InitOutput }, asking(ctx)),
})

/** The init flow's `ask_password` TOOL node: `passwordStep` on the owner's terminal; the hash or null, never the
 *  password. */
export const askPasswordTool: FunctionTool = tool({
  name: "ask_password",
  description: "Ask the owner for a new password; returns its hash, or null when there's no terminal.",
  parameters: { type: "object", properties: {} },
  execute: (_args, ctx) => withOwner(asking(ctx), passwordStep),
})

/** The init flow's `ask_remote` TOOL node: `remoteStep` on the owner's terminal, given `given` from `--remote`. */
export const askRemoteTool: FunctionTool = tool({
  name: "ask_remote",
  description: "Ask the owner for a git remote URL unless one was given; returns it, or empty for none.",
  parameters: { type: "object", properties: { given: { type: "string" } }, required: ["given"] },
  // The flow passes its `!str` `input.remote`.
  execute: (args, ctx) => withOwner(asking(ctx), (prompter) => remoteStep(prompter, args.given as string)),
})

/** The model couldn't run the init flow. */
export class ModelError extends OnboardError {
  override name = "ModelError"
}

/**
 * Runs the init flow with `provider`'s model, asking the owner with `prompter`; resolves to its output.
 *
 * Rejects with `ModelError` when the run failed; `OnboardError` when the owner's input ended or no password worked
 * (the error thrown), the interview didn't settle on a company, or the user id has no account; and the
 * `KeyboardInterrupt` the owner gave.
 */
export async function runInitFlow(
  provider: Provider,
  prompter: Prompter,
  known: Known,
  defaults: LoginDefaults = loginDefaults,
): Promise<InitOutput & { readonly remote: string }> {
  const flow = await loadFlow(embedded(initYaml).toString("utf8"), { sourceLabel: "install/flows/init.yaml" })
  const inputs = { known: pyJson(facts(known, defaults), true), remote: known.remote ?? "" }
  const state = new Asking(prompter)
  const { result, message } = await runSetup(flow, inputs, provider, {
    tools: {
      check_company: checkCompanyTool,
      confirm_company: confirmCompanyTool,
      ask_password: askPasswordTool,
      ask_remote: askRemoteTool,
      ask: (request, ctx) => askUser(request, asking(ctx)),
    },
    context: state,
  })
  if (state.stopped) throw state.stopped
  if (result?.status === "failed" && result.failure?.code === "loop.max_exceeded") {
    throw new OnboardError("the interview didn't settle on a company; run `opencorp init` again")
  }
  if (message !== null) throw new ModelError(`the model couldn't run the interview: ${message}`)
  // A null message means the run finished; init.yaml's `output:` block gives this shape.
  return result!.output as InitOutput & { readonly remote: string }
}

/**
 * The new company with its CEO's password hash, and the git remote URL (empty for none), from the init flow run
 * with the model in the provider file `file`, starting from `known`.
 *
 * A missing provider file is an empty provider, so the run fails as a `ModelError`. Rejects as `runInitFlow` does,
 * and with `ProviderError` when the provider file can't be used.
 */
export async function initFlow(
  file: string,
  prompter: Prompter,
  known: Known,
  defaults: LoginDefaults = loginDefaults,
): Promise<[Draft, string]> {
  const provider = await loadProvider(file, Provider.parse)
  const output = await runInitFlow(provider, prompter, known, defaults)
  return [draftFromOutput(output), output.remote]
}
