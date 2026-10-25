/** A run's open nodes from its worker's frames: every outcome frame ends a node, and only the deepest show;
 *  node kinds come from a flow's static nodes. */
import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { loadFlow } from "@ngocbh/yian"
import { kindOf, nodeKinds, OpenNodes, recordedKinds } from "../../src/runs/nodes.ts"
import { FLOW_BYTES, refresh, RunLogReader } from "../../src/runs/reader.ts"
import { tempDir } from "../helpers.ts"
import { LOOP_FLOW, realRun, runStarted, started } from "./helpers.ts"

/** Folds each `[name, data]` frame into `open`; returns whether each changed the open nodes. */
function frames(open: OpenNodes, ...pairs: [string, Record<string, unknown>][]): boolean[] {
  return pairs.map(([name, data]) => open.apply(name, data))
}

test("every outcome frame ends a node", () => {
  const n = new OpenNodes()
  const changed = frames(
    n,
    ["NodeStarted", { node_id: "chat" }], ["NodeExpanded", { node_id: "chat" }],
    ["NodeStarted", { node_id: "chat#0/route" }], ["NodeRouted", { node_id: "chat#0/route" }],
    ["NodeStarted", { node_id: "chat#0/reply" }],
    ["NodeFailed", { failure: { node_id: "chat#0/reply" } }],
    ["NodeSkipped", { node_id: "chat#0/exit_turn" }], ["StreamChunk", { node_id: "x" }],
  )
  expect(changed).toEqual([true, true, true, true, true, true, false, false])
  expect(n.current()).toEqual([])
})

test("a loop driver clone opens and ends like any node", () => {
  const n = new OpenNodes()
  frames(n, ["NodeStarted", { node_id: "chat~3" }])
  expect(n.current()).toEqual(["chat~3"])
  frames(n, ["NodeExpanded", { node_id: "chat~3" }], ["NodeStarted", { node_id: "chat#3/reply" }])
  expect(n.current()).toEqual(["chat#3/reply"])
  frames(
    n,
    ["NodeSucceeded", { node_id: "chat#3/reply" }], ["NodeStarted", { node_id: "chat~4" }],
    ["NodeSucceeded", { node_id: "chat~4" }],
  )
  expect(n.current()).toEqual([])
})

test("only the deepest open nodes show", () => {
  const n = new OpenNodes()
  frames(
    n,
    ["NodeStarted", { node_id: "chat" }], ["NodeStarted", { node_id: "chat#12/reply" }],
    ["NodeStarted", { node_id: "m" }], ["NodeStarted", { node_id: "m#0/a" }], ["NodeStarted", { node_id: "m#1/a" }],
    ["NodeStarted", { node_id: "l" }], ["NodeStarted", { node_id: "l~2" }], ["NodeStarted", { node_id: "l2" }],
  )
  expect(n.current()).toEqual(["chat#12/reply", "m#0/a", "m#1/a", "l~2", "l2"])
})

test("the set is capped and cleared", () => {
  const n = new OpenNodes({ cap: 2 })
  frames(n, ...[0, 1, 2].map((i): [string, Record<string, unknown>] => ["NodeStarted", { node_id: `m#${i}/a` }]))
  expect(n.current()).toEqual(["m#1/a", "m#2/a"])
  n.clear()
  expect(n.current()).toEqual([])
})

test("a woken node opens again after a clear", () => {
  const n = new OpenNodes()
  expect(frames(n, ["NodeStarted", { node_id: "a" }], ["NodeWaiting", { node_id: "a" }])).toEqual([true, false])
  expect(n.current()).toEqual(["a"])
  n.clear()
  expect(frames(n, ["NodeWoken", { node_id: "a" }])).toEqual([true])
  expect(n.current()).toEqual(["a"])
  frames(n, ["NodeSucceeded", { node_id: "a" }])
  expect(n.current()).toEqual([])
})

const CHAT_FLOW = `id: kinds
name: kinds
defs:
  turn:
    input:
      n: !int
    nodes:
      route:
        kind: case
        cases:
          - when: \${input.n > 0}
            then: reply
      reply:
        kind: agent
        input:
          n: \${input.n}
        output: str
        prompt: "\${n}"
    output:
      n: \${input.n + 1}
nodes:
  chat:
    kind: loop
    call: turn
    times: 2
    input:
      n: 0
output: \${chat.output.n}
`

test("node kinds come from the flows static nodes", async () => {
  const kinds = nodeKinds(await loadFlow(CHAT_FLOW, { sourceLabel: "kinds.yaml" }))
  expect(kindOf(kinds, "chat#12/reply")).toBe("agent")
  expect(kindOf(kinds, "chat~3")).toBe("loop")
  expect(kindOf(kinds, "chat#0/route")).toBe("case")
  expect(kindOf(kinds, "nope")).toBeNull()
  expect(kindOf(null, "chat")).toBeNull()
})

test("a recorded run names its node kinds", async () => {
  const { log, codeRoot } = await realRun(tempDir(), LOOP_FLOW)
  const options = { env: () => undefined, codeRoot }
  const kinds = await recordedKinds(log, options)
  expect([kindOf(kinds, "l"), kindOf(kinds, "l#1/__end__")]).toEqual(["loop", "end"])
  const reader = new RunLogReader()
  const index = await reader.index(log)
  const held = index.held
  const once = await reader.kinds(log, index, options)
  expect(once).toEqual(kinds)
  expect(await reader.kinds(log, index, options)).toBe(once!)
  expect(index.held - held).toBe([...once!.keys()].reduce((sum, nodePath) => sum + 64 + nodePath.length, 0))
  // A run start over FLOW_BYTES isn't compiled.
  const big = path.join(tempDir(), "big.jsonl")
  fs.writeFileSync(big, Buffer.concat([runStarted(0, { yianVersion: "0".repeat(FLOW_BYTES) }), started(1, "a")]))
  const bigIndex = await refresh(big, null)
  expect([bigIndex.startEnd! > FLOW_BYTES, await reader.kinds(big, bigIndex, options)]).toEqual([true, null])
})
