// Runs the TUI in this terminal: `bun run dev` against a real office on a temp home whose model
// is the fake LLM, replying with a scripted reply; `bun run dev --office` against the office at
// the default socket, or `--socket PATH` against the one at PATH (both in the current folder).
import { startOffice, type TestOffice } from "@opencorp/office/testing/office"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { run } from "../src/app"
import { Global } from "../src/core/global"
import { readIdentity, defaultSocket, identityPath } from "@opencorp/client/node"

const { values } = parseArgs({
  options: {
    socket: { type: "string" },
    office: { type: "boolean" },
    session: { type: "string", short: "s" },
    continue: { type: "boolean", short: "c" },
    person: { type: "string" },
  },
})

const REPLY = "Looked at it. The flaky test waits on a timer; I'd swap it for a fake clock and rerun."

const real = values.socket ?? (values.office ? defaultSocket() : undefined)
let office: TestOffice | undefined
let cwd = process.cwd()
if (!real) {
  const started = startOffice()
  // A signal while the office starts, or one the TUI doesn't end on, still stops it.
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.once(sig, async () => {
      await (await started.catch(() => undefined))?.stop()
      process.exit(128 + os.constants.signals[sig])
    })
  office = await started
  // Enough replies that every model call gets one.
  office.llm.script(...Array.from({ length: 300 }, () => ({ content: REPLY })))
  // The TUI keeps its own state under OPENCORP_HOME: the temp home's, not ~/.opencorp.
  process.env.OPENCORP_HOME = office.home
  cwd = path.join(office.root, "proj")
  fs.mkdirSync(cwd)
  fs.writeFileSync(path.join(cwd, "README.md"), "# proj\n\nA project folder for `bun run dev`.\n")
  // Theme discovery walks up from the process's folder: from here it never reaches ~/.opencorp/themes.
  process.chdir(cwd)
}

try {
  await Effect.runPromise(
    run({
      socket: real ?? office!.socket,
      // A real office may need this device's token; the temp office has no devices, so it takes none.
      token: real ? readIdentity(identityPath())?.token : undefined,
      cwd,
      args: { sessionID: values.session, continue: values.continue, person: values.person },
    }).pipe(Effect.provide(Global.layer)),
  )
} finally {
  await office?.stop()
}
