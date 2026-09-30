import { afterEach, expect, test } from "bun:test"
import { createFakeOffice, type FakeOffice } from "../../script/stub"
import { BASE } from "../../src/office/http"
import { until } from "../fixture/until"

let office: FakeOffice
afterEach(() => office?.stop())

/** Opens `GET /events` and collects the raw text it streams. */
async function open(path = "/events") {
  const res = await fetch(BASE + path, { unix: office.socket })
  const decoder = new TextDecoder()
  const out = { text: "", ended: false }
  const reader = res.body!.getReader()
  void (async () => {
    try {
      for (let r = await reader.read(); !r.done; r = await reader.read())
        out.text += decoder.decode(r.value, { stream: true })
    } catch {
      // stop() at the end of a test closes the socket under the reader.
    }
    out.ended = true
  })()
  return out
}

test("emit reaches an open stream; ?session= filters by subject_id or data.session_id", async () => {
  office = createFakeOffice()
  const all = await open()
  const one = await open("/events?session=S1")
  await until(() => all.text.startsWith(": connected\n\n") && one.text.startsWith(": connected\n\n"))
  office.emit({ id: "E1", type: "session.updated", at: "t", subject_id: "S1", data: { id: "S1" } })
  office.emit({ id: "E2", type: "question.created", at: "t", subject_id: "Q1", data: { session_id: "S1" } })
  office.emit({ id: "E3", type: "session.updated", at: "t", subject_id: "S2", data: { id: "S2" } })
  office.live({ type: "part.delta", session_id: "S2", data: {} })
  await until(() => all.text.includes("event: live"))
  expect(all.text).toContain('event: meta\nid: E1\ndata: {"id":"E1"')
  expect(one.text).toContain("id: E1")
  expect(one.text).toContain("id: E2")
  expect(one.text).not.toContain("id: E3")
  expect(one.text).not.toContain("event: live")
})

test("reset writes event: reset and closes the stream", async () => {
  office = createFakeOffice()
  const s = await open()
  await until(() => office.streams() === 1)
  office.reset()
  await until(() => s.ended)
  expect(s.text).toEndWith("event: reset\ndata:\n\n")
  expect(office.streams()).toBe(0)
})

test("hold delays a route until release", async () => {
  office = createFakeOffice()
  const release = office.hold("GET /sessions/:id/messages")
  let done = false
  const res = fetch(`${BASE}/sessions/${office.state.sessions[0].id}/messages`, { unix: office.socket }).then(
    (r) => ((done = true), r),
  )
  await Bun.sleep(50)
  expect(done).toBe(false)
  release()
  expect((await res).status).toBe(200)
})
