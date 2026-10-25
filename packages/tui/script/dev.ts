// Runs the TUI in this terminal: `bun run dev` against a seeded fake office that streams a
// scripted reply to each prompt; `bun run dev --office` against the office at the default
// socket, or `--socket PATH` against the one at PATH (both in the current folder).
import type { Message } from "@opencorp/protocol"
import { Effect } from "effect"
import { parseArgs } from "node:util"
import { run } from "../src/app"
import { Global } from "../src/core/global"
import { readIdentity, defaultSocket, identityPath } from "@opencorp/client/node"
import { createFakeOffice, type FakeOffice } from "./stub"

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

/**
 * Answers every prompt with REPLY, streamed a word at a time, then opens the session's next turn.
 * Esc stops the reply and opens the next turn at once.
 */
function scriptReplies(office: FakeOffice) {
  // The running reply per session; an interrupt or a newer reply ends it.
  const replies = new Map<string, object>()
  office.onInterrupt((sessionId) => {
    if (!replies.delete(sessionId)) return
    office.openTurn(sessionId)
  })
  office.onPrompt(async (sessionId) => {
    const reply = {}
    replies.set(sessionId, reply)
    const messageId = office.nextId()
    const partId = office.nextId()
    const message: Message = {
      id: messageId,
      session_id: sessionId,
      role: "assistant",
      parts: [{ id: partId, type: "text", text: "" }],
      created_at: new Date().toISOString(),
    }
    office.state.messages[sessionId] = [...(office.state.messages[sessionId] ?? []), message]
    office.live({ type: "message.updated", session_id: sessionId, data: structuredClone(message) as never })
    for (const word of REPLY.split(/(?= )/)) {
      await Bun.sleep(2000 / REPLY.split(" ").length)
      if (replies.get(sessionId) !== reply) return
      const part = message.parts[0] as { text: string }
      part.text += word
      office.live({
        type: "part.delta",
        session_id: sessionId,
        data: { message_id: messageId, part_id: partId, text: word },
      })
    }
    replies.delete(sessionId)
    office.openTurn(sessionId)
  })
}

const real = values.socket ?? (values.office ? defaultSocket() : undefined)
const fake = real ? undefined : createFakeOffice()
if (fake) scriptReplies(fake)
// The fake's seeded sessions and people are in /tmp/proj.
const cwd = fake ? "/tmp/proj" : process.cwd()
const socket = real ?? fake!.socket

try {
  await Effect.runPromise(
    run({
      socket,
      // A real office may need this device's token; the fake takes none.
      token: real ? readIdentity(identityPath())?.token : undefined,
      cwd,
      args: { sessionID: values.session, continue: values.continue, person: values.person },
    }).pipe(Effect.provide(Global.layer)),
  )
} finally {
  fake?.stop()
}
