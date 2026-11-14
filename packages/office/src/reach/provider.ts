/** The model learning runs on: `hq/provider.json`, else asked for with init's picker, and a ChatGPT subscription's
 *  sign-in in `hq/auth.json`. */
import { FileLockError } from "@ngocbh/yian/platform"
import { ConnectionFile } from "../chat/connections.ts"
import { loadProvider, type Provider, ProviderError } from "../chat/provider.ts"
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
  signInAgain,
  signInProblem,
  type SubscriptionAuth,
  withDefaultModel,
  withSignIn,
} from "../install/onboard.ts"
import { OnboardError, type Prompter } from "../install/prompts.ts"
import type { ReachPaths } from "./paths.ts"

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
