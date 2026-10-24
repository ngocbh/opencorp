/** The run routes: a 501 stub until the run views land. */
import { expect, test } from "bun:test"
import { makeOffice, request, served } from "./helpers.ts"

test("every runs route answers 501 not implemented", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const cases: [string, string][] = [
    ["/runs", "/runs"],
    ["/runs/R1", "/runs/:id"],
    ["/runs/R1/nodes", "/runs/:id/nodes"],
    ["/runs/R1/events", "/runs/:id/events"],
    ["/runs/R1/events/3", "/runs/:id/events/:seq"],
    ["/runs/R1/log", "/runs/:id/log"],
  ]
  for (const [target, pattern] of cases) {
    const r = await request(sock, "GET", target)
    expect(r.status).toBe(501)
    expect(r.json()).toEqual({ error: "not_implemented", message: `GET ${pattern} is not implemented yet` })
  }
})
