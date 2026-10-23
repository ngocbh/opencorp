/** Transactions, events, and listeners. */
import type { z } from "zod"
import { expect, spyOn, test } from "bun:test"
import { Event, Ulid, now, type WorkItem } from "@opencorp/protocol"
import { Store, StoreError, Tx, newId } from "../../src/store/store.ts"
import { openStore, recordEvents, workItem } from "./helpers.ts"

type Item = z.output<typeof WorkItem>

// Stand-ins for the store's work item methods, which come later.

/** Inserts `item` and emits work_item.created with it, in one transaction. */
function createItem(store: Store, item: Item): Item {
  store.transaction((tx) => {
    tx.run(
      "INSERT INTO work_items (id, title, kind, status, requester, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
      item.id,
      item.title,
      item.kind,
      item.status,
      item.requester,
      item.created_at,
      item.updated_at,
    )
    tx.emit("work_item.created", item.id, item)
  })
  return item
}

/** Sets the item's status and emits work_item.updated with the row read back. */
function updateItem(store: Store, id: string, status: Item["status"]): void {
  store.transaction((tx) => {
    tx.run("UPDATE work_items SET status = ? WHERE id = ?", status, id)
    tx.emit("work_item.updated", id, tx.get("SELECT * FROM work_items WHERE id = ?", id)!)
  })
}

/** The item's row, or undefined. */
function getItem(store: Store, id: string) {
  return store.db.prepare("SELECT * FROM work_items WHERE id = ?").get(id)
}

/** Runs `fn` and returns what it threw (fails the test if it didn't throw). */
function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error("expected a throw")
}

/** Makes an insert into worked_folders for `cwd` end the whole transaction, as a full disk or an I/O error can. */
function failWholeTransactionOn(store: Store, cwd: string): void {
  store.db.exec(
    "CREATE TEMP TRIGGER boom BEFORE INSERT ON worked_folders " +
      `WHEN NEW.cwd = '${cwd}' BEGIN SELECT RAISE(ROLLBACK, 'disk full'); END`,
  )
}

const INSERT_FOLDER = "INSERT INTO worked_folders VALUES (?, ?, ?)"

/** The cwds in worked_folders. */
function folders(store: Store): unknown[] {
  return store.db.prepare("SELECT cwd FROM worked_folders").all().map((r) => r.cwd)
}

test("write and event commit together", () => {
  const store = openStore()
  const events = recordEvents(store)
  const item = createItem(store, workItem())
  expect(events).toHaveLength(1)
  const [event] = events
  expect([event!.type, event!.subject_id, event!.data]).toEqual(["work_item.created", item.id, item])
  expect(() => Event.parse(event)).not.toThrow()
})

test("failure between write and event lands neither", () => {
  const store = openStore()
  const events = recordEvents(store)
  const spy = spyOn(Tx.prototype, "emit").mockImplementation(() => {
    throw new Error("injected")
  })
  const item = workItem()
  try {
    expect(() => createItem(store, item)).toThrow(/injected/)
  } finally {
    spy.mockRestore()
  }
  expect(getItem(store, item.id)).toBeUndefined()
  expect(events).toEqual([])
})

test("failure in outer transaction undoes every write", () => {
  const store = openStore()
  const events = recordEvents(store)
  const [a, b] = [workItem(), workItem()]
  expect(() =>
    store.transaction(() => {
      createItem(store, a)
      createItem(store, b)
      throw new Error("outer")
    }),
  ).toThrow(/outer/)
  expect(getItem(store, a.id)).toBeUndefined()
  expect(getItem(store, b.id)).toBeUndefined()
  expect(events).toEqual([])
})

test("caught nested failure undoes only itself", () => {
  const store = openStore()
  const events = recordEvents(store)
  const [a, b] = [workItem(), workItem()]
  store.transaction(() => {
    createItem(store, a)
    expect(() =>
      store.transaction(() => {
        createItem(store, b)
        throw new Error("nested")
      }),
    ).toThrow(/nested/)
  })
  expect(getItem(store, a.id)).toBeDefined()
  expect(getItem(store, b.id)).toBeUndefined()
  expect(events.map((e) => e.subject_id)).toEqual([a.id])
})

test("own queries and events share the transaction", () => {
  const store = openStore()
  const events = recordEvents(store)
  const item = createItem(store, workItem())
  store.transaction((tx) => {
    tx.run("UPDATE work_items SET summary = ? WHERE id = ?", "hello", item.id)
    tx.emit("work_item.updated", item.id, getItem(store, item.id)!)
  })
  expect(events).toHaveLength(2)
  expect(events[1]!.data.summary).toBe("hello")
})

