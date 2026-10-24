/** Work-item routes. */
import { expect, test } from "bun:test"
import { comment, workItem } from "../store/helpers.ts"
import { makeOffice, request, served, ULID } from "./helpers.ts"

test("get work item and comments", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const item = office.store.createWorkItem(workItem())
  const c = office.store.addComment(comment(item.id))
  expect((await request(sock, "GET", `/work-items/${item.id}`)).json()).toEqual(item)
  expect((await request(sock, "GET", `/work-items/${item.id}/comments`)).json()).toEqual([c])
})

test("missing work item is 404", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  for (const target of [`/work-items/${ULID}`, `/work-items/${ULID}/comments`]) {
    const r = await request(sock, "GET", target)
    expect(r.status).toBe(404)
    expect((r.json() as { error: string }).error).toBe("not_found")
  }
})
