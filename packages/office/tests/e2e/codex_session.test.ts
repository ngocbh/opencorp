/** The phase 3 milestone (design §11) end to end: `opencorp init` through the checkout wrapper starts a TS office
 *  in the background, and requests over its socket run a Codex session on `fake_codex.ts`, put first on `PATH` as
 *  `codex`: a streamed part, an approval card answered, the turn's end and the session's. It joins the cut-over
 *  gate (§10.4). Nothing touches the owner's home, a real Codex or a real service manager. */
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import type { LiveEvent, Message, Question, Session } from "@opencorp/protocol"
import { expect, onTestFinished, test } from "bun:test"
import { parse, stringify } from "yaml"
import * as fc from "../../src/testing/fake_codex.ts"
import { git } from "../company/helpers.ts"
import { frames } from "../daemon/helpers.ts"
import { waitFor } from "../helpers.ts"
import { type RunningOffice, folder, openOffice } from "./helpers.ts"

test(
  "a codex session on a wrapper started office streams a part takes a card answer and ends",
  async () => {
    let events: http.ClientRequest | undefined
    // Registered before openOffice's hook, so the stream is cut before the office stops.
    onTestFinished(() => events?.destroy())
    const office = await openOffice({
      codexScript: {
        turns: [
          [
            ...fc.agentMessage("m1", "I'll create hello.txt."),
            fc.commandStarted("c1", "touch hello.txt"),
            fc.commandApproval(1, "c1", "touch hello.txt"),
            fc.command("c1", "touch hello.txt")[1],
            ...fc.agentMessage("m2", "Done."),
          ],
        ],
      },
    })
    const { root } = office
    const socket = office.paths.socket
    const rpcLog = path.join(root, "codex", "rpc.jsonl")
    const calls = path.join(root, "calls.log")

    minhUsesCodex(office)

    // The folder holding the pinned codex's folder is refused as a workspace.
    const refused = await office.request("POST", "/sessions", {
      body: { person: "minh", cwd: path.join(root, "tools"), harness: "codex" },
    })
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([422, "unsafe_workspace"])

    const cwd = folder(path.join(root, "project"))
    const created: Session = await office.post("/sessions", { person: "minh", cwd, harness: "codex" })
    expect(created.harness).toBe("codex")
    const sid = created.id
    /** Whether the session's status is `want`; throws once the session has failed. */
    const statusIs = async (want: string) => {
      const session: Session = await office.get(`/sessions/${sid}`)
      if (session.status === "failed") throw new Error(`the Codex session failed: ${JSON.stringify(session)}`)
      return session.status === want
    }
    await waitFor(() => statusIs("idle"), { timeout: 60_000, what: "the Codex session to load" })

    let connected = false
    let streamError: unknown
    const live: LiveEvent[] = []
    /** Whether `check()` holds; throws the event stream's error once it has one. */
    const streamed = (check: () => boolean) => {
      if (streamError !== undefined) throw streamError
      return check()
    }
    events = http.request({ socketPath: socket, path: `/events?session=${sid}`, agent: false }, (res) => {
      // The cleanup's destroy cuts the stream, which then errors with nobody reading it.
      res.on("error", () => {})
      void (async () => {
        for await (const [kind, , data] of frames(res)) {
          if (kind === "comment" && data === "connected") connected = true
          else if (kind === "live") live.push(data as LiveEvent)
        }
      })().catch((error) => (streamError = error))
    })
    events.on("error", () => {})
    events.end()
    await waitFor(() => streamed(() => connected), { what: "the event stream" })

    expect(await office.post(`/sessions/${sid}/prompt`, { text: "Create hello.txt" })).toEqual({ ok: true })
    await waitFor(
      () => streamed(() => live.some((e) => ["part.updated", "part.delta"].includes(e.type) && e.session_id === sid)),
      { what: "a streamed part" },
    )

    const card: Question = await waitFor(
      async () => ((await office.get("/questions", { session: sid, status: "open" })) as Question[])[0],
      { what: "the approval card" },
    )
    expect(card.source).toBe("harness")
    expect(card.options).toContain("Approve")
    const answer = { answer: "Approve", answer_kind: "option" }
    const answered: Question = await office.post(`/questions/${card.id}/answer`, answer)
    expect(answered.status).toBe("consumed")

    await waitFor(() => statusIs("idle"), { what: "the turn to end" })
    const entries = () =>
      fs
        .readFileSync(rpcLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { dir: string; msg: Record<string, any> })
    await waitFor(() => entries().some((e) => e.dir === "out" && e.msg.method === "turn/completed"), {
      what: "the fake to complete the turn",
    })
    const read = entries()
    expect(read.some((e) => e.dir === "in" && e.msg.method === "thread/start")).toBe(true)
    const replies = read.filter((e) => e.dir === "in" && e.msg.id === 1 && !("method" in e.msg))
    expect(replies.map((e) => e.msg.result)).toEqual([{ decision: "accept" }])

    expect(await office.post(`/sessions/${sid}/end`)).toEqual({ ok: true })
    await waitFor(() => statusIs("ended"), { what: "the session to end" })
    expect(await office.get(`/sessions/${sid}/messages`)).toEqual([])
    expect(fs.existsSync(calls)).toBe(false)
  },
  180_000,
)

