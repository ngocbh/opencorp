/** The notes of commands that ended: a command the agent was told runs on tells the session when it ends, as a message
 *  from `office`. A running reply reads it as a steer, a run at rest takes it as a new turn, notes that end together
 *  share one model call, Esc holds them for the next person's message, the cost cap holds them for a raise, a note is
 *  never sent twice and never answers the model's question, and nothing is left once the chat ends. */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { stringify } from "yaml"
import { OFFICE } from "@opencorp/protocol"
import type { SessionActor } from "../../../src/features/chat/session_actor.ts"
import type { ScriptedReply } from "../../../src/testing/fake_llm.ts"
import { waitFor } from "../../helpers.ts"
import {
  ASK_USER,
  capItem,
  card,
  type ChatOffice,
  chatOffice,
  fakeLlm,
  noWorkersLeft,
  session,
  startActor,
  status,
  texts,
} from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

/** A model turn that runs `command` in a new shell and waits `wait` seconds for it. */
function run(command: string, wait = 0): ScriptedReply {
  return { tool_calls: [{ name: "terminal_run", arguments: { command, why: "builds", wait } }] }
}

/** The first line of the note of `command` in `shell` ending with `exit`. */
const heading = (shell: string, command: string, exit: number) => `${shell}: \`${command}\` ended, exit ${exit}`

/** An office whose minh may run `make *`, each command running until `end` ends it or it is stopped. */
async function notesOffice(fake: Awaited<ReturnType<typeof fakeLlm>>) {
  const rules = stringify({ rules: [{ effect: "allow", kind: "command", pattern: "make *" }] })
  const o = await chatOffice(fake, { files: { "people/minh/rules.yaml": rules } })
  const ends = new Map<string, (result: { output?: string; exit: number | null }) => void>()
  o.pipes.run = (command, signal) =>
    new Promise((resolve) => {
      ends.set(command, resolve)
      const stop = () => {
        ends.delete(command)
        resolve({ exit: null })
      }
      signal.addEventListener("abort", stop, { once: true })
    })
  const end = (command: string, exit: number, output = "") => {
    const resolve = ends.get(command)
    if (resolve === undefined) throw new Error(`${command} isn't running`)
    ends.delete(command)
    resolve({ output, exit })
  }
  return { o, end }
}

/** The notes session `sid`'s transcript shows: its user messages from `office`, by their text. */
function notes(o: ChatOffice, sid: string): string[] {
  return o.transcript
    .messages(sid, session(o, sid).run_ids)
    .filter((message) => message.role === "user" && message.author === OFFICE)
    .flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
}

/** The log lines of the run `runId` of `o` that commit a message from `office` to an inbox: its notes. */
function loggedNotes(o: ChatOffice, runId: string): string[] {
  return fs
    .readFileSync(path.join(o.office.paths.runs, runId, "log.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.includes('"kind":"pool_commit"') && line.includes(`"author":"${OFFICE}"`))
}

/** Whether the model's request `n` (from 1) holds `text`. */
function asked(fake: Awaited<ReturnType<typeof fakeLlm>>, n: number, text: string): boolean {
  return JSON.stringify(fake.requests()[n - 1]?.messages ?? []).includes(JSON.stringify(text).slice(1, -1))
}

/** Starts minh's chat, has the agent start its commands and end its reply ("Started."), and waits for the session to
 *  rest. */
async function started(o: ChatOffice): Promise<{ actor: SessionActor; sid: string }> {
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  await waitFor(() => texts(o, sid).includes("Started.") && status(o, sid) === "idle", { what: "the first reply" })
  return { actor, sid }
}

test("a command that ends while the agent's reply runs reaches it as a steer before its next model call", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), run("make docs", 60), { match: heading("shell 1", "make all", 0), content: "Both built." })
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  // The reply waits on make docs when make all ends.
  await waitFor(() => o.pipes.commands.length === 2, { what: "both commands" })
  end("make all", 0, "built\n")
  await waitFor(() => loggedNotes(o, actor.runId!).length === 1, { what: "the note in the inbox" })
  end("make docs", 0)
  await waitFor(() => texts(o, sid).includes("Both built.") && status(o, sid) === "idle", { what: "the reply" })
  expect(fake.requests()).toHaveLength(3)
  expect(asked(fake, 3, heading("shell 1", "make all", 0))).toBe(true)
  // It shows as a note from the office, between the reply's calls and what the model said after reading it.
  const [note] = notes(o, sid)
  expect(note!.split("\n")[0]).toBe(heading("shell 1", "make all", 0))
  expect(note).toContain("built")
  const shown = o.transcript.messages(sid, session(o, sid).run_ids).map((m) => `${m.role}:${m.author ?? ""}`)
  expect(shown.slice(-3)).toEqual(["assistant:", `user:${OFFICE}`, "assistant:"])
  expect(session(o, sid).turns).toBe(1)
})

