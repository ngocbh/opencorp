/** Closing the store. */
import path from "node:path"
import { expect, onTestFinished, test } from "bun:test"
import { Store, StoreError } from "../../src/store/store.ts"
import { tempDir } from "../helpers.ts"
import { thrown } from "./helpers.ts"

test("a closed store refuses reads and writes", () => {
  const store = new Store(path.join(tempDir(), "s.sqlite"))
  onTestFinished(() => store.close())
  store.listWorkers()
  store.close()
  for (const call of [
    () => store.listWorkers(),
    () => store.removeWorker("s1"),
    () => store.transaction(() => {}),
    () => store.db,
  ]) {
    const e = thrown(call)
    expect(e).toBeInstanceOf(StoreError)
    expect((e as Error).message).toMatch(/closed/)
  }
  store.close()
})

test("a store cannot close inside a transaction", () => {
  const store = new Store(path.join(tempDir(), "s.sqlite"))
  onTestFinished(() => store.close())
  const e = thrown(() =>
    store.transaction((tx) => {
      tx.run("INSERT INTO workers (key, pid, pgid, start_time) VALUES ('s1', 1, 1, 1)")
      store.close()
    }),
  )
  expect(e).toBeInstanceOf(StoreError)
  expect((e as Error).message).toBe("the store can't close inside a transaction")
  expect(store.listWorkers()).toEqual([])
  store.recordWorker("s2", { pid: 2, pgid: 2, startTime: 2 })
  expect(store.listWorkers().map((w) => w.key)).toEqual(["s2"])
})
