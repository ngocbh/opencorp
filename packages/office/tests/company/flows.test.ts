/** Loading company flows confined to the repo (Python's `tests/company/test_flows.py`). */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { loadConfined } from "../../src/company/flows.ts"
import { tempDir } from "../helpers.ts"
import { CHAT, CHILD, company, makeCompany, parentFlow } from "./helpers.ts"

setDefaultTimeout(30_000)

test("root need not be resolved", async () => {
  const tmp = tempDir()
  const link = path.join(tmp, "link")
  fs.symlinkSync(company(tmp), link)
  const flow = await loadConfined(link, path.join(link, "people/minh/../../shared/flows/chat.yaml"))
  expect(flow.name).toBe("chat")
})

test("cross file cycle is refused", async () => {
  const root = makeCompany({
    "shared/flows/a.yaml": parentFlow("b"),
    "shared/flows/b.yaml": parentFlow("a").replace("id: chat", "id: b"),
  })
  const load = loadConfined(root, path.join(root, "shared/flows/a.yaml"))
  await expect(load).rejects.toBeInstanceOf(RangeError)
  await expect(load).rejects.toThrow(/cycle/)
})

test("pinned version is checked", async () => {
  const root = makeCompany({
    "shared/flows/chat.yaml": parentFlow("echo@2"),
    "shared/flows/echo.yaml": CHILD.replace("id: echo", "id: echo\nversion: '1'"),
  })
  const load = loadConfined(root, path.join(root, "shared/flows/chat.yaml"))
  await expect(load).rejects.toBeInstanceOf(RangeError)
  await expect(load).rejects.toThrow(/version/)
})

test("a flow named with two leading dots inside the repo loads", async () => {
  const root = makeCompany({ "shared/flows/..x.yaml": CHAT })
  expect((await loadConfined(root, path.join(root, "shared/flows/..x.yaml"))).name).toBe("chat")
})
