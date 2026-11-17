import { afterEach, expect, test } from "bun:test"
import { createFakeOffice, type FakeOffice } from "../fixture/fake-office"
import { BASE } from "@opencorp/client"
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

test("an approval card has no side chat or send back, and its stop answers it interrupted, as the office's", async () => {
  office = createFakeOffice()
  const sid = office.state.sessions[0].id
  const post = (path: string, body?: unknown) =>
    fetch(BASE + path, {
      unix: office.socket,
      method: "POST",
      ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    })
  const q = office.addApproval(sid, {
    kind: "command",
    tool: "shell",
    action: "rm -rf build",
    reason: "Ask mode",
    rules: ["rm -rf build"],
  })
  expect([q.source, q.asker, q.title, q.question, q.options]).toEqual([
    "approval",
    "minh",
    "@minh wants to run a command",
    "rm -rf build",
    ["Yes", "Yes, and don't ask again this session for: rm -rf build"],
  ])
  expect(q.approval).toEqual({
    kind: "command", tool: "shell", action: "rm -rf build", args: {}, why: "", reason: "Ask mode",
    rules: ["rm -rf build"], partial: false, into: null,
  })
  const typed = office.addApproval(sid, { kind: "input", tool: "terminal_type", action: "y", reason: "" })
  expect([typed.title, typed.options, typed.call_id === q.call_id]).toEqual([
    "@minh wants to type into a running command",
    ["Yes"],
    false,
  ])
  // The action shows as the office shows it: escaped, and numbered when it has more than one line.
  expect(office.addApproval(sid, { kind: "command", tool: "shell", action: "ls\nrm \u202Ex", reason: "" }).question)
    .toBe("  1  ls\n  2  rm <U+202E>x")
  const refusals = [
    [`/questions/${q.id}/side`, { text: "why?" }],
    [`/questions/${q.id}/send-back`, { note: "" }],
  ] as const
  for (const [path, body] of refusals) {
    const r = await post(path, body)
    expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([422, "approval_card"])
  }
  const r = await post(`/questions/${q.id}/stop`)
  expect(r.status).toBe(200)
  expect(office.state.questions[q.id]).toMatchObject({ status: "answered", answer_kind: "interrupted" })
})

test("an added instrument is listed, prints by byte offset, takes the approver's keys and size, and goes", async () => {
  office = createFakeOffice()
  const sid = office.state.sessions[0].id
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(BASE + path, {
      unix: office.socket,
      method,
      ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    })
    return [r.status, await r.json()] as const
  }
  const events = await open(`/events?session=${sid}`)
  await until(() => events.text.startsWith(": connected\n\n"))
  const at = "2026-11-17T10:00:00.000Z"
  const shell = (id: string, interactive: boolean) =>
    office.addInstrument(sid, {
      id, session_id: sid, kind: "terminal", name: "shell 1", driver: "minh", profile: "ssh", interactive,
      size: interactive ? { cols: 80, rows: 24 } : null, status: "running", command: "ssh h", created_at: at,
      updated_at: at,
    })
  const pty = shell("01JA1H00000000000000000K01", true)
  const pipes = shell("01JA1H00000000000000000K02", false)
  office.instrumentOutput(sid, pty.id, "one\r\n")
  office.instrumentOutput(sid, pty.id, "two\r\n")
  expect(await call("GET", `/sessions/${sid}/instruments`)).toEqual([200, [pty, pipes]])
  expect(await call("GET", `/sessions/${sid}/instruments/${pty.id}/screen`)).toEqual([
    200,
    { offset: 0, end: 10, data: Buffer.from("one\r\ntwo\r\n").toString("base64") },
  ])
  await until(() => events.text.includes(`"offset":5`))
  expect(events.text).toContain(`"type":"instrument.updated","session_id":"${sid}"`)

  const pty1 = `/sessions/${sid}/instruments/${pty.id}`
  const pipes1 = `/sessions/${sid}/instruments/${pipes.id}`
  expect(await call("POST", `${pty1}/keys`, { data: "pw\r" })).toEqual([200, { ok: true }])
  expect((await call("POST", `${pipes1}/keys`, { data: "y" }))[0]).toBe(409)
  expect(await call("POST", `${pipes1}/keys`, { data: "\x03" })).toEqual([200, { ok: true }])
  expect(await call("POST", `${pty1}/size`, { cols: 100, rows: 30 })).toEqual([200, { ok: true }])
  expect(office.state.instruments[sid]![0]!.size).toEqual({ cols: 100, rows: 30 })
  // A chat someone else opened takes only their keys.
  office.updateSession(sid, { opened_by: "lan" })
  expect((await call("POST", `${pty1}/keys`, { data: "x" }))[1]).toMatchObject({ error: "forbidden" })

  office.removeInstrument(sid, pty.id)
  expect((await call("GET", `/sessions/${sid}/instruments`))[1]).toEqual([pipes])
  await until(() => events.text.includes(`"type":"instrument.removed"`))
})
