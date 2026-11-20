/** What learning's tools and the visit share: the commands the agent's shells ran, from their records, the model's
 *  key and sign-in as they are now, and a warning when reach.sh names hq's credential files. */
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { CONNECTION } from "../../../src/features/reach/connection.ts"
import { credentialWarning, Learning, namesCredentials } from "../../../src/features/reach/learning.ts"
import { InstrumentRecord } from "../../../src/tools/terminal/record.ts"
import { learning } from "./helpers.ts"

setDefaultTimeout(30_000)

test("reach.sh naming hq's credential files or folder gets a warning", async () => {
  const { ctx } = await learning([])
  expect(credentialWarning(ctx.paths)).toBe(
    `Careful: this names ${ctx.paths.dir}, provider.json or auth.json, which hold the model's key or its ChatGPT` +
      " sign-in; what reads them reaches the model.",
  )
  const home = path.basename(ctx.paths.home)
  for (const command of ["cat auth.json", `ls ${ctx.paths.dir}`, `grep -r x ~/${home}/hq`, "cat $HOME/x/provider.json"]) {
    expect(namesCredentials(command, ctx.paths)).toBe(true)
  }
  expect(namesCredentials("ssh login1 squeue --me", ctx.paths)).toBe(false)
})

test("the commands tried are the agent's shells' from their records, oldest first, never OpenCorp's connection shell's", async () => {
  const { state } = await learning([])
  expect(state.tried()).toEqual([])
  const record = (id: string, name: string) =>
    new InstrumentRecord(path.join(state.folder, "terminal", id), {
      id, name, kind: "terminal", profile: "ssh", driver: "opencorp", started: new Date().toISOString(),
    })
  const one = record("01JDSHELLONE00000000000000", "shell 1")
  one.command("ssh login1 true", "opencorp")
  one.exit(0)
  const connection = record("01JDCONNECTION000000000000", CONNECTION)
  connection.command("sh '/x/.reach-1.sh' </dev/null >\"$TMPDIR/spec.out\"", "opencorp")
  connection.exit(0)
  await Bun.sleep(5)
  const two = record("01JDSHELLTWO00000000000000", "shell 2")
  two.command("squeue -u alice\necho done", "opencorp")
  await Bun.sleep(5)
  one.command("sleep 100", "opencorp")
  expect(state.tried()).toEqual([
    { command: "ssh login1 true", code: 0 },
    { command: "squeue -u alice\necho done", code: null },
    { command: "sleep 100", code: null },
  ])
})

test("the model's key and sign-in are read as they are now, and every one seen before is kept", async () => {
  const { ctx } = await learning([])
  let now = ["old-token"]
  const state = new Learning(ctx, () => now, 49381, ctx.paths.session("01JDLEARN00000000000000000"))
  now = ["new-token", ""]
  expect(state.secrets()).toEqual(["old-token", "new-token"])
})
