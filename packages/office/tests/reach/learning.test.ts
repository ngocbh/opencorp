/** What learn_hq's two tools share: a warning when a command or reach.sh names hq's credential files, and no
 *  look-alike blank in either. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { ReportedToolError } from "@ngocbh/yian"
import { OnboardError } from "../../src/install/prompts.ts"
import { credentialWarning, namesCredentials } from "../../src/reach/learning.ts"
import { saveAccess, saveQuestion } from "../../src/reach/tools/save_access.ts"
import { runShell } from "../../src/reach/tools/shell.ts"
import { learning, NOTES, rejection } from "./helpers.ts"

setDefaultTimeout(30_000)

test("a command or reach.sh naming hq's credential files or folder gets a warning above the question", async () => {
  const { prompter, state, ctx } = await learning(["2", "", "2", "", "2", ""])
  const warning = credentialWarning(ctx.paths)
  expect(warning).toBe(
    `Careful: this names ${ctx.paths.dir}, provider.json or auth.json, which hold the model's key or its ChatGPT` +
      " sign-in; what reads them reaches the model.",
  )
  const home = path.basename(ctx.paths.home)
  for (const command of ["cat auth.json", `ls ${ctx.paths.dir}`, `grep -r x ~/${home}/hq`, "cat $HOME/x/provider.json"]) {
    expect(namesCredentials(command, ctx.paths)).toBe(true)
  }
  expect(namesCredentials("ssh login1 squeue --me", ctx.paths)).toBe(false)
  await rejection(runShell({ command: "cat provider.json", why: "look" }, state))
  expect(prompter.seen.slice(0, 3)).toEqual(["The model wants to run a command: look", warning, "  1  cat provider.json"])
  prompter.seen.length = 0
  await rejection(runShell({ command: "ssh login1 true", why: "log in" }, state))
  expect(prompter.seen).not.toContain(warning)
  prompter.seen.length = 0
  await rejection(saveAccess({ script: "cat auth.json\n", notes: NOTES, risks: [] }, state))
  expect(prompter.seen.at(-3)).toBe(warning)
  expect(prompter.seen.at(-2)).toBe(saveQuestion(1))
})

/** Look-alike blanks that aren't shell whitespace, and invisible ones. */
const LOOK_ALIKES = ["\u00a0", "\u202f", "\u3000", "\u2028", "\u2800", "\u3164"]

test.each(LOOK_ALIKES)("a command or reach.sh holding a look-alike blank is refused, naming where [%p]", async (blank) => {
  const hex = blank.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")
  const { dir, prompter, state, ctx } = await learning([])
  const marker = path.join(dir, "PWNED")
  const command = `echo listing jobs${blank}# ; touch '${marker}'`
  const error = await rejection(runShell({ command, why: "list the jobs" }, state))
  expect(error).toBeInstanceOf(ReportedToolError)
  expect(error.message).toStartWith(`Not run: the command holds U+${hex} at line 1, column 18;`)
  const saving = await rejection(saveAccess({ script: `set -eu\n${command}\n`, notes: NOTES, risks: [] }, state))
  expect(saving.message).toStartWith(`Not saved: reach.sh holds U+${hex} at line 2, column 18;`)
  expect(prompter.seen).toEqual([])
  expect(fs.existsSync(marker)).toBe(false)
  expect(fs.existsSync(ctx.paths.script)).toBe(false)
})

test("a child runs with the terminal handed over, and the terminal comes back even when the hand-over fails", async () => {
  const { prompter, state } = await learning([])
  const during: string[][] = []
  expect(await state.handOver("Running it.", async () => (during.push([...prompter.terminal]), "ran"))).toBe("ran")
  expect(during).toEqual([["Running it."]])
  expect(prompter.terminal).toEqual(["Running it.", "take back"])
  prompter.terminal.length = 0
  // The screen's answers ended (its Ctrl-C) after it had already stepped aside.
  prompter.handOver = async (why) => {
    prompter.terminal.push(why)
    throw new OnboardError("no answer")
  }
  let ran = false
  const error = await rejection(state.handOver("Running it.", async () => (ran = true)))
  expect(error).toBeInstanceOf(OnboardError)
  expect(ran).toBe(false)
  expect(prompter.terminal).toEqual(["Running it.", "take back"])
})
