/** Store test helpers (Python's store conftest). */
import path from "node:path"
import { onTestFinished } from "bun:test"
import { Store, type StoreOptions } from "../../src/store/store.ts"
import { tempDir } from "../helpers.ts"

/** A store in a fresh temp dir (`<tmp>/office/store.sqlite`), closed when the test finishes
 *  (Python's `store` fixture). */
export function openStore(options?: StoreOptions): Store {
  const store = new Store(path.join(tempDir(), "office", "store.sqlite"), options)
  onTestFinished(() => store.close())
  return store
}