/** Gives Minh the Codex harness, committed since the office loads a person from the company's HEAD. */
function minhUsesCodex(office: RunningOffice): void {
  const company = office.paths.company
  const personFile = path.join(company, "people", "minh", "person.yaml")
  const minh = parse(fs.readFileSync(personFile, "utf8")) as Record<string, unknown>
  minh.harnesses = ["composer", "codex"]
  fs.writeFileSync(personFile, stringify(minh))
  git(company, "commit", "-qam", "minh uses codex")
}

/** Starts a Codex session for Minh whose turn opens a turnless sign-in card and keeps running, waits until it is
 *  waiting, brings the office back with `restart`, and checks the restored session marks the cut-off turn. */
async function turnCutOffBy(restart: (office: RunningOffice, cwd: string) => Promise<void>): Promise<void> {
  const office = await openOffice({
    codexScript: {
      turns: [[fc.urlElicitation(8, "gh", "Sign in", "https://e.com/l", { wait: false }), { sleep: 30 }]],
    },
  })
  minhUsesCodex(office)
  const cwd = folder(path.join(office.root, "project"))
  const sid = ((await office.post("/sessions", { person: "minh", cwd, harness: "codex" })) as Session).id
  const statusIs = async (want: string) => {
    const session: Session = await office.get(`/sessions/${sid}`)
    if (session.status === "failed") throw new Error(`the Codex session failed: ${JSON.stringify(session)}`)
    return session.status === want
  }
  await waitFor(() => statusIs("idle"), { timeout: 60_000, what: "the Codex session to load" })
  expect(await office.post(`/sessions/${sid}/prompt`, { text: "Sign in" })).toEqual({ ok: true })
  await waitFor(() => statusIs("waiting"), { timeout: 60_000, what: "the sign-in card" })
  expect(((await office.get(`/sessions/${sid}`)) as Session).harness_turn_id).not.toBeNull()

  await restart(office, cwd)
  await waitFor(() => statusIs("idle"), { timeout: 60_000, what: "the restored session" })
  const restored: Session = await office.get(`/sessions/${sid}`)
  expect(restored.harness_turn_id).toBeNull()
  const parts = ((await office.get(`/sessions/${sid}/messages`)) as Message[]).flatMap((m) => m.parts)
  const last = parts.at(-1)
  expect(last?.type === "text" && last.text.endsWith("[interrupted]")).toBe(true)
  const cards: Question[] = await office.get("/questions", { session: sid })
  expect(cards.map((q) => q.status)).toEqual(["stale"])
}

test(
  "a turn a restart cuts off while a turnless card waits comes back interrupted",
  () => turnCutOffBy(async (office, cwd) => void (await office.opencorp(["restart"], { cwd }))),
  180_000,
)

test(
  "a turn an office crash cuts off while a turnless card waits comes back interrupted",
  () =>
    turnCutOffBy(async (office, cwd) => {
      await office.killOffice()
      await office.opencorp(["start"], { cwd })
    }),
  180_000,
)
