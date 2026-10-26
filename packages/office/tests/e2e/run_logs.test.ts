/** Run Logs on a real office: a chat is listed, its page has its turn's nodes with their kinds, and its records and
 *  download are shown as stored, a connection key the reply echoes included. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { ConnectionFile, Connections } from "../../src/chat/connections.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { waitFor } from "../helpers.ts"
import { Browser, folder, openOffice, URL_RE, waitListening } from "./helpers.ts"

const TIMEOUT = 240_000
const KEY = "conn-key-e2e-7c1d2b9a4f60"

test.todo(
  "a chat and its debrief in run logs",
  async () => {
    const office = await openOffice({ hq: { tcp: true, port: 0 } })
    const workspace = folder(path.join(office.root, "project"))
    await waitListening(office)
    const [, port, code] = (await office.opencorp(["pair", "--no-open"], { cwd: office.root })).stdout.match(URL_RE)!
    await new Connections(office.paths.office).put(
      "e2e",
      ConnectionFile.parse({ llm_config: { ...LLM_CONFIG, api_key: KEY }, env: office.llm.env() }),
    )
    office.llm.script({ content: `noted ${KEY}` })
    const sid = await office.startChat(await office.person("minh"), workspace)
    await office.prompt(sid, "remember this")
    await office.settled(sid, [`noted ${KEY}`])
    await office.post(`/sessions/${sid}/end`)
    await waitFor(async () => (await office.status(sid)) === "ended", { timeout: 40_000, what: `session ${sid} to end` })

    const browser = new Browser(`http://127.0.0.1:${port}`)
    expect((await browser.post("/api/pair", { code })).status).toBe(200)
    const runs = (await browser.get("/api/runs")).json().runs.filter((r: { session_id: string }) => r.session_id === sid)
    expect(runs).toHaveLength(1)
    const top = runs[0]
    expect([top.flow, top.status, top.driver]).toEqual(["chat", "finished", "ngocbh"])
    expect([top.children, top.children_total]).toEqual([[], 0])
    const head = (await browser.get(`/api/runs/${top.run_id}`)).json()
    expect(head.run.children).toEqual([])
    const nodes: { node_id: string; kind: string | null; status: string }[] = (
      await browser.get(`/api/runs/${top.run_id}/nodes`)
    ).json().nodes
    const replies = nodes.filter((n) => n.node_id.endsWith("/reply"))
    expect(replies.some((n) => n.status === "succeeded")).toBe(true)
    expect(replies.every((n) => n.kind === "agent")).toBe(true)
    expect(nodes.filter((n) => n.kind === null)).toEqual([])
    const events: { payload: unknown }[] = (await browser.get(`/api/runs/${top.run_id}/events`)).json().events
    expect(events.some((e) => JSON.stringify(e.payload).includes(`noted ${KEY}`))).toBe(true)
    const log = await browser.get(`/api/runs/${top.run_id}/log`)
    const stored = path.join(office.paths.runs, top.run_id, "log.jsonl")
    expect(log.status).toBe(200)
    expect(log.text).toBe(fs.readFileSync(stored, "utf8"))
  },
  TIMEOUT,
)
