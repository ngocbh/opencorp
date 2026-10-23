/** Closing the store. */
import path from "node:path"
import { expect, test } from "bun:test"
import { Store, StoreError } from "../../src/store/store.ts"
import { tempDir } from "../helpers.ts"
import { thrown } from "./helpers.ts"

test("a closed store refuses reads and writes", () => {
  const store = new Store(path.join(tempDir(), "s.sqlite"))
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
