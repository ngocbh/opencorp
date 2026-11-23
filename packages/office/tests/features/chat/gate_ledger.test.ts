/** What the gate lets a terminal call do, and nothing more: a restored terminal hold it can't read keeps its card for
 *  the owner, only an approver's Yes approves, the No of a reply reaches its later calls at once, and what the gate
 *  decided for a call is gone once its job ends or its call closes. `ChatApprovals` over a host these tests play. */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import type { PendingCall } from "@ngocbh/yian/run"
import type { GatedCall, ToolSource } from "@ngocbh/yian/tools"
import { type ApprovalHost, ChatApprovals } from "../../../src/features/chat/approvals.ts"
import { Answers } from "../../../src/runtime/questions/ask.ts"
import { holdApproval, YES } from "../../../src/runtime/questions/approval.ts"
import type { CommandPlan } from "../../../src/tools/terminal/terminal.ts"
import { CEO } from "../../server/helpers.ts"
import { chatOffice, fakeLlm, newSession, noWorkersLeft } from "./helpers.ts"

setDefaultTimeout(30_000)
afterAll(noWorkersLeft)

const RUN = "run-ledger"
const TERMINAL: ToolSource = { kind: "host", group: "terminal", tool: "run" }

/** What the terminal would act on for `command` in a new shell: a plan the gate decides. */
function planOf(command: string): CommandPlan {
  return {
    decide: true,
    tool: "terminal_run",
    action: { kind: "command", text: command },
    where: { profile: "workspace", cwd: "/w", writable: ["/w"] },
    why: "as asked",
    args: { command, why: "as asked", wait: 30, cwd: "/w" },
    basis: { cwd: "/w" },
    shell: null,
  }
}

/** A session's approvals in `mode`, over a host whose terminal plans as `plans` says (nothing to decide for an
 *  unknown command) and that records what it releases and completes; `drain` runs the jobs it posted. */
async function approvals(mode: "auto" | "default" | "ask" = "auto", plans: Record<string, CommandPlan> = {}) {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const sid = await newSession(o, { openedBy: CEO })
  o.office.store.updateSession(sid, { mode })
  const answers = new Answers(o.office.store, { log: () => {} })
  const posted: (() => unknown)[] = []
  const released: { callId: string; note: string | null }[] = []
  const completed: { callId: string; output: string }[] = []
  const between: (() => void)[] = []
  const host: ApprovalHost = {
    liveRun: () => RUN,
    completeWithAnswer: async () => {
      for (const job of between.splice(0)) job()
    },
    post: (_label, job) => void posted.push(job),
    notice: () => {},
    settle: () => {},
    planCommand: (_tool, args) => (typeof args?.command === "string" ? plans[args.command] : undefined) ?? { decide: false },
    audited: () => {},
    release: async (callId, note) => void released.push({ callId, note }),
    completeCall: async (callId, output) => void completed.push({ callId, output }),
    onQuestion: (question, options) => answers.ask(question, options),
    released: () => false,
    secretValues: async () => [],
  }
  const session = () => o.office.store.getSession(sid)!
  const chat = new ChatApprovals({
    store: o.office.store,
    workers: o.registry,
    connections: o.office.connections,
    paths: o.office.paths,
    session,
    where: () => ({ profile: "workspace", cwd: "/w", writable: ["/w"] }),
    charge: () => {},
    host,
    git: o.office.git,
    handle: "minh",
    log: () => {},
  })
  const perms = await chat.permissions(RUN, host.onQuestion)
  const drain = async () => {
    while (posted.length > 0) await posted.shift()!()
  }
  /** Holds a command card for call `callId`, as the gate makes one. */
  const card = (callId: string, command: string) => {
    const approval = {
      kind: "command" as const, tool: "terminal_run", action: command, args: { command, why: "as asked", cwd: "/w" },
      why: "as asked", reason: "Ask mode", rules: [], partial: false, into: null,
    }
    holdApproval(session(), RUN, host.onQuestion, { always: true })(approval, callId)
    return o.office.store.getQuestionByCall(callId)!
  }
  return { o, chat, perms, drain, released, completed, between, card }
}