test("a command that ends while the agent rests starts a new turn with its note", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), { content: "Started." }, { match: heading("shell 1", "make all", 2), content: "It failed." })
  const { o, end } = await notesOffice(fake)
  const { sid } = await started(o)
  end("make all", 2, "error: no rule\n")
  await waitFor(() => texts(o, sid).includes("It failed.") && status(o, sid) === "idle", { what: "the woken reply" })
  expect(fake.requests()).toHaveLength(3)
  // The model reads it labelled as the office's.
  expect(asked(fake, 3, `author="${OFFICE}"`)).toBe(true)
  expect(notes(o, sid).map((note) => note.split("\n")[0])).toEqual([heading("shell 1", "make all", 2)])
  // The protocol carries it as a user message whose author is the office.
  const message = o.transcript.messages(sid, session(o, sid).run_ids).find((m) => m.author === OFFICE)
  expect(message).toMatchObject({ role: "user", author: OFFICE, parts: [{ type: "text" }] })
})

test("two commands that end together send two notes, which one model call reads", async () => {
  const fake = await fakeLlm()
  const both: ScriptedReply = {
    tool_calls: [
      { name: "terminal_run", arguments: { command: "make a", why: "builds", wait: 0 } },
      { name: "terminal_run", arguments: { command: "make b", why: "builds", wait: 0 } },
    ],
  }
  fake.script(both, { content: "Started." }, { content: "Both ended." })
  const { o, end } = await notesOffice(fake)
  const { sid } = await started(o)
  const before = o.jobs.length
  end("make a", 0)
  end("make b", 1)
  await waitFor(() => texts(o, sid).includes("Both ended.") && status(o, sid) === "idle", { what: "the woken reply" })
  // One job takes both to the run, and one turn reads them.
  expect(o.jobs.slice(before).map((job) => job.deliver.map((d) => d.op))).toEqual([["send", "send"]])
  expect(fake.requests()).toHaveLength(3)
  expect(asked(fake, 3, heading("shell 1", "make a", 0)) && asked(fake, 3, heading("shell 2", "make b", 1))).toBe(true)
  expect(notes(o, sid).map((note) => note.split("\n")[0]).sort()).toEqual([
    heading("shell 1", "make a", 0),
    heading("shell 2", "make b", 1),
  ])
})

test("after Esc a note waits for the owner's next message, and goes with it", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), { content: "never shown", hold: true }, { content: "It built, and here's why." })
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  await fake.waitForRequests(2, 30_000)
  await actor.interrupt()
  fake.release()
  await waitFor(() => !actor.hasWorker && status(o, sid) === "idle", { what: "the stopped turn" })
  end("make all", 0)
  await Bun.sleep(300)
  expect(fake.requests()).toHaveLength(2)
  expect(notes(o, sid)).toEqual([])
  await actor.prompt("what happened?")
  await waitFor(() => texts(o, sid).includes("It built, and here's why.") && status(o, sid) === "idle", {
    what: "the reply",
  })
  // One model call reads the note and the message.
  expect(fake.requests()).toHaveLength(3)
  expect(asked(fake, 3, heading("shell 1", "make all", 0)) && asked(fake, 3, "what happened?")).toBe(true)
  expect(notes(o, sid)).toHaveLength(1)
})

