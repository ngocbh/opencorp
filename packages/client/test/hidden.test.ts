import { expect, test } from "bun:test"
import { pauseWhenHidden } from "../src/hidden"

function page() {
  let fn = () => {}
  return { hidden: false, addEventListener: (_: string, f: () => void) => void (fn = f), removeEventListener() {}, fire() { fn() } }
}

test("a tab hidden past the limit stops the stream and starts it again when shown", async () => {
  const calls: string[] = []
  const p = page()
  pauseWhenHidden({ start: () => calls.push("start"), stop: () => calls.push("stop") }, p as any, 20)
  p.hidden = true
  p.fire()
  await Bun.sleep(40)
  p.hidden = false
  p.fire()
  expect(calls).toEqual(["stop", "start"])
})

test("a tab shown again within the limit keeps its stream", async () => {
  const calls: string[] = []
  const p = page()
  pauseWhenHidden({ start: () => calls.push("start"), stop: () => calls.push("stop") }, p as any, 50)
  p.hidden = true
  p.fire()
  p.hidden = false
  p.fire()
  await Bun.sleep(70)
  expect(calls).toEqual([])
})

test("a tab that opens hidden lets go of its stream too", async () => {
  const calls: string[] = []
  const p = page()
  p.hidden = true
  pauseWhenHidden({ start: () => calls.push("start"), stop: () => calls.push("stop") }, p as any, 20)
  await Bun.sleep(40)
  p.hidden = false
  p.fire()
  expect(calls).toEqual(["stop", "start"])
})
