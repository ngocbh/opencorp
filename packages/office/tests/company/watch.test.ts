/** company.updated each time the clone's HEAD moves. */
import { expect, setDefaultTimeout, test } from "bun:test"
import { HeadWatcher } from "../../src/company/watch.ts"
import type { Subscription } from "../../src/daemon/bus.ts"
import type { Office } from "../../src/daemon/office.ts"
import { makeOffice } from "../daemon/helpers.ts"
import { waitFor } from "../helpers.ts"
import { recordEvents } from "../store/helpers.ts"
import { git } from "./helpers.ts"

setDefaultTimeout(30_000)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The next `company.updated` event on `sub`; throws if the subscription ends or none comes within `timeoutMs`. */
async function nextCompanyEvent(sub: Subscription, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const left = deadline - performance.now()
    if (left <= 0) throw new Error("timed out waiting for company.updated")
    const item = await sub.next(left)
    if (item === null) throw new Error("the subscription ended before company.updated")
    if (typeof item === "symbol") continue
    if (item[0] === "meta" && item[1].type === "company.updated") return item[1]
  }
}

/** Counts calls to `office.git.readHead`, which still reads; returns the count and a restore. */
function countReads(office: Office): { reads: () => number; restore: () => void } {
  const readHead = office.git.readHead.bind(office.git)
  let calls = 0
  office.git.readHead = () => {
    calls += 1
    return readHead()
  }
  return { reads: () => calls, restore: () => delete (office.git as { readHead?: unknown }).readHead }
}

test("a move emits once with the sha and the first read is only a baseline", async () => {
  const office = makeOffice()
  const events = recordEvents(office.store)
  const { reads, restore } = countReads(office)
  try {
    const watcher = new HeadWatcher(office, { intervalMs: 50 })
    office.onStart.push(() => watcher.start())
    office.onStop.push(() => watcher.stop())
    await office.start()
    const sub = office.bus.subscribe(null, { types: ["company.updated"] })
    await waitFor(() => reads() >= 2, { what: "the baseline and one poll" })
    expect(events).toEqual([]) // starting records nothing
    git(office.paths.company, "commit", "-q", "--allow-empty", "-m", "an outside commit")
    const event = await nextCompanyEvent(sub)
    const sha = await office.git.head()
    expect(event.subject_id).toBe(sha)
    expect(event.data).toEqual({ sha })
    const seen = reads()
    await waitFor(() => reads() >= seen + 2, { what: "two more polls" })
    expect(events.map((e) => e.type)).toEqual(["company.updated"]) // once per move
    await office.stop()
    const stopped = reads()
    git(office.paths.company, "commit", "-q", "--allow-empty", "-m", "a commit after stop")
    await sleep(300)
    expect(events.length).toBe(1)
    expect(reads()).toBe(stopped) // polling stopped
  } finally {
    restore()
  }
})

test("stop before start is harmless", async () => {
  await new HeadWatcher(makeOffice()).stop()
})

test("a failed read or emit is logged and polling goes on", async () => {
  class TooManyOpenFiles extends Error {}
  class DiskFull extends Error {}
  const office = makeOffice()
  const readHead = office.git.readHead.bind(office.git)
  const emit = office.store.emit.bind(office.store)
  const failures = { read: 2, emit: 1 } // the first two reads fail, then the first emit
  let reads = 0
  office.git.readHead = () => {
    reads += 1
    if (failures.read) {
      failures.read -= 1
      throw new TooManyOpenFiles("too many open files")
    }
    return readHead()
  }
  office.store.emit = ((...args: Parameters<typeof emit>) => {
    if (failures.emit) {
      failures.emit -= 1
      throw new DiskFull("disk full")
    }
    return emit(...args)
  }) as typeof emit
  const logged: string[] = []
  try {
    const watcher = new HeadWatcher(office, { intervalMs: 50, log: (message) => logged.push(message) })
    office.onStart.push(() => watcher.start())
    office.onStop.push(() => watcher.stop())
    await office.start()
    const sub = office.bus.subscribe(null, { types: ["company.updated"] })
    await waitFor(() => reads >= 4, { what: "two failed reads, the baseline and one poll" })
    git(office.paths.company, "commit", "-q", "--allow-empty", "-m", "an outside commit")
    const event = await nextCompanyEvent(sub) // retried after the failed emit
    expect(event.data).toEqual({ sha: await office.git.head() })
    await office.stop()
  } finally {
    delete (office.git as { readHead?: unknown }).readHead
    delete (office.store as { emit?: unknown }).emit
  }
  expect(failures).toEqual({ read: 0, emit: 0 })
  expect(logged).toContain("couldn't check the company clone's HEAD or record company.updated: TooManyOpenFiles")
  expect(logged).toContain("couldn't check the company clone's HEAD or record company.updated: DiskFull")
  const text = logged.join("\n")
  expect(text).not.toContain("too many open files")
  expect(text).not.toContain("disk full")
})
