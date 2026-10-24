/** The steering inbox: queued steers, interrupts as a per-node signal, finished nodes and close. */
import { expect, setDefaultTimeout, test } from "bun:test"
import { Inbox } from "../../src/worker/inbox.ts"

setDefaultTimeout(30_000)

test("steers queue until drained", () => {
  const inbox = new Inbox()
  expect(inbox.steer("reply", "one") && inbox.steer("reply", "two")).toBe(true)
  expect(inbox.drain("reply")).toEqual(["one", "two"])
  expect(inbox.drain("reply")).toEqual([])
})

test("a finished node refuses steers and interrupts", () => {
  const inbox = new Inbox()
  inbox.steer("reply", "unread")
  expect(inbox.interrupt("reply") && inbox.interruptSignal("reply").aborted).toBe(true)
  expect(inbox.finish("reply")).toEqual(["unread"])
  expect(inbox.interruptSignal("reply").aborted).toBe(false)
  expect(inbox.steer("reply", "late") || inbox.interrupt("reply")).toBe(false)
  expect(inbox.drain("reply")).toEqual([])
})

test("close refuses new steers and returns every queued one", () => {
  const inbox = new Inbox()
  inbox.steer("a", "1")
  inbox.steer("loop#1/b", "2")
  inbox.finish("a")
  inbox.steer("never-ran", "3")
  expect(Object.fromEntries(inbox.close())).toEqual({ "loop#1/b": ["2"], "never-ran": ["3"] })
  expect(inbox.steer("c", "late") || inbox.interrupt("c")).toBe(false)
  expect(Object.fromEntries(inbox.close())).toEqual({})
})

test("an interrupt waits for its node to start", () => {
  const inbox = new Inbox()
  expect(inbox.interrupt("later") && inbox.interruptSignal("later").aborted).toBe(true)
})

test("a node is cut once it reads its interrupt", () => {
  const inbox = new Inbox()
  expect(inbox.interrupt("reply") && !inbox.cut("reply")).toBe(true)
  expect(inbox.interruptSignal("reply").aborted && inbox.cut("reply")).toBe(true)
  inbox.finish("reply")
  expect(inbox.cut("reply")).toBe(false)
})

test("an interrupt aborts the signal a running node already took", () => {
  const inbox = new Inbox()
  const signal = inbox.interruptSignal("reply")
  expect(signal.aborted || inbox.cut("reply")).toBe(false)
  expect(inbox.interrupt("reply")).toBe(true)
  expect(signal.aborted && inbox.cut("reply")).toBe(true)
})

test("after close a node gets a signal that never aborts", () => {
  const inbox = new Inbox()
  inbox.close()
  expect(inbox.interruptSignal("x").aborted || inbox.interrupt("x")).toBe(false)
})
