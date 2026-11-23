/** The terminal under the office's gate (yian's `beforeToolCall`): its plan says what a command or typed line would be
 *  from the shell's live state, the gate decides it, and the call acts only on the decision the gate recorded for it,
 *  checking first that the shell is still where the decision was made. */
import { expect, setDefaultTimeout, test } from "bun:test"
import type { Decided, Permissions } from "../../../src/runtime/permissions/policy.ts"
import { waitFor } from "../../helpers.ts"
import { fakePipes, json, openTerminal, permissions } from "./helpers.ts"

setDefaultTimeout(30_000)

const NO_DECISION = "no permission check decided this call"

/** Permissions under the gate: what it decided for each call id, taken once by the call that acts on it. */
function gated(): { perms: Permissions; ledger: Map<string, Decided>; held: unknown[] } {
  const ledger = new Map<string, Decided>()
  const { perms, held } = permissions()
  const taken = (callId: string | undefined) => {
    const decided = callId === undefined ? undefined : ledger.get(callId)
    if (callId !== undefined) ledger.delete(callId)
    return decided ?? null
  }
  return { perms: { ...perms, decided: taken }, ledger, held }
}

/** A terminal of fake pipes under the gate, with its audit. */
function hooked() {
  let fake!: ReturnType<typeof fakePipes>
  const g = gated()
  const t = openTerminal({ perms: g.perms, shells: (dir) => (fake = fakePipes(dir)).shells, audit: true })
  return { ...t, ...g, fake }
}

test("a plan reads what a command would be from the terminal's live state: its action, where, card and basis", () => {
  const t = hooked()
  expect(t.terminal.plan("run", { command: "make", why: "build it" })).toEqual({
    decide: true,
    tool: "terminal_run",
    action: { kind: "command", text: "make" },
    where: { profile: "workspace", cwd: t.dir, writable: [t.dir, "/tmp"] },
    why: "build it",
    args: { command: "make", why: "build it", wait: 30, cwd: t.dir },
    basis: { cwd: t.dir },
    shell: null,
  })
  // A call with nothing to decide: a read, a call its own refusal stops (bad arguments, a shell that isn't there, a
  // line typed into pipes).
  expect(t.terminal.plan("read", { shell: "shell 1" })).toEqual({ decide: false })
  expect(t.terminal.plan("run", { why: "no command" })).toEqual({ decide: false })
  expect(t.terminal.plan("run", { command: "make", why: "x", shell: "shell 9" })).toEqual({ decide: false })
  expect(t.terminal.plan("type", { shell: "shell 1", text: "y", why: "x" })).toEqual({ decide: false })
})

test("a call the gate decided runs, its row saying why; one it didn't decide runs nothing", async () => {
  const t = hooked()
  t.ledger.set("r/n/1/0", { why: "by read-only", basis: { cwd: t.dir }, approved: false })
  expect(json(await t.call("run", { command: "echo hi", why: "x" }, { callId: "r/n/1/0" }))).toMatchObject({ exit: 0 })
  await waitFor(() => t.audits.length === 1, { what: "the row" })
  expect(t.audits[0]).toMatchObject({ outcome: "ok", tool: "terminal_run", text: "echo hi", why: "by read-only" })
  // Its decision is taken by the call: a second call under the id has none.
  expect(json(await t.call("run", { command: "echo hi", why: "x" }, { callId: "r/n/1/0" }))).toEqual({
    refused: NO_DECISION,
  })
  expect(json(await t.call("run", { command: "echo no", why: "x" }, { callId: "r/n/2/0" }))).toEqual({
    refused: NO_DECISION,
  })
  expect(t.fake.commands).toEqual(["echo hi"])
  // The gate holds its calls itself: the terminal holds none.
  expect(t.held).toEqual([])
})

test("an approved command runs, its row naming who approved it", async () => {
  const t = hooked()
  t.ledger.set("r/n/1/0", { why: "approved by @ngocbh", basis: { cwd: t.dir }, approved: true })
  expect(json(await t.call("run", { command: "echo ok", why: "x" }, { callId: "r/n/1/0" }))).toMatchObject({ exit: 0 })
  await waitFor(() => t.audits.length === 1, { what: "the row" })
  expect(t.audits[0]).toMatchObject({ outcome: "ok", why: "approved by @ngocbh" })
})

test("a shell in another folder than its decision was made in runs nothing: the call is to be checked again", async () => {
  const t = hooked()
  t.ledger.set("r/n/1/0", { why: "approved by @ngocbh", basis: { cwd: "/elsewhere" }, approved: true })
  const reply = json(await t.call("run", { command: "echo moved", why: "x" }, { callId: "r/n/1/0" }))
  expect(reply.refused).toBe(
    `the shell is in another folder than when this command was approved (/elsewhere, now ${t.dir}); run it again to ` +
      "have it checked there",
  )
  expect(t.fake.commands).toEqual([])
})

test("the gate's held and refused calls are the terminal's audit rows, as its own gate wrote them", () => {
  const t = hooked()
  const plan = t.terminal.plan("run", { command: "rm -rf build", why: "x" })
  t.terminal.audited(plan, "held", "Ask mode")
  t.terminal.audited(plan, "denied", "Not run: a deny rule: rm *.")
  expect(t.audits).toEqual([
    { outcome: "held", tool: "terminal_run", text: "rm -rf build", shell: null, reason: "Ask mode" },
    { outcome: "denied", tool: "terminal_run", text: "rm -rf build", shell: null, reason: "Not run: a deny rule: rm *." },
  ])
})
