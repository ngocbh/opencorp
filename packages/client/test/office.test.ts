// The socket client against a real office on a temp home: each answer parses with its route's protocol schema. One
// office for the file; each test makes its own folders, so no test depends on another's order. The company reads are
// HQ's alone, and the run reads answer 501 on the socket until the run views land, so neither is covered here.
import { afterAll, beforeAll, expect, test } from "bun:test"
import {
  Ack,
  BrowserSession,
  ConnectionList,
  CostReport,
  HqStatus,
  Message,
  ModelList,
  Person,
  Profile,
  Question,
  Session,
} from "@opencorp/protocol"
import { startOffice, type TestOffice } from "@opencorp/office/testing/office"
import fs from "node:fs"
import path from "node:path"
import { createOfficeClient } from "../src/client"
import { OfficeError } from "../src/errors"

let office: TestOffice
beforeAll(async () => {
  office = await startOffice()
}, 60_000)
afterAll(() => office?.stop())

const client = () => createOfficeClient({ socket: office.socket })

/** A new folder `name` under the office's temp root, as its real path. */
function folder(name: string): string {
  const dir = path.join(office.root, name)
  fs.mkdirSync(dir)
  return fs.realpathSync(dir)
}

/** Polls `done` every 100 ms until it is true; fails after 20 s. */
async function until(done: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** Waits until session `id` is `status`. */
const reach = (id: string, status: Session["status"]) =>
  until(async () => Session.parse(await client().sessions.get(id)).status === status)

test("who the office takes the client to be, its health, the people and the people in a folder", async () => {
  expect(await client().whoami()).toEqual({ person: "ngocbh", device: null })
  expect(Ack.parse(await client().health())).toEqual({ ok: true })
  const people = Person.array().parse(await client().people.list())
  expect(people.map((p) => p.handle)).toEqual(expect.arrayContaining(["minh", "ngocbh"]))
  const cwd = folder("people")
  expect(Person.array().parse(await client().people.inFolder(cwd))).toEqual([])
  Session.parse(await client().sessions.create({ person: "minh", cwd }))
  expect(Person.array().parse(await client().people.inFolder(cwd)).map((p) => p.handle)).toEqual(["minh"])
}, 30_000)

test("a session starts, answers a prompt, is listed and ends", async () => {
  const cwd = folder("session")
  const created = Session.parse(await client().sessions.create({ person: "minh", cwd }))
  expect([created.person, created.kind, created.status]).toEqual(["minh", "main", "starting"])
  await reach(created.id, "idle")
  expect(Session.parse(await client().sessions.get(created.id)).cwd).toBe(cwd)
  expect(Session.array().parse(await client().sessions.list({ cwd })).map((s) => s.id)).toEqual([created.id])

  const text = "Say hello to the client test"
  office.llm.script({ match: text, content: "Hello from minh." })
  expect(Ack.parse(await client().sessions.prompt(created.id, { text }))).toEqual({ ok: true })
  await until(async () => (await client().sessions.messages(created.id)).length === 2)
  await reach(created.id, "idle")
  const messages = Message.array().parse(await client().sessions.messages(created.id))
  expect(messages.map((m) => [m.role, m.parts.map((p) => (p.type === "text" ? p.text : p.type))])).toEqual([
    ["user", [text]],
    ["assistant", ["Hello from minh."]],
  ])

  expect(Ack.parse(await client().sessions.end(created.id))).toEqual({ ok: true })
  await reach(created.id, "ended")
}, 30_000)

test("questions, a profile and the connections with their models", async () => {
  const s = Session.parse(await client().sessions.create({ person: "minh", cwd: folder("questions") }))
  expect(Question.array().parse(await client().questions.list({ session: s.id }))).toEqual([])
  expect(Profile.parse(await client().profiles.get("minh")).person).toBe("minh")
  const list = ConnectionList.parse(await client().connections.list())
  expect([list.connections.map((c) => c.name), list.default]).toEqual([["office"], "office"])
  const models = ModelList.parse(await client().connections.models("office"))
  expect([models.connection, models.models.map((m) => m.id)]).toEqual(["office", ["stub"]])
}, 30_000)

test("HQ status, browser sessions and costs", async () => {
  const status = HqStatus.parse(await client().hq.status())
  expect([status.socket, status.tcp.enabled]).toEqual([office.hqSocket, false])
  expect(BrowserSession.array().parse(await client().hq.browsers())).toEqual([])
  const since = "2000-01-01T00:00:00.000Z"
  expect(CostReport.parse(await client().costs.since(since)).since).toBe(since)
})

test("an unknown session is a 404 OfficeError with the office code not_found", async () => {
  const err = await client().sessions.get("NOPE").then(
    () => {
      throw new Error("expected the request to fail")
    },
    (e) => e,
  )
  expect(err).toBeInstanceOf(OfficeError)
  expect([err.status, err.code]).toEqual([404, "not_found"])
})