/** A hold yian recorded: a terminal command's call `n`, with `args` (null when it recorded none). */
function held(n: number, args: Record<string, unknown> | null): PendingCall {
  return {
    callId: `${RUN}/chat#0/reply/1/${n}`, node: "chat#0/reply", tool: "terminal_run", arguments: args as never,
    pendingSeq: 1, deadline: null, ask: null, held: true, source: TERMINAL,
  }
}

/** A gated call of the terminal: `command` in a new shell, the `n`th of reply `reply`. */
function call(command: string, n = 0, reply = 1): GatedCall {
  return {
    callId: `${RUN}/chat#0/reply/${reply}/${n}`, node: "chat#0/reply", tool: "terminal_run", source: TERMINAL,
    arguments: { command, why: "as asked" }, scopes: [], attempt: 1,
  }
}

test("a restored terminal hold the terminal can't read keeps its card open for the owner, and one with no card is refused", async () => {
  const a = await approvals("auto")
  // No arguments recorded; a named shell that didn't survive the restart; no arguments and no card.
  const noArgs = a.card(held(0, null).callId, "ls")
  const gone = a.card(held(1, null).callId, "ls")
  a.chat.settleHolds(RUN, [held(0, null), held(1, { command: "ls", why: "x", shell: "shell 1" }), held(2, null)])
  await a.drain()
  for (const q of [noArgs, gone]) {
    expect(a.o.office.store.getQuestion(q.id)).toMatchObject({ status: "open", answer: null, answered_by: null })
  }
  expect(a.released).toEqual([])
  expect(a.completed).toEqual([
    { callId: held(2, null).callId, output: "Not run: the shell this command was for can't be read now; run it again." },
  ])
  for (const n of [0, 1, 2]) expect(a.perms.decided!(held(n, null).callId)).toBeNull()
})

test("a card approves its call only with its approver's Yes", async () => {
  const a = await approvals("ask")
  const nobody = a.card(`${RUN}/chat#0/reply/1/0`, "ls")
  a.o.office.store.answerQuestion(nobody.id, YES, "option", null)
  expect(a.perms.decided!(nobody.call_id!)).toBeNull()
  const owner = a.card(`${RUN}/chat#0/reply/1/1`, "ls")
  a.o.office.store.answerQuestion(owner.id, YES, "option", CEO)
  expect(a.perms.decided!(owner.call_id!)).toEqual({
    why: `approved by @${CEO}`, basis: { cwd: "/w" }, approved: true, tool: "terminal_run", text: "ls", partial: false,
    shell: null,
  })
})

test("what the gate let a call do is taken once, and gone once its job ends or its call closes", async () => {
  const a = await approvals("auto", { ls: planOf("ls") })
  expect(a.chat.gate(RUN, call("ls", 0))).toEqual({ run: true, note: "read-only" })
  expect(a.perms.decided!(call("ls", 0).callId)).toMatchObject({ why: "by read-only", text: "ls" })
  expect(a.perms.decided!(call("ls", 0).callId)).toBeNull()
  // A call that never started: its job ended, or yian closed it.
  a.chat.gate(RUN, call("ls", 1))
  a.chat.jobEnded(RUN)
  expect(a.perms.decided!(call("ls", 1).callId)).toBeNull()
  a.chat.gate(RUN, call("ls", 2))
  a.chat.closed(call("ls", 2).callId)
  expect(a.perms.decided!(call("ls", 2).callId)).toBeNull()
})

test("a No refuses the reply's later calls that would ask at once, while its answer is still on its way", async () => {
  const a = await approvals("ask", { make: planOf("make"), "make test": planOf("make test") })
  const first = a.card(call("make", 0).callId, "make")
  const stored = a.o.office.store.answerQuestion(first.id, "not now", "text", CEO)
  let later: unknown
  a.between.push(() => (later = a.chat.gate(RUN, call("make test", 1))))
  await a.chat.answered(stored)
  expect(later).toEqual({ refuse: "Not run: the user said no: not now" })
})