test("over the cost cap a note is held, opens no cap item, and the raise runs it", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), { content: "Started." }, { content: "It built." })
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await started(o)
  o.office.store.updateSession(sid, { cost: 6 })
  const before = o.jobs.length
  end("make all", 0)
  await waitFor(() => o.jobs.length > before && !actor.hasWorker, { what: "the delivering job" })
  expect(o.jobs.slice(before)).toMatchObject([{ kind: "advance", advance: false, deliver: [{ op: "send" }] }])
  await Bun.sleep(200)
  expect(fake.requests()).toHaveLength(2)
  expect(capItem(o)).toBeUndefined()
  await actor.setCostCap(20)
  await waitFor(() => texts(o, sid).includes("It built.") && status(o, sid) === "idle", { what: "the reply" })
  expect(asked(fake, 3, heading("shell 1", "make all", 0))).toBe(true)
})

test("a note sent again, or a run resumed after a crash, never doubles it", async () => {
  const fake = await fakeLlm()
  fake.script(
    run("make all"),
    { content: "Started." },
    { content: "lost", hold: true },
    { content: "It built." },
  )
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await started(o)
  end("make all", 0)
  await fake.waitForRequests(3, 30_000)
  const runId = actor.runId!
  // The same note again, under its key, as a host sending it twice would: the run already has it.
  const [note] = notes(o, sid)
  const [shellId] = fs.readdirSync(path.join(o.office.paths.sessionDir(sid), "terminal"))
  actor.note(note!, `terminal:${shellId}:1`)
  actor.note(note!, `terminal:${shellId}:1`)
  await Bun.sleep(300)
  // The worker dies in the woken turn's model call: the run resumes, and reads its note once.
  o.registry.get(sid)!.kill()
  await waitFor(() => texts(o, sid).includes("It built.") && status(o, sid) === "idle", { what: "the resumed reply" })
  fake.release()
  expect(actor.runId).toBe(runId)
  expect(fake.requests()).toHaveLength(4)
  expect(loggedNotes(o, runId)).toHaveLength(1)
  expect(notes(o, sid)).toEqual([note])
  expect(JSON.stringify(fake.requests()[3]!.messages).split(heading("shell 1", "make all", 0))).toHaveLength(2)
})

test("a note never answers the model's open question: it waits in the inbox, and the answer's call reads it", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), ASK_USER, { content: "A it is." })
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  const q = await card(o, sid, "ask_user")
  await waitFor(() => !actor.hasWorker, { what: "the run asleep on the question" })
  end("make all", 0)
  await waitFor(() => loggedNotes(o, actor.runId!).length === 1, { what: "the note in the inbox" })
  await waitFor(() => !actor.hasWorker, { what: "the delivering worker's exit" })
  expect(o.office.store.getQuestion(q.id)!.status).toBe("open")
  expect(fake.requests()).toHaveLength(2)
  expect(await actor.prompt("A")).toBe("answer")
  await waitFor(() => texts(o, sid).includes("A it is.") && status(o, sid) === "idle", { what: "the reply" })
  expect(fake.requests()).toHaveLength(3)
  expect(asked(fake, 3, heading("shell 1", "make all", 0))).toBe(true)
  expect(o.office.store.getQuestion(q.id)!.status).toBe("consumed")
})

test("a chat that ends before a note is delivered leaves nothing behind", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), { content: "Started." })
  const { o, end } = await notesOffice(fake)
  // A note held after Esc goes with the chat's end.
  const { actor, sid } = await started(o)
  await actor.interrupt()
  end("make all", 0)
  await Bun.sleep(200)
  await actor.end()
  await waitFor(() => session(o, sid).status === "ended", { what: "the chat's end" })
  expect(notes(o, sid)).toEqual([])
  expect(fake.requests()).toHaveLength(2)
  // A command still running when the chat ends is stopped, and nobody is told.
  const again = await fakeLlm()
  again.script(run("make more"), { content: "Started." })
  const second = await notesOffice(again)
  const other = await started(second.o)
  await other.actor.end()
  await waitFor(() => session(second.o, other.sid).status === "ended", { what: "the second chat's end" })
  expect(() => second.end("make more", 0)).toThrow("isn't running")
  await Bun.sleep(200)
  expect(notes(second.o, other.sid)).toEqual([])
  expect(loggedNotes(second.o, other.actor.runId!)).toEqual([])
})
