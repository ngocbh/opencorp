// Upstream's activity anchor tests: a toggled group's line keeps its screen row while what it holds opens or closes
// below it, unless it ends the transcript and the reader follows the bottom. And a group closed while the reader is
// scrolled up keeps its row too, though the older messages it frees mount above it.
import type { Message, Part, ToolPart } from "@opencorp/protocol"
import { TestRecorder } from "@opentui/core/testing"
import { afterAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test"
import { createFakeOffice, createStub } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"
import { writeKV } from "../../fixture/kv"
import { until } from "../../fixture/until"

type App = Awaited<ReturnType<typeof bootFrame>>

setDefaultTimeout(30_000)

const AT = "2026-11-23T10:00:00.000Z"
const VERBOSITY = "session_verbosity"

beforeEach(() => writeKV({ [VERBOSITY]: undefined }))
afterAll(() => writeKV({ [VERBOSITY]: undefined }))

const pad = (n: number) => String(n).padStart(3, "0")
const user = (sessionID: string, t: number, text: string): Message => ({
  id: `turn-${pad(t)}-1`,
  session_id: sessionID,
  role: "user",
  created_at: AT,
  parts: [{ id: `u${t}`, type: "text", text }],
})
const reply = (sessionID: string, t: number, parts: Part[]): Message => ({
  id: `turn-${pad(t)}-2`,
  session_id: sessionID,
  role: "assistant",
  created_at: AT,
  parts,
})
const call = (id: string, tool: string, input: Record<string, unknown>): ToolPart => ({
  id,
  type: "tool",
  call_id: `call_${id}`,
  tool,
  state: "completed",
  input,
})
const text = (id: string, value: string): Part => ({ id, type: "text", text: value })

// Turn N runs N + 2 commands, so every Low summary label is unique.
const turns = (sessionID: string) =>
  Array.from({ length: 6 }, (_, turn) => [
    user(sessionID, turn, `Turn ${turn} prompt`),
    reply(sessionID, turn, [
      ...Array.from({ length: turn + 2 }, (_, index) =>
        call(`shell-${turn}-${index}`, "workspace_shell", { command: `echo turn ${turn} step ${index}` }),
      ),
      text(`a${turn}`, `Turn ${turn} answer`),
    ]),
  ]).flat()
// A turn still running its commands, so its summary ends the transcript.
const running = (sessionID: string) => [
  user(sessionID, 6, "Running prompt"),
  reply(sessionID, 6, [call("shell-running-0", "workspace_shell", { command: "echo running step 0" })]),
]

/** Boots a session on `messages`, once it shows `shows` and its read has settled. */
async function withSession(
  messages: (sessionID: string) => Message[],
  shows: string,
  run: (app: App) => Promise<void>,
) {
  const office = createFakeOffice()
  const s = office.state.sessions[0]!
  office.state.messages[s.id] = messages(s.id)
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes(shows))
    await until(() => office.requests.some((r) => r.path === `/sessions/${s.id}/messages`))
    await Bun.sleep(100)
    await app.until((f) => f.includes(shows))
    await run(app)
  } finally {
    await app.stop()
    office.stop()
  }
}

const lines = (frame: string) => frame.split("\n")
const rowOf = (frame: string, label: string) => lines(frame).findIndex((line) => line.includes(label))

/** Renders a few frames, as the renderer's own loop would while the screen settles. */
async function settle(app: App) {
  for (let frame = 0; frame < 5; frame++) {
    await app.setup.renderOnce()
    await Bun.sleep(20)
  }
}

/** Clicks the group's line and returns its row in every frame rendered afterwards. */
async function toggle(app: App, label: string) {
  const row = rowOf(app.frame(), label)
  expect(row).toBeGreaterThan(0)
  // Stay outside OpenTUI's 500ms multi-click window so a second toggle is not a word selection.
  await Bun.sleep(550)
  const recorder = new TestRecorder(app.setup.renderer)
  recorder.rec()
  await app.setup.mockMouse.click(8, row)
  await settle(app)
  recorder.stop()
  expect(recorder.recordedFrames.length).toBeGreaterThan(0)
  return { row, frames: [...new Set(recorder.recordedFrames.map((frame) => rowOf(frame.frame, label)))] }
}

