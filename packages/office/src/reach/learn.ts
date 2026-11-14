/** Learning the path to HQ: `learn_hq`, whose agent works it out with the owner and the host tools in `tools/`. */
import { loadFlow } from "@ngocbh/yian"
import { FileLockError } from "@ngocbh/yian/platform"
import { AUTH_FILE_ENV, ConnectionFile } from "../chat/connections.ts"
import { loadProvider, type Provider, ProviderError } from "../chat/provider.ts"
import { askUser } from "../install/interview.ts"
import {
  type Answers,
  askProviderTo,
  checkProvider,
  isSubscription,
  type Listers,
  lexists,
  type ModelCheck,
  OPENAI_AUTH,
  removePendingSignIn,
  runSetup,
  signInAgain,
  signInProblem,
  signInRemedy,
  type SubscriptionAuth,
  withDefaultModel,
  withSignIn,
} from "../install/onboard.ts"
import { OnboardError, type Prompter } from "../install/prompts.ts"
import { embedded } from "../platform.ts"
import { workerEnv } from "../worker/spawn.ts"
import { type Learning, learning, withOwnerOrStop } from "./learning.ts"
import type { ReachPaths } from "./paths.ts"
import { wellFormed } from "./ssh.ts"
import { saveAccessTool } from "./tools/save_access.ts"
import { shellTool } from "./tools/shell.ts"
import learnYaml from "./flows/learn_hq.yaml" with { type: "file" }

export { learnYaml }

/** The error of a tool call yian didn't run because its reply came at the turn cap. */
const CAPPED_CALL = "tool_limit"

/** Said before each of the agent's questions. */
export const ANSWER_GOES_TO_MODEL =
  "Your answer goes to the model. Type passwords, passphrases and codes only at ssh's own prompts, never here."

/** `ask_user`: the agent's question, marked as its own, after a line on where the answer goes. */
function askOwner(request: { question: string; options?: readonly string[] | null }, state: Learning): Promise<string> {
  return withOwnerOrStop(state, (p) => {
    p.say(ANSWER_GOES_TO_MODEL)
    return askUser({ ...request, question: `The agent asks: ${request.question}` }, state.asking)
  })
}

/** What a learning run ended with: the agent's last reply when it finished, why it failed (null when it didn't), and
 *  whether it reached the turn cap. */
export interface Learned {
  output: string | null
  message: string | null
  capped: boolean
}

/** Runs learn_hq with `provider`'s model and the host tools, in this process (no workers), with no run log, then
 *  removes the folder its commands ran in. At the turn cap yian runs none of the reply's calls, finishing each with
 *  `tool_limit`, and the model answers once more; that reply is the run's output.
 *  Rejects with the owner's `KeyboardInterrupt` or `OnboardError` (their input ended), and with the visit's stop. */
export async function runLearn(
  provider: Provider,
  inputs: { notes: string; script: string; failure: string },
  state: Learning,
): Promise<Learned> {
  const flow = await loadFlow(embedded(learnYaml).toString("utf8"), { sourceLabel: "reach/flows/learn_hq.yaml" })
  const text = { notes: wellFormed(inputs.notes), script: wellFormed(inputs.script), failure: wellFormed(inputs.failure) }
  let ran: Awaited<ReturnType<typeof runSetup>>
  let capped = false
  try {
    ran = await runSetup(flow, text, provider, {
      tools: {
        shell: shellTool,
        save_access: saveAccessTool,
        ask: (request, c) => askOwner(request, learning(c)),
      },
      context: state,
      env: workerEnv(state.ctx.env),
      signal: state.ctx.signal,
      onEvent: (event) => {
        if (event.type === "ToolCallFinished" && event.error === CAPPED_CALL) capped = true
      },
    })
  } finally {
    state.close()
  }
  const { result, message } = ran
  if (state.asking.stopped) throw state.asking.stopped
  return {
    output: result?.status === "succeeded" ? (result.output as string) : null,
    message: learnedMessage(message, provider, state.ctx.paths),
    capped,
  }
}

/** Why a learning run on `provider` failed, `message`, with yian's hint to run `yian auth openai` replaced, on the
 *  sign-in in `paths.auth`, by how to sign in again here: that command writes another file. */
export function learnedMessage(message: string | null, provider: Provider, paths: ReachPaths): string | null {
  if (message === null || provider.env[AUTH_FILE_ENV] !== paths.auth) return message
  return signInRemedy(message, {
    refused: `delete ${paths.auth} and run \`opencorp hq\` again`,
    retry: "run `opencorp hq` again later",
  })
}

/**
 * The model for learning, as its runs get it: `hq/provider.json`, else asked for with init's picker, checked, and
 * saved there. A ChatGPT subscription keeps its sign-in in `hq/auth.json`, and the runs get `YIAN_AUTH_FILE` naming
 * it; one whose sign-in is missing or can't be read is asked for again. Delete both files to forget the model.
 * `auth` and `signal` are the picker's for a device sign-in. Throws `OnboardError` when the file can't be used,
 * naming it.
 */
export async function learnProvider(
  paths: ReachPaths,
  prompter: Prompter,
  options: { listers: Listers; checkModel: ModelCheck; auth?: SubscriptionAuth; signal?: AbortSignal },
): Promise<Provider> {
  const file = paths.provider
  const { listers, checkModel, auth = OPENAI_AUTH, signal } = options
  const ask = async (last: Answers = {}) =>
    withSignIn(
      await askProviderTo(file, prompter, { listers, checkModel, last, signIn: { file: paths.auth, auth, signal } }),
      paths.auth,
    )
  // Left by a check stopped hard: it was never checked.
  removePendingSignIn(paths.auth)
  if (!lexists(file)) {
    prompter.say(`Learning needs a model. Its connection is kept in ${file}, readable only by you.`)
    return ask()
  }
  const provider = await savedProvider(file)
  if (!isSubscription(provider)) return provider
  const found = await signInProblem(paths.auth, auth, signal)
  if (found === null) return withSignIn(provider, paths.auth)
  const why = `${file} signs in to a ChatGPT subscription, but ${found.problem}`
  if (!prompter.interactive) throw new OnboardError(`${why}; delete both and run \`opencorp hq\` again`)
  prompter.say(`${why}; ${found.fix}.`)
  return ask(signInAgain(provider))
}

/** `hq/provider.json` at `file`, checked. Throws `OnboardError` when it can't be used, naming it. */
async function savedProvider(file: string): Promise<Provider> {
  const again = "fix it, or delete it to set up the model again"
  try {
    return withDefaultModel(
      await loadProvider(file, (data) => checkProvider(data, ConnectionFile.parse), { missingOk: false }),
    )
  } catch (error) {
    // A ProviderError's message names the file; checkProvider's doesn't.
    if (error instanceof ProviderError) throw new OnboardError(`${error.message}; ${again}`)
    if (error instanceof OnboardError) throw new OnboardError(`${file}: ${error.message}; ${again}`)
    if (error instanceof FileLockError) throw new OnboardError(`can't read ${file}: ${error.message}`)
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (typeof code === "string") throw new OnboardError(`can't read ${file}: ${code}`)
    throw error
  }
}
