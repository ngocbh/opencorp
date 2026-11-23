// A long transcript mounts in pages, as upstream's mount budget mounts its rows: only the tail when the session opens,
// older messages a chunk at a time as the reader scrolls near the top, with no jump. Message navigation mounts the
// rest first; a reply that streams still keeps the view at the bottom; copy and export read every message; and a
// session opens where the reader left it.
import type { Message, Part, Session, ToolPart } from "@opencorp/protocol"
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { TestRecorder } from "@opentui/core/testing"
import { afterAll, beforeEach, expect, mock, setDefaultTimeout, test } from "bun:test"
import * as clipboard from "../../../src/context/clipboard"
import { createFakeOffice, createStub, seed, type FakeOffice } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"
import { writeKV } from "../../fixture/kv"
import { until } from "../../fixture/until"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

type App = Awaited<ReturnType<typeof bootFrame>>

// A test here scrolls through a long transcript a wheel tick at a time.
setDefaultTimeout(60_000)

const AT = "2026-11-23T10:00:00.000Z"
const VERBOSITY = "session_verbosity"

// Each test starts on the default verbosity; later test files expect it too.
beforeEach(() => writeKV({ [VERBOSITY]: undefined }))
afterAll(() => writeKV({ [VERBOSITY]: undefined }))

// Navigation and the last message on keys of their own: upstream's default keys are none, or the prompt's.
const config = createTuiResolvedConfig({
  keybinds: { messages_previous: "f5", messages_last_user: "f6", messages_last: "f7" },
})

/** Turn `t`'s user message and its reply, by ids that sort as the office's do. */
const userID = (t: number) => `turn-${String(t).padStart(3, "0")}-1`
const replyID = (t: number) => `turn-${String(t).padStart(3, "0")}-2`

/** `count` turns of session `sessionID`, from turn `from`: "Turn t prompt", and its reply "Turn t answer". */
function turns(sessionID: string, count: number, from = 0): Message[] {
  return Array.from({ length: count }, (_, i) => {
    const t = from + i
    return [
      {
        id: userID(t),
        session_id: sessionID,
        role: "user" as const,
        created_at: AT,
        parts: [{ id: `u${t}`, type: "text" as const, text: `Turn ${t} prompt` }],
      },
      {
        id: replyID(t),
        session_id: sessionID,
        role: "assistant" as const,
        created_at: AT,
        parts: [{ id: `a${t}`, type: "text" as const, text: `Turn ${t} answer` }],
      },
    ]
  }).flat()
}

/** Boots session 0 of `office` on `messages`, once it shows `shows` and the TUI has read it. */
async function boot(
  messages: (sessionID: string) => Message[],
  shows: string,
  office: FakeOffice = createFakeOffice(),
) {
  const s = office.state.sessions[0]!
  office.state.messages[s.id] = messages(s.id)
  const app = await bootFrame({ ...createStub(office), config }, { sessionID: s.id }, { width: 100, height: 40 })
  await opened(app, office, s.id, shows)
  return { office, s, app }
}

/** Waits until session `id` shows `shows` and its read has settled, past the scroll that follows it. */
async function opened(app: App, office: FakeOffice, id: string, shows: string) {
  await app.until((f) => f.includes(shows))
  await until(() => office.requests.some((r) => r.path === `/sessions/${id}/messages`))
  await Bun.sleep(100)
  return app.until((f) => f.includes(shows))
}

/** The transcript's scrollbox: the one holding message `id`. */
function transcript(app: App, id: string) {
  const find = (node: Renderable): ScrollBoxRenderable | undefined =>
    node instanceof ScrollBoxRenderable && node.getRenderable(id) ? node : node.getChildren().map(find).find(Boolean)
  const scroll = find(app.setup.renderer.root)
  if (!scroll) throw new Error("Missing transcript scrollbox")
  // Booleans keep a failure message from serializing the renderable graph.
  return { mounted: (message: string) => scroll.getRenderable(message) !== undefined }
}

/** The earliest turn a frame shows. */
const earliest = (frame: string) =>
  Math.min(...[...frame.matchAll(/Turn (\d+) (?:prompt|answer)/g)].map((match) => Number(match[1])))
/** The turns a frame shows, each with its screen row. */
const shownTurns = (frame: string) =>
  frame.split("\n").flatMap((line, y) => (/Turn \d+ (?:prompt|answer)/.exec(line) ?? []).map((text) => ({ text, y })))
/** Whether `turns`, the earliest turn of each frame, only step up a turn at a time: never back, never past one. */
const jumps = (turns: number[]) =>
  turns.filter((turn, index) => index > 0 && (turn > turns[index - 1]! || turn < turns[index - 1]! - 1))

