/** Asset credentials never reach a worker: scan every frame, the model's requests, and the run log. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { encode } from "../../src/worker/codec.ts"
import { fakeLlm } from "../chat/helpers.ts"
import { base, makeJob, makeRegistry, Recorder, recordFrames, runWorker } from "../worker/helpers.ts"
import { cluster, makeMonitor, TOKEN } from "./helpers.ts"

setDefaultTimeout(60_000)

const CALLS = [
  { name: "cluster_a__submit_job", arguments: { job: "train", partition: "gpu-small" } },
  { name: "cluster_a__submit_job", arguments: { job: "big", partition: "gpu-big" } },
  { name: "cluster_a__broken", arguments: {} },
]

test("no frame or model text holds a secret", async () => {
  const grants = [
    { who: "minh", can: ["submit_job"], where: { partition: ["gpu-small"] } },
    { who: "minh", can: ["broken"] },
  ]
  const { monitor, store: audit } = await makeMonitor({ "assets/cluster-a.yaml": cluster(grants) })
  const frames = recordFrames()
  const toolbox = monitor.tools("minh", { runId: "r1", sessionId: "s1" })
  const where = base()
  const fake = await fakeLlm()
  fake.script({ tool_calls: CALLS }, { content: "done" })
  const registry = makeRegistry()
  const sessionDir = path.join(where.root, "sessions", "s1")
  const rec = new Recorder({ tools: { toolbox } })
  const job = makeJob(where, "flows/tools.yaml", {}, rec)
  await runWorker(registry, job, rec, sessionDir, { env: fake.env() })

  expect(rec.outcome?.output).toBe("done")
  const modelText = encode(fake.requests())
  // The calls really ran, and their results reached the model.
  expect(modelText).toContain("ran train on gpu-small with [redacted]")
  expect(modelText).toContain('permission denied: cluster_a__submit_job: partition must be one of [\\"gpu-small\\"]')
  expect(modelText).toContain("error: RuntimeError: cannot reach host (token [redacted])")
  expect(frames.filter((f) => f.includes('"type":"tool_call"'))).toHaveLength(3)
  expect(frames.filter((f) => f.includes('"type":"tool_result"'))).toHaveLength(3)
  // ...and the secret is nowhere a worker or the model could see it.
  expect(frames.filter((f) => f.includes(TOKEN))).toEqual([])
  expect(modelText).not.toContain(TOKEN)
  expect(fs.readFileSync(job.log, "utf8")).not.toContain(TOKEN)
  const rows = audit.listAudit()
  expect(rows.map((r) => r.outcome).sort()).toEqual(["denied", "error", "ok"])
  expect(rows.filter((r) => (encode(r.args) + (r.detail ?? "")).includes(TOKEN))).toEqual([])
})