test.each([0, 1, 3])(
  "low activity details open below a summary that keeps its row, %i wheel steps from the bottom",
  async (steps) => {
    await withSession(turns, "Turn 5 answer", async (app) => {
      for (let step = 0; step < steps; step++) await app.setup.mockMouse.scroll(30, 10, "up")
      await settle(app)
      const commands = [7, 6, 5, 4].find((count) => {
        const row = rowOf(app.frame(), `${count} commands`)
        return row > 4 && row < 18
      })
      expect(commands).toBeDefined()
      const label = `${commands} commands`
      const turn = commands! - 2

      const expand = await toggle(app, label)
      expect(expand.frames).toEqual([expand.row])
      const expanded = lines(app.frame())
      expect(expanded[expand.row]).toContain(`− ${label}`)
      expect(expanded.slice(expand.row + 1).join("\n")).toContain(`echo turn ${turn} step 0`)
      expect(expanded.slice(0, expand.row).join("\n")).not.toContain(`echo turn ${turn} step`)

      const collapse = await toggle(app, label)
      expect(collapse.frames).toEqual([expand.row])
      expect(lines(app.frame())[expand.row]).toContain(`+ ${label}`)
    })
  },
)

test("a low activity summary that ends the transcript opens as the bottom follows it", async () => {
  await withSession(
    (id) => [...turns(id), ...running(id)],
    "1 command",
    async (app) => {
      const label = "1 command"
      const expand = await toggle(app, label)
      const expanded = lines(app.frame())
      const row = expanded.findIndex((line) => line.includes(`− ${label}`))
      expect(row).toBeLessThan(expand.row)
      expect(expanded.slice(row + 1).join("\n")).toContain("echo running step 0")

      const collapse = await toggle(app, label)
      expect(collapse.frames.at(-1)).toBe(expand.row)
      expect(lines(app.frame())[expand.row]).toContain(`+ ${label}`)
    },
  )
})

/** Turns `from` to `to` of plain prompts and answers. */
const plain = (sessionID: string, from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => [
    user(sessionID, from + i, `Turn ${from + i} prompt`),
    reply(sessionID, from + i, [text(`a${from + i}`, `Turn ${from + i} answer`)]),
  ]).flat()

test("closing an open group while scrolled up keeps its line on its row as older messages mount above", async () => {
  writeKV({ [VERBOSITY]: "high" })
  const reads = Array.from({ length: 100 }, (_, index) =>
    call(`read-${index}`, "workspace_read_file", { path: `${index}.ts` }),
  )
  // At High the reads' group starts open: its 100 reads spend the tail's budget, until it closes. The reply's long
  // text keeps the reader more than a screen from the top, where no older message has mounted yet.
  const notes = Array.from({ length: 30 }, (_, index) => `note ${index}`).join("\n\n")
  await withSession(
    (id) => [
      ...plain(id, 0, 60),
      user(id, 60, "Explore"),
      reply(id, 60, [text("looking", `Looking around\n\n${notes}`), ...reads, text("done", "All read")]),
      ...plain(id, 61, 66),
    ],
    "Turn 65 answer",
    async (app) => {
      const label = "Explored: 100 reads"
      for (let step = 0; step < 100 && !(rowOf(app.frame(), label) >= 10); step++) {
        await app.setup.mockMouse.scroll(30, 12, "up")
        await app.setup.renderOnce()
      }
      await settle(app)
      expect(rowOf(app.frame(), label)).toBeGreaterThanOrEqual(10)

      const collapse = await toggle(app, label)
      expect(collapse.frames).toEqual([collapse.row])
      const f = app.frame()
      expect(rowOf(f, "All read")).toBeGreaterThan(collapse.row)
      expect(f).not.toContain("Read 99.ts")
      expect(rowOf(f, "note 29")).toBeLessThan(collapse.row)
    },
  )
})