/** Opens the palette and picks the command titled `title`. */
async function runCommand(app: App, title: string) {
  app.input.pressKey("p", { ctrl: true })
  await app.until((f) => f.includes("Commands"))
  // The search box takes focus a moment after it renders.
  await Bun.sleep(50)
  app.input.typeText(title)
  await app.until((f) => f.split(title).length > 2)
  app.input.pressEnter()
}

/** Wheels up over the transcript until `done(frame)`, a tick a frame; returns each frame's earliest turn. */
async function wheelUp(app: App, done: (frame: string) => boolean) {
  const recorder = new TestRecorder(app.setup.renderer)
  recorder.rec()
  for (let step = 0; step < 400 && !done(app.frame()); step++) {
    await app.setup.mockMouse.scroll(30, 12, "up")
    await app.setup.renderOnce()
  }
  // The anchor that held the view lets go a frame after it mounted the rows above.
  await app.setup.renderOnce()
  recorder.stop()
  return recorder.recordedFrames.map((frame) => earliest(frame.frame))
}

test("a long transcript mounts only its tail", async () => {
  const { office, app } = await boot((id) => turns(id, 100), "Turn 99 answer")
  try {
    const f = app.frame()
    expect(f).not.toContain("Turn 0 prompt")
    const view = transcript(app, userID(99))
    // 200 messages, each one entry: the newest 40 mount, from turn 80.
    expect(view.mounted(userID(80))).toBe(true)
    expect(view.mounted(userID(79))).toBe(false)
    expect(view.mounted(userID(0))).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("scrolling to the top mounts older messages a chunk at a time, never moving what the reader sees", async () => {
  const { office, app } = await boot((id) => turns(id, 100), "Turn 99 answer")
  try {
    const earliestTurns = await wheelUp(app, (f) => f.includes("Turn 0 prompt"))
    expect(app.frame()).toContain("Turn 0 prompt")
    expect(earliestTurns.at(-1)).toBe(0)
    // A wheel tick moves less than a turn, so the earliest turn on screen steps up by at most one a frame. A frame
    // drawn before the mounted rows are scrolled past would show their first turn instead.
    expect(jumps(earliestTurns)).toEqual([])
    expect(transcript(app, userID(0)).mounted(userID(99))).toBe(true)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("the first message and the previous ones are reached past the mounted tail", async () => {
  const { office, app } = await boot((id) => turns(id, 100), "Turn 99 answer")
  try {
    // ctrl+g: the first message.
    app.input.pressKey("g", { ctrl: true })
    let f = await app.until((f) => f.includes("Turn 0 prompt"))
    expect(f).not.toContain("Turn 99")
    app.input.pressKey("F7")
    await app.until((f) => f.includes("Turn 99 answer"))
    expect(transcript(app, userID(99)).mounted(userID(79))).toBe(false)

    // The previous message, again and again, up past the tail to the first.
    const seen: number[] = []
    for (let step = 0; step < 120 && !app.frame().includes("Turn 0 prompt"); step++) {
      app.input.pressKey("F5")
      await app.setup.renderOnce()
      await app.setup.renderOnce()
      seen.push(earliest(app.frame()))
    }
    f = await app.until((f) => f.includes("Turn 0 prompt"))
    expect(seen.filter((turn, index) => index > 0 && turn > seen[index - 1]!)).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a reply that streams keeps the view at the bottom, and the tail follows new messages", async () => {
  const office = createFakeOffice()
  office.updateSession(office.state.sessions[0]!.id, { status: "busy" })
  const { s, app } = await boot((id) => turns(id, 100), "Turn 99 answer", office)
  try {
    await app.until((f) => f.includes("@minh · busy"))
    for (let line = 1; line <= 30; line++)
      office.live({
        type: "part.delta",
        session_id: s.id,
        data: { message_id: replyID(99), part_id: "a99", text: `\n\nstreamed line ${line}` },
      })
    let f = await app.until((f) => f.includes("streamed line 30"))
    expect(f).not.toContain("Turn 99 answer")
    const next = turns(s.id, 2, 100)
    for (const message of next) office.live({ type: "message.updated", session_id: s.id, data: message as never })
    f = await app.until((f) => f.includes("Turn 101 answer"))
    // At the bottom the tail is the newest 40: two turns more, two older turns out.
    const view = transcript(app, userID(101))
    expect(view.mounted(userID(82))).toBe(true)
    expect(view.mounted(userID(81))).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("copying the transcript copies every message, mounted or not", async () => {
  // The machine's clipboard is left alone: the app's writes are kept here instead.
  const real = { ...clipboard }
  const copied: string[] = []
  const fake = { write: async (text: string) => void copied.push(text) }
  mock.module("../../../src/context/clipboard", () => ({ ...real, useClipboard: () => fake }))
  const { office, app } = await boot((id) => turns(id, 100), "Turn 99 answer")
  try {
    expect(transcript(app, userID(99)).mounted(userID(0))).toBe(false)
    await runCommand(app, "Copy session transcript")
    await app.until((f) => f.includes("Session transcript copied"))
    expect(copied).toHaveLength(1)
    for (let t = 0; t < 100; t++) {
      expect(copied[0]).toContain(`Turn ${t} prompt`)
      expect(copied[0]).toContain(`Turn ${t} answer`)
    }
  } finally {
    await app.stop()
    office.stop()
    mock.module("../../../src/context/clipboard", () => real)
  }
})

test("a session opens where the reader left it", async () => {
  const lanText: Part = { id: "lan-t", type: "text", text: "the other chat" }
  const S1 = "000000000000000000000000S1"
  const S2 = "000000000000000000000000S2"
  const state = seed()
  const ceo = state.people.find((p) => p.kind === "human")!.handle
  state.people.push({ handle: "lan", name: "Lan", kind: "agent", title: "Designer", manager: ceo })
  const base = state.sessions[0]!
  const at = (ms: number) => new Date(Date.now() - ms).toISOString()
  state.sessions = [
    { ...base, id: S1, updated_at: at(60_000) },
    { ...base, id: S2, person: "lan", updated_at: at(120_000) },
  ] satisfies Session[]
  state.messages = { [S1]: turns(S1, 100), [S2]: [{ ...turns(S2, 1)[0]!, id: "lan-1", parts: [lanText] }] }
  const office = createFakeOffice({ seed: state })
  const app = await bootFrame({ ...createStub(office), config }, { sessionID: S1 }, { width: 100, height: 40 })
  try {
    await opened(app, office, S1, "Turn 99 answer")
    await wheelUp(app, (f) => f.includes("Turn 60 prompt"))
    const left = shownTurns(app.frame())
    expect(left.map((turn) => turn.text)).toContain("Turn 60 prompt")

    const open = async (filter: string, shows: string) => {
      await runCommand(app, "Switch session")
      await app.until((f) => f.includes("Sessions"))
      await app.input.typeText(filter)
      await Bun.sleep(50)
      app.input.pressEnter()
      return app.until((f) => !f.includes("Sessions") && f.includes(shows))
    }
    await open("lan", "the other chat")
    await open("minh", "Turn 60 prompt")
    const back = await opened(app, office, S1, "Turn 60 prompt")
    expect(shownTurns(back)).toEqual(left)
  } finally {
    await app.stop()
    office.stop()
  }
})

let n = 0
/** A completed read of `path`. */
const read = (path: string): ToolPart => ({
  id: `r${++n}`,
  type: "tool",
  call_id: `call_${n}`,
  tool: "workspace_read_file",
  state: "completed",
  input: { path },
})

test("an expanded group spends the mounting budget that older messages used", async () => {
  writeKV({ [VERBOSITY]: "medium" })
  // 30 plain turns, then one whose reply makes 100 reads.
  const { office, app } = await boot(
    (id) => [
      ...turns(id, 30),
      {
        id: userID(30),
        session_id: id,
        role: "user",
        created_at: AT,
        parts: [{ id: "ue", type: "text", text: "Explore" }],
      },
      {
        id: replyID(30),
        session_id: id,
        role: "assistant",
        created_at: AT,
        parts: Array.from({ length: 100 }, (_, index) => read(`${index}.ts`)),
      },
    ],
    "Explored: 100 reads",
  )
  try {
    const view = transcript(app, userID(30))
    // Collapsed: 40 entries, a message each and the group one. Turn 11 onward is mounted.
    expect(view.mounted(userID(11))).toBe(true)
    expect(view.mounted(userID(10))).toBe(false)

    const header = () => app.frame().split("\n").findIndex((line) => line.includes("Explored: 100 reads"))
    await app.setup.mockMouse.click(6, header())
    await app.until((f) => f.includes("Read 99.ts"))
    // Expanded: the group's 101 rendered entries exceed the 40-entry tail on their own.
    expect(view.mounted(userID(29))).toBe(false)
    expect(view.mounted(userID(30))).toBe(false)

    // Back to the header (the view stayed at the bottom), collapse it, and back to the end.
    app.input.pressKey("F6")
    await app.until((f) => f.includes("Explored: 100 reads"))
    await app.setup.mockMouse.click(6, header())
    await app.until((f) => !f.includes("Read 99.ts"))
    app.input.pressKey("F7")
    await app.until((f) => !f.includes("Read 99.ts") && f.includes("Explored: 100 reads"))
    expect(view.mounted(userID(11))).toBe(true)
    expect(view.mounted(userID(10))).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})
