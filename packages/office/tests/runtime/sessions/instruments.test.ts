/** A session's live instruments: listed, published as they change and print, and readable from a late join. */
import { expect, test } from "bun:test"
import type { Instrument, LiveEvent } from "@opencorp/protocol"
import { Instruments, type LiveInstrument } from "../../../src/runtime/sessions/instruments.ts"
import { waitFor } from "../../helpers.ts"

const SESSION = "01JA1H00000000000000000S01"
const OTHER = "01JA1H00000000000000000S02"
const T = "2026-11-17T10:00:00.000Z"

/** A stand-in shell whose state a test sets; it records the keys, interrupts and sizes it gets. */
function shell(id: string, over: Partial<Instrument> = {}) {
  const got: string[] = []
  let info: Instrument = {
    id,
    session_id: SESSION,
    kind: "terminal",
    name: "shell 1",
    driver: "minh",
    profile: "workspace",
    interactive: true,
    size: { cols: 80, rows: 24 },
    status: "idle",
    waiting: null,
    command: null,
    error: null,
    created_at: T,
    updated_at: T,
    ...over,
  }
  const instrument: LiveInstrument = {
    id,
    interactive: info.interactive,
    info: () => info,
    keys: (data) => got.push(`keys ${data}`),
    interrupt: () => got.push("interrupt"),
    resize: (cols, rows) => got.push(`resize ${cols}x${rows}`),
  }
  return { instrument, got, set: (change: Partial<Instrument>) => (info = { ...info, ...change }) }
}

/** A registry whose events land in `events`. */
function registry(options?: { keepBytes?: number; everyMs?: number }) {
  const events: LiveEvent[] = []
  return { instruments: new Instruments((event) => events.push(event), options), events }
}

const bytes = (text: string) => new TextEncoder().encode(text)
const decoded = (data: Uint8Array) => new TextDecoder().decode(data)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The output events' offsets and text. */
function outputs(events: LiveEvent[]): [number, string][] {
  return events
    .filter((e) => e.type === "instrument.output")
    .map((e) => [e.data.offset as number, Buffer.from(e.data.data as string, "base64").toString()])
}

test("an added instrument is listed and published as instrument.updated", () => {
  const { instruments, events } = registry()
  const one = shell("01JA1H00000000000000000K01")
  instruments.add(SESSION, one.instrument)
  expect(instruments.list(SESSION)).toEqual([one.instrument.info()])
  expect(instruments.list(OTHER)).toEqual([])
  expect(instruments.get(SESSION, one.instrument.id)).toBe(one.instrument)
  expect(instruments.get(OTHER, one.instrument.id)).toBeUndefined()
  expect(events).toEqual([{ type: "instrument.updated", session_id: SESSION, data: one.instrument.info() }])

  // A change its host reports is published whole; the list reads it as it is now.
  one.set({ status: "running", command: "make" })
  instruments.updated(SESSION, one.instrument.id)
  expect(events.at(-1)).toEqual({ type: "instrument.updated", session_id: SESSION, data: one.instrument.info() })
  expect(instruments.list(SESSION)[0]).toMatchObject({ status: "running", command: "make" })

  // A second, listed after the first; one id is listed once.
  const two = shell("01JA1H00000000000000000K02", { name: "shell 2" })
  instruments.add(SESSION, two.instrument)
  expect(instruments.list(SESSION).map((i) => i.name)).toEqual(["shell 1", "shell 2"])
  expect(() => instruments.add(SESSION, two.instrument)).toThrow(/already/)

  // What names nothing is ignored.
  instruments.updated(SESSION, "01JA1H00000000000000000K09")
  instruments.output(SESSION, "01JA1H00000000000000000K09", bytes("x"))
  expect(events).toHaveLength(3)
})

test("output is coalesced into one event per interval, in order, with offsets that continue each other", async () => {
  const { instruments, events } = registry({ everyMs: 40 })
  const { instrument } = shell("01JA1H00000000000000000K01")
  instruments.add(SESSION, instrument)
  events.length = 0
  // The first chunk goes at once, so an echo isn't held back; what follows within the interval waits for its end.
  instruments.output(SESSION, instrument.id, bytes("$ ls\r\n"))
  instruments.output(SESSION, instrument.id, bytes("a.txt\r\n"))
  instruments.output(SESSION, instrument.id, bytes("b.txt\r\n"))
  expect(outputs(events)).toEqual([[0, "$ ls\r\n"]])
  await sleep(80)
  expect(outputs(events)).toEqual([
    [0, "$ ls\r\n"],
    [6, "a.txt\r\nb.txt\r\n"],
  ])
  for (const e of events) expect(e).toMatchObject({ session_id: SESSION, data: { instrument_id: instrument.id } })

  // A burst larger than one event goes as one event of at most 64 KiB per interval, each starting where the last
  // ended.
  await sleep(60)
  events.length = 0
  const big = "x".repeat(150 * 1024)
  instruments.output(SESSION, instrument.id, bytes(big))
  expect(outputs(events).map(([offset, text]) => [offset, text.length])).toEqual([[20, 64 * 1024]])
  await waitFor(() => outputs(events).length === 3, { what: "the rest of the burst" })
  const sent = outputs(events)
  expect(sent.map(([offset, text]) => [offset, text.length])).toEqual([
    [20, 64 * 1024],
    [20 + 64 * 1024, 64 * 1024],
    [20 + 128 * 1024, 22 * 1024],
  ])
  expect(sent.map(([, text]) => text).join("")).toBe(big)

  // A change goes at once, after all the output still waiting, so a client reads the last bytes before the shell's
  // end.
  events.length = 0
  instruments.output(SESSION, instrument.id, bytes("done\r\n"))
  instruments.output(SESSION, instrument.id, bytes("$ "))
  instruments.updated(SESSION, instrument.id)
  expect(events.at(-1)!.type).toBe("instrument.updated")
  expect(outputs(events)[0]![0]).toBe(20 + 150 * 1024)
  expect(outputs(events).map(([, text]) => text).join("")).toBe("done\r\n$ ")
})

