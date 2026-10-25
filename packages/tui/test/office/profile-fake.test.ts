import { afterEach, expect, test } from "bun:test"
import { createFakeOffice, type FakeOffice } from "../../script/stub"
import { createOfficeClient } from "@opencorp/client"

let office: FakeOffice
afterEach(() => office?.stop())
const client = () => createOfficeClient({ socket: office.socket })

test("over_budget follows the profile budget", async () => {
  office = createFakeOffice({ profileMaxChars: 10 })
  expect((await client().profiles.get("minh")).over_budget).toBe(true)
  const p = await client().profiles.get("minh")
  expect((await client().profiles.put("minh", { text: "short", base_version: p.version })).over_budget).toBe(false)
})

test("the manager route answers a starting session and its first turn runs the prompt hooks", async () => {
  office = createFakeOffice()
  const prompts: string[] = []
  office.onPrompt((id, req) => prompts.push(`${id}:${req.text}`))
  const s = await client().profiles.manager("minh", { text: "Mention tests" })
  expect([s.kind, s.status, prompts]).toEqual(["profile_manager", "starting", [`${s.id}:Mention tests`]])
})
