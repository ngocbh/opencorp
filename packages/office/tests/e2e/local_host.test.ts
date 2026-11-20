/** The TUI's client against the no-office host: it reads the session, its messages and its live events over the
 *  host's private socket and token, as it reads an office; the routes the host doesn't serve are the office's 404. */
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { createOfficeClient, type StreamEvent, subscribe } from "@opencorp/client"
import { Ack, Instrument, Message, Person, Question, RuleList, Session } from "@opencorp/protocol"
import { serveLocal } from "../../src/server/local/serve.ts"
import { fakeLlm } from "../features/chat/helpers.ts"
import { shortDir, waitFor } from "../helpers.ts"
import { AGENT, startHost, until } from "../server/local/helpers.ts"

setDefaultTimeout(90_000)

test("the TUI's client reads the session, its messages and live events from the local host as from an office", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello from OpenCorp.", match: AGENT })
  const { host } = await startHost(fake)
  await until(host, "idle")
  const served = await serveLocal(host, { tmpdir: shortDir() })
  onTestFinished(() => served.close())
  const client = createOfficeClient({ socket: served.socket, token: served.token })
  const id = host.id

  const events: StreamEvent[] = []
  const sub = subscribe(served.socket, (e) => events.push(e), { session: id, token: served.token })
  onTestFinished(() => sub.close())
  await waitFor(() => events.some((e) => e.type === "connected"), { what: "the stream" })

  expect(await client.whoami()).toEqual({ person: "owner", device: null })
  const people = await client.people.list()
  expect(people.map((p) => Person.parse(p).handle)).toEqual(["opencorp"])
  expect((await client.people.inFolder("/tmp/proj")).map((p) => p.handle)).toEqual(["opencorp"])
  expect(Session.array().parse(await client.sessions.list({ limit: 1 })).map((s) => s.id)).toEqual([id])
  const session = Session.parse(await client.sessions.get(id))
  expect([session.status, session.opened_by, session.mode]).toEqual(["idle", "owner", "auto"])

  expect(Ack.parse(await client.sessions.prompt(id, { text: "Hi, who are you?" }))).toEqual({ ok: true })
  await waitFor(async () => (await client.sessions.get(id)).status === "idle" && (await client.sessions.messages(id)).length === 2, {
    what: "the reply",
  })
  const messages = Message.array().parse(await client.sessions.messages(id))
  expect(messages.map((m) => [m.role, m.author, m.parts.map((p) => (p.type === "text" ? p.text : p.type))])).toEqual([
    ["user", "owner", ["Hi, who are you?"]],
    ["assistant", null, ["Hello from OpenCorp."]],
  ])
  await waitFor(() => events.some((e) => e.type === "live" && e.event.type === "message.updated" && e.event.data.role === "assistant"), {
    what: "the reply's live event",
  })
  expect(events.some((e) => e.type === "meta" && e.event.type === "session.updated")).toBe(true)

  expect(Instrument.array().parse(await client.sessions.instruments(id))).toEqual([])
  expect(Question.array().parse(await client.questions.list({ session: id, status: "open" }))).toEqual([])
  expect(RuleList.parse(await client.sessions.rules(id))).toEqual({ rules: [], errors: [] })
  expect(Session.parse(await client.sessions.setMode(id, { mode: "dontAsk" })).mode).toBe("dontAsk")
  await expect(client.sessions.setMode(id, { mode: "yolo" as "auto" })).rejects.toMatchObject({ status: 422 })
  await expect(client.connections.list()).rejects.toMatchObject({ status: 404, code: "no_route" })

  expect(Ack.parse(await client.sessions.end(id))).toEqual({ ok: true })
  await host.ended
  expect((await client.sessions.get(id)).status).toBe("ended")
})
