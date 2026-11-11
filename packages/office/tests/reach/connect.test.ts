/** Connecting to HQ's machine: the remote check, the master, the forward and the health through it, and sign-in. */
import { expect, setDefaultTimeout, test } from "bun:test"
import type { HqStatus } from "@opencorp/protocol"
import { classifyCheck, type FailureKind, ReachFailure } from "../../src/reach/connect.ts"
import type { Ran } from "../../src/reach/ssh.ts"

setDefaultTimeout(30_000)

const ran = (over: Partial<Ran>): Ran => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...over })
const HEALTH = { ok: true as const, office: { api: "1" }, app: { build: "b", api: "1" } }
const STATUS: HqStatus = {
  socket: "/h/o/office/hq.sock",
  tcp: { enabled: false, port: 49380, listening: false, error: null, next_retry_at: null },
  url: null,
  health: HEALTH,
  socket_error: null,
  warnings: [],
}
const json = (over: Record<string, unknown> = {}) => JSON.stringify({ ...STATUS, ...over })

const ROWS: [string, Ran, FailureKind, string][] = [
  ["out of time", ran({ code: 143, timedOut: true }), "unreachable", "`opencorp hq --check` there didn't answer within 60 s"],
  ["255", ran({ code: 255, stderr: "Control socket connect(x): No such file\n" }), "unreachable", "Control socket connect(x): No such file"],
  ["3", ran({ code: 3, stderr: "The office isn't running\n" }), "no_office", "The office isn't running"],
  ["127", ran({ code: 127 }), "broken", "no opencorp at the saved path, or no bun for it (exit 127; see env.OPENCORP_BUN)"],
  ["2, an opencorp without --check", ran({ code: 2 }), "not_ready", "`opencorp` there has no `hq --check`; update that checkout"],
  ["1", ran({ code: 1, stderr: "opencorp hq: this office has no HQ yet\n" }), "not_ready", "opencorp hq: this office has no HQ yet"],
  ["5", ran({ code: 5 }), "broken", "`opencorp hq --check` exited 5"],
  ["0 with no JSON", ran({ stdout: "hello\n" }), "broken", "`opencorp hq --check --json` there printed no status JSON"],
  ["a socket path that can't be forwarded", ran({ stdout: json({ socket: "/h/o:x/hq.sock" }) }), "broken", "HQ's socket path there can't be forwarded as is"],
  ["a socket that isn't hq.sock", ran({ stdout: json({ socket: "/h/o/office.sock" }) }), "broken", "HQ's socket path there can't be forwarded as is"],
  ["hq.sock not listening", ran({ stdout: json({ socket_error: "ENOENT\x1b[2J" }) }), "not_ready", "hq.sock isn't listening (ENOENT[2J)"],
  ["the app not built", ran({ stdout: json({ health: { ...HEALTH, app: null } }) }), "not_ready", "HQ's web app isn't built"],
]

test.each(ROWS)("the remote check is classified [%s]", (_label, r, kind, message) => {
  let thrown: unknown
  try {
    classifyCheck(r)
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(ReachFailure)
  expect((thrown as ReachFailure).kind).toBe(kind)
  expect((thrown as ReachFailure).message).toBe(message)
})

test("the remote check is classified [a good status after a .bashrc banner]", () => {
  expect(classifyCheck(ran({ stdout: `Welcome to node1\n${json()}\n` }))).toEqual(STATUS)
})