test("emit alone writes one event", () => {
  const store = openStore()
  const events = recordEvents(store)
  const event = store.emit("profile.updated", "minh", { person: "minh" })
  expect(events).toEqual([event])
})

test("bad event type rolls back", () => {
  const store = openStore()
  const events = recordEvents(store)
  const item = workItem()
  const e = thrown(() =>
    store.transaction((tx) => {
      createItem(store, item)
      tx.emit("no.such.type" as never, item.id, {})
    }),
  )
  expect(e).toBeInstanceOf(StoreError)
  expect((e as Error).message).toMatch(/^bad event: /)
  expect(getItem(store, item.id)).toBeUndefined()
  expect(events).toEqual([])
})

test("savepoint keeps the error when sqlite ended the transaction", () => {
  const store = openStore()
  const events = recordEvents(store)
  failWholeTransactionOn(store, "/boom")
  const item = workItem()
  const e = thrown(() =>
    store.transaction(() => {
      createItem(store, item)
      store.transaction((tx) => tx.run(INSERT_FOLDER, "minh", "/boom", now()))
    }),
  )
  expect(e).not.toBeInstanceOf(StoreError)
  expect((e as Error).message).toBe("disk full")
  expect(getItem(store, item.id)).toBeUndefined()
  expect(events).toEqual([])
  store.transaction((tx) => tx.run(INSERT_FOLDER, "minh", "/ok", now()))
  expect(folders(store)).toEqual(["/ok"])
})

test("no writes after sqlite ended the transaction", () => {
  const store = openStore()
  const events = recordEvents(store)
  failWholeTransactionOn(store, "/boom")
  const later = workItem()
  const e = thrown(() =>
    store.transaction((tx) => {
      expect(() => store.transaction((inner) => inner.run(INSERT_FOLDER, "minh", "/boom", now()))).toThrow(
        /disk full/,
      )
      const create = thrown(() => createItem(store, later))
      expect(create).toBeInstanceOf(StoreError)
      expect((create as Error).message).toMatch(/rolled back/)
      const update = thrown(() => tx.run("UPDATE work_items SET summary = 'x'"))
      expect(update).toBeInstanceOf(StoreError)
      expect((update as Error).message).toMatch(/rolled back/)
    }),
  )
  expect(e).toBeInstanceOf(StoreError)
  expect((e as Error).message).toMatch(/rolled back/)
  expect(getItem(store, later.id)).toBeUndefined()
  expect(events).toEqual([])
})

test("a failure outside tx run still blocks later writes", () => {
  const store = openStore()
  const events = recordEvents(store)
  failWholeTransactionOn(store, "/boom")
  const item = workItem()
  const e = thrown(() =>
    store.transaction(() => {
      expect(() => store.db.prepare(INSERT_FOLDER).run("minh", "/boom", now())).toThrow(/disk full/)
      // No Tx path saw that failure: only a check before every statement stops this write.
      const create = thrown(() => createItem(store, item))
      expect(create).toBeInstanceOf(StoreError)
      expect((create as Error).message).toMatch(/rolled back/)
    }),
  )
  expect(e).toBeInstanceOf(StoreError)
  expect(getItem(store, item.id)).toBeUndefined()
  expect(events).toEqual([])
  expect(folders(store)).toEqual([])
})

test("a transaction callback that returns a promise is refused and rolled back", async () => {
  const store = openStore()
  const events = recordEvents(store)
  const a = workItem()
  const e = thrown(() =>
    store.transaction(async (tx) => {
      createItem(store, a)
      await Promise.resolve()
      tx.run(INSERT_FOLDER, "minh", "/late", now())
    }),
  )
  expect(e).toBeInstanceOf(StoreError)
  expect((e as Error).message).toMatch(/never await/)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(getItem(store, a.id)).toBeUndefined()
  expect(folders(store)).toEqual([])
  expect(events).toEqual([])
  const b = createItem(store, workItem())
  expect(getItem(store, b.id)).toBeDefined()
})

test("one task nests transactions", async () => {
  const store = openStore()
  const item = workItem()
  store.transaction(() => createItem(store, item))
  expect(getItem(store, item.id)).toBeDefined()
})

test("new ids are monotonic ULIDs", () => {
  const ids = Array.from({ length: 1000 }, () => newId())
  expect(new Set(ids).size).toBe(ids.length)
  for (const id of ids) expect(Ulid.safeParse(id).success).toBe(true)
  expect(ids.toSorted()).toEqual(ids)
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
  const time = [...ids[0]!.slice(0, 10)].reduce((t, c) => t * 32 + alphabet.indexOf(c), 0)
  expect(Math.abs(time - Date.now())).toBeLessThan(5000)
})