test("the screen keeps the last bytes, starting after a line feed, and its offset and end say which bytes they are", () => {
  const { instruments } = registry({ keepBytes: 16 })
  const { instrument } = shell("01JA1H00000000000000000K01")
  instruments.add(SESSION, instrument)
  const screen = () => {
    const got = instruments.screen(SESSION, instrument.id)!
    return { offset: got.offset, end: got.end, text: decoded(got.data) }
  }
  expect(screen()).toEqual({ offset: 0, end: 0, text: "" })
  // Everything since the start is kept whole, from offset 0.
  instruments.output(SESSION, instrument.id, bytes("one\ntwo\n"))
  expect(screen()).toEqual({ offset: 0, end: 8, text: "one\ntwo\n" })
  // Past the cap the last 16 bytes are kept (`\ntwo\nthree\nfour\n`, from offset 3), and the screen starts after
  // their first line feed.
  instruments.output(SESSION, instrument.id, bytes("three\nfo"))
  instruments.output(SESSION, instrument.id, bytes("ur\n"))
  expect(screen()).toEqual({ offset: 4, end: 19, text: "two\nthree\nfour\n" })
  // An escape sequence cut by the cap is never where the screen starts.
  // The cap cuts this chunk's first byte, its escape's ESC.
  instruments.output(SESSION, instrument.id, bytes("\x1b[1mbold\x1b[0m\nok!\n"))
  expect(screen()).toEqual({ offset: 32, end: 36, text: "ok!\n" })
  // With no line feed in the kept bytes, the screen is all of them.
  instruments.output(SESSION, instrument.id, bytes("abcdefghijklmnopqrstuvwxyz"))
  expect(screen()).toEqual({ offset: 46, end: 62, text: "klmnopqrstuvwxyz" })
  expect(instruments.screen(OTHER, instrument.id)).toBeUndefined()

  // An echo comes a byte at a time; however many bytes, the screen holds them in order.
  const echo = registry({ everyMs: 1000 })
  echo.instruments.add(SESSION, instrument)
  const typed = "ls -l\r\n".repeat(500)
  for (const key of typed) echo.instruments.output(SESSION, instrument.id, bytes(key))
  const held = echo.instruments.screen(SESSION, instrument.id)!
  expect([held.offset, held.end, decoded(held.data)]).toEqual([0, typed.length, typed])
})

test("a removed instrument leaves the list", () => {
  const { instruments, events } = registry({ everyMs: 1000 })
  const one = shell("01JA1H00000000000000000K01", { status: "ended" })
  const two = shell("01JA1H00000000000000000K02", { name: "shell 2" })
  instruments.add(SESSION, one.instrument)
  instruments.add(SESSION, two.instrument)
  instruments.output(SESSION, one.instrument.id, bytes("first\r\n"))
  instruments.output(SESSION, one.instrument.id, bytes("last\r\n"))
  events.length = 0
  instruments.remove(SESSION, one.instrument.id)
  // Its output still waiting goes before it leaves; no event of it follows.
  expect(events).toEqual([
    {
      type: "instrument.output",
      session_id: SESSION,
      data: { instrument_id: one.instrument.id, offset: 7, data: Buffer.from("last\r\n").toString("base64") },
    },
    { type: "instrument.removed", session_id: SESSION, data: { id: one.instrument.id, session_id: SESSION } },
  ])
  expect(instruments.list(SESSION).map((i) => i.id)).toEqual([two.instrument.id])
  expect(instruments.get(SESSION, one.instrument.id)).toBeUndefined()
  expect(instruments.screen(SESSION, one.instrument.id)).toBeUndefined()
  instruments.output(SESSION, one.instrument.id, bytes("late"))
  instruments.updated(SESSION, one.instrument.id)
  instruments.remove(SESSION, one.instrument.id)
  expect(events).toHaveLength(2)
  // The registry only lists: it never closes, interrupts or types into what it removes.
  expect(one.got).toEqual([])
  instruments.remove(SESSION, two.instrument.id)
  expect(instruments.list(SESSION)).toEqual([])
})
