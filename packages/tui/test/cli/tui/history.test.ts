// The history prepend: one load at a time per transcript, each scrolled and continued once its page is laid out.
import { expect, test } from "bun:test"
import { createHistoryPrepend } from "../../../src/routes/session/history"

/** A prepend over `more`, whose loads wait for the test to finish them, laid out at once. */
function prepend(more: Record<string, boolean>) {
  let viewed = "A"
  const loads = new Map<string, () => void>()
  const scrolled: [string, number][] = []
  const load = createHistoryPrepend({
    sessionID: () => viewed,
    more: (id) => more[id] ?? false,
    loadMore: (id) => new Promise<void>((resolve) => loads.set(id, resolve)),
    afterLayout: (continuation) => continuation(),
    active: (id) => id === viewed,
    scrollBy: (amount) => scrolled.push([viewed, amount]),
  })
  return { load, loads, scrolled, view: (id: string) => (viewed = id) }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test("a load for one transcript doesn't hold back another's, and each scrolls only while its transcript shows", async () => {
  const { load, loads, scrolled, view } = prepend({ A: true, B: true })
  expect(load(-3)).toBe(true)
  // The side view takes the screen while the chat's page loads: its own page loads too.
  view("B")
  expect(load(-2)).toBe(true)
  expect([...loads.keys()]).toEqual(["A", "B"])
  loads.get("A")!()
  await settle()
  expect(scrolled).toEqual([])
  loads.get("B")!()
  await settle()
  expect(scrolled).toEqual([["B", -2]])
})

test("a second request for the transcript loading joins its load, taking the newest scroll and continuation", async () => {
  const { load, loads, scrolled } = prepend({ A: true })
  const ran: string[] = []
  expect(load(0)).toBe(true)
  expect(load(-5)).toBe(true)
  expect(load(-7)).toBe(false)
  expect(load(0, () => ran.push("next"))).toBe(true)
  expect(loads.size).toBe(1)
  loads.get("A")!()
  await settle()
  expect([scrolled, ran]).toEqual([[["A", 0]], ["next"]])
})

test("a transcript holding its first message loads nothing", () => {
  const { load, loads } = prepend({ A: false })
  expect(load(-1)).toBe(false)
  expect(loads.size).toBe(0)
})
