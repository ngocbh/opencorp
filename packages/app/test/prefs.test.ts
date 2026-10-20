import { expect, test } from "bun:test"
import { createPrefs } from "../src/company/prefs"

function memory(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

test("first visit: the CEO, level one, and branches holding someone who needs you start open", () => {
  const prefs = createPrefs(memory())
  expect(prefs.isOpen("ceo", { depth: 0, holdsNeedsYou: false })).toBe(true)
  expect(prefs.isOpen("lead", { depth: 1, holdsNeedsYou: false })).toBe(true)
  expect(prefs.isOpen("deep", { depth: 2, holdsNeedsYou: false })).toBe(false)
  expect(prefs.isOpen("deep", { depth: 2, holdsNeedsYou: true })).toBe(true)
})

test("open branches and the Chart/List choice are remembered per browser", () => {
  const storage = memory()
  const prefs = createPrefs(storage)
  expect(prefs.view()).toBeNull()
  prefs.setOpen("lead", false)
  prefs.setView("list")
  const again = createPrefs(storage)
  expect(again.isOpen("lead", { depth: 1, holdsNeedsYou: true })).toBe(false)
  expect(again.view()).toBe("list")
})

test("an unreadable entry falls back to the defaults", () => {
  const prefs = createPrefs(memory({ "hq.open": "{", "hq.view": "[" }))
  expect([prefs.isOpen("ceo", { depth: 0, holdsNeedsYou: false }), prefs.view()]).toEqual([true, null])
  const odd = createPrefs(memory({ "hq.open": "null", "hq.view": '"grid"' }))
  expect([odd.isOpen("ceo", { depth: 0, holdsNeedsYou: false }), odd.view()]).toEqual([true, null])
})

test("a browser that refuses storage still opens, closes and switches for this tab", () => {
  const refuse = () => {
    throw new DOMException("refused", "SecurityError")
  }
  const prefs = createPrefs({ getItem: refuse, setItem: refuse })
  prefs.setOpen("ceo", false)
  prefs.setView("list")
  expect([prefs.isOpen("ceo", { depth: 0, holdsNeedsYou: false }), prefs.view()]).toEqual([false, "list"])
})
