/** The office's ids. */
import { expect, test } from "bun:test"
import { Ulid } from "@opencorp/protocol"
import { newId } from "../../src/util/ids.ts"

test("new ids are monotonic ULIDs", () => {
  const ids = Array.from({ length: 1000 }, () => newId())
  expect(new Set(ids).size).toBe(ids.length)
  for (const id of ids) expect(Ulid.safeParse(id).success).toBe(true)
  expect(ids.toSorted()).toEqual(ids)
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
  const time = [...ids[0]!.slice(0, 10)].reduce((t, c) => t * 32 + alphabet.indexOf(c), 0)
  expect(Math.abs(time - Date.now())).toBeLessThan(5000)
})
