import { afterEach, expect, test } from "bun:test"
import { createFakeOffice, type FakeOffice } from "../../script/stub"
import { BASE } from "@opencorp/client"
import { until } from "../fixture/until"

let office: FakeOffice
afterEach(() => office?.stop())

/** Sends `body` to the fake office as a client would. */
const post = (path: string, body?: unknown) =>
  fetch(BASE + path, {
    unix: office.socket,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

test("a codex session opens no turn questions and takes messages as Codex turns", async () => {
  office = createFakeOffice()
  const s = office.newSession({ person: "minh", cwd: "/tmp/proj", harness: "codex" })
  expect(Object.values(office.state.questions).filter((q) => q.session_id === s.id)).toEqual([])
  expect((await post(`/sessions/${s.id}/prompt`, { text: "make a" })).status).toBe(200)
  await until(() => office.state.sessions.find((x) => x.id === s.id)!.status === "busy")
  expect(office.state.messages[s.id].at(-1)!).toMatchObject({ author: "ngocbh", parts: [{ type: "text", text: "make a" }] })
})

test("POST /sessions opens a Codex session only for a person who uses Codex", async () => {
  office = createFakeOffice()
  const refused = await post("/sessions", { person: "minh", cwd: "/tmp/proj", harness: "codex" })
  expect([refused.status, (await refused.json()).error]).toEqual([422, "unsupported_harness"])
  office.state.people = office.state.people.map((p) =>
    p.handle === "minh" ? { ...p, harnesses: ["composer", "codex"] } : p,
  )
  const s = await (await post("/sessions", { person: "minh", cwd: "/tmp/proj", harness: "codex" })).json()
  await until(() => office.state.sessions.find((x) => x.id === s.id)!.status === "idle")
  expect(Object.values(office.state.questions).filter((q) => q.session_id === s.id)).toEqual([])
})

test("a Codex question card takes one answer per page header", async () => {
  office = createFakeOffice()
  const s = office.newSession({ person: "minh", cwd: "/tmp/proj", harness: "codex", status: "busy" })
  const q = office.addQuestion({
    session_id: s.id,
    source: "harness",
    node_id: "3",
    question: "Token?",
    questions: [{ question: "Token?", header: "Token", options: [], secret: true }],
  })
  const bad = await post(`/questions/${q.id}/answer`, { answer: "x", answer_kind: "text" })
  expect(bad.status).toBe(422)
  const ok = await post(`/questions/${q.id}/answer`, { answer: { Token: "x" }, answer_kind: "text" })
  expect(ok.status).toBe(200)
})

test("POST /sessions refuses a harness the person doesn't use before recording the folder", async () => {
  office = createFakeOffice()
  office.state.people = office.state.people.map((p) => (p.handle === "minh" ? { ...p, harnesses: ["codex"] } : p))
  for (const harness of [undefined, "composer", "claude"]) {
    const res = await post("/sessions", { person: "minh", cwd: "/tmp/elsewhere", harness })
    expect([res.status, (await res.json()).error]).toEqual([422, "unsupported_harness"])
  }
  expect(office.state.folders["/tmp/elsewhere"]).toBeUndefined()
  expect((await post("/sessions", { person: "minh", cwd: "/tmp/elsewhere", harness: "codex" })).status).toBe(200)
  expect(office.state.folders["/tmp/elsewhere"]).toEqual(["minh"])
})
