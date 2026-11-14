/** The fixed texts the owner reads before learning the path to HQ and before saving it, and while ssh has the
 *  terminal, kept out of the flow so the model can't edit them; the agent's risks specific to the setup follow them.
 *  The texts are risks.md's. */
import { embedded } from "../platform.ts"
import type { ReachPaths } from "./paths.ts"
import { LEARNING_PERSIST_S, PERSIST_S } from "./ssh.ts"
import risksMd from "./risks.md" with { type: "file" }

/** risks.md's texts by name. */
const TEXTS = headed(embedded(risksMd).toString("utf8"))

/** The `- ` lines under each `## ` heading of `markdown`; its other lines are for whoever edits it. */
function headed(markdown: string): Map<string, string[]> {
  const texts = new Map<string, string[]>()
  let lines: string[] = []
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) texts.set(line.slice(3), (lines = []))
    else if (line.startsWith("- ")) lines.push(line.slice(2))
  }
  return texts
}

/** The lines of risks.md's text `name`, each `{key}` in them replaced by `values[key]` in one pass. */
function text(name: string, values: Record<string, string | number> = {}): string[] {
  const found = TEXTS.get(name)
  if (found === undefined) throw new Error(`risks.md has no ${name}`)
  return found.map((line) =>
    line.replace(/\{(\w+)\}/g, (_, key: string) => {
      if (!Object.hasOwn(values, key)) throw new Error(`risks.md's ${name} names {${key}}, which isn't filled in`)
      return String(values[key])
    }),
  )
}

/** Shown before every learning run, ahead of asking to use the model. */
export const beforeLearning = (paths: ReachPaths): string[] => text("beforeLearning", { dir: paths.dir })

/** Shown by save_access with the two files, before the owner saves; the agent's risks for this setup follow. */
export const beforeSaving = (paths: ReachPaths): string[] =>
  text("beforeSaving", {
    persist_s: PERSIST_S,
    learning_persist_minutes: LEARNING_PERSIST_S / 60,
    provider: paths.provider,
    auth: paths.auth,
  })

/** The answer that starts a learning run. */
export const LEARN = text("LEARN").join("\n")
/** Asked before learning a first path. */
export const LEARN_QUESTION = text("LEARN_QUESTION").join("\n")
/** Asked before learning again in place of a saved path. */
export const RELEARN_QUESTION = text("RELEARN_QUESTION").join("\n")
/** Said when an approved command takes the terminal. */
export const HAND_OVER_COMMAND = text("HAND_OVER_COMMAND").join("\n")
/** Said when the chain test takes the terminal. */
export const HAND_OVER_TEST = text("HAND_OVER_TEST").join("\n")
