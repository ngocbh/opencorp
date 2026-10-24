/** HQ's /api: the allowlist. */
import { expect, test } from "bun:test"
import { makeOffice } from "../daemon/helpers.ts"
import { dist, makeHq, web } from "./helpers.ts"

test("health is open and says both keys", async () => {
  const office = makeOffice()
  dist(office.paths.home)
  const hq = await makeHq(office)
  const r = await (await web(hq)).get("/api/health")
  expect(r.status).toBe(200)
  expect(r.json()).toEqual({ ok: true, office: { api: hq.api }, app: { build: "b1", api: "x" } })
})

test("anything else under api needs a session first", async () => {
  const r = await (await web(await makeHq(makeOffice()))).get("/api/people")
  expect(r.status).toBe(401)
  expect((r.json() as { error: string }).error).toBe("sign_in_required")
})
