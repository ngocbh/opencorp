/** A terminal's shell as a session's live instrument: what the registry lists of it, and the owner's keys, Ctrl-C and
 *  size reaching it. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { type LiveEvent, now } from "@opencorp/protocol"
import { Instruments } from "../../../src/runtime/sessions/instruments.ts"
import { shellInstrument } from "../../../src/tools/terminal/instrument.ts"
import { InstrumentRecord } from "../../../src/tools/terminal/record.ts"
import { Terminal } from "../../../src/tools/terminal/terminal.ts"
import { newId } from "../../../src/util/ids.ts"
import { waitFor } from "../../helpers.ts"
import { json, permissions, plainShells } from "./helpers.ts"

setDefaultTimeout(30_000)

const SESSION = newId()

test("a shell's state, output and size reach the registry; keys and Ctrl-C go to it as the owner's", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-inst-")))
  const events: LiveEvent[] = []
  const registry = new Instruments((event) => events.push(event), { everyMs: 0 })
  const { perms } = permissions()
  const terminal: Terminal = new Terminal({
    shells: plainShells(dir),
    driver: "opencorp",
    permissions: perms,
    shellHost: (name, profile) => {
      const id = newId()
      const meta = { id, name, kind: "terminal" as const, profile, driver: "opencorp", started: now() }
      const record = new InstrumentRecord(path.join(dir, "records", id), meta)
      const listing = shellInstrument({
        sessionId: SESSION,
        id,
        name,
        driver: "opencorp",
        profile,
        interactive: terminal.interactive,
        shell: () => terminal.shell(id),
      })
      registry.add(SESSION, listing)
      return {
        id,
        record,
        changed: () => registry.updated(SESSION, id),
        output: (chunk) => registry.output(SESSION, id, chunk),
      }
    },
  })
  onTestFinished(async () => {
    await terminal.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const tools = terminal.tools()
  const reply = json(await tools.run.call({ command: "echo first-4d1", why: "say it" }, { callId: "r/n/1/0" }))
  expect(reply).toMatchObject({ shell: "shell 1", status: "idle", exit: 0 })

  const [listed] = registry.list(SESSION)
  expect(listed).toMatchObject({
    session_id: SESSION,
    kind: "terminal",
    name: "shell 1",
    driver: "opencorp",
    profile: "none",
    interactive: true,
    size: { cols: 80, rows: 24 },
    status: "idle",
    command: null,
  })
  const id = listed!.id
  const updates = events.filter((e) => e.type === "instrument.updated").map((e) => e.data.status)
  expect(updates[0]).toBe("starting")
  expect(updates).toContain("running")
  const screen = () => Buffer.from(registry.screen(SESSION, id)!.data).toString("utf8")
  expect(screen()).toContain("first-4d1")
  expect(events.some((e) => e.type === "instrument.output")).toBe(true)

  // The owner's size reaches the PTY and the listing.
  const instrument = registry.get(SESSION, id)!
  instrument.resize(100, 30)
  expect(registry.list(SESSION)[0]!.size).toEqual({ cols: 100, rows: 30 })
  instrument.keys("stty size\r")
  await waitFor(() => screen().includes("30 100"), { what: "the new size" })
  await waitFor(() => registry.list(SESSION)[0]!.status === "idle", { what: "the owner's command to end" })

  // The owner's command, and their Ctrl-C to it.
  instrument.keys("sleep 30\r")
  await waitFor(() => registry.list(SESSION)[0]!.status === "running", { what: "the owner's command" })
  expect(registry.list(SESSION)[0]!.command).toBeNull()
  instrument.interrupt()
  await waitFor(() => registry.list(SESSION)[0]!.status === "idle", { what: "the Ctrl-C" })

  await terminal.close()
  expect(registry.list(SESSION)[0]!.status).toBe("ended")
})
