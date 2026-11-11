/** The replay: what a run of reach.sh means, running it, and `reach_hq`, the flow that runs it on every visit. */
import { expect, setDefaultTimeout, test } from "bun:test"
import { classify, type Reached } from "../../src/reach/replay.ts"
import type { Ran } from "../../src/reach/ssh.ts"

setDefaultTimeout(30_000)

const SPEC = { host: "node1", jump: ["login1"], opencorp: "/o/opencorp" }
const ran = (over: Partial<Ran>): Ran => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...over })

const ROWS: [string, Ran, number[], Partial<Reached>][] = [
  ["0 with a good spec after a banner", ran({ stdout: `Welcome\n${JSON.stringify(SPEC)}\n` }), [0], { outcome: "ok", spec: SPEC }],
  ["0 after an ssh that exited 255", ran({ stdout: JSON.stringify(SPEC) }), [255, 0], { outcome: "unreachable" }],
  ["1 after an ssh that exited 255", ran({ code: 1, stderr: "login1: Permission denied\n" }), [255], { outcome: "unreachable", detail: "login1: Permission denied" }],
  ["255", ran({ code: 255 }), [], { outcome: "unreachable", detail: "ssh exited 255" }],
  ["out of time", ran({ code: 143, timedOut: true }), [], { outcome: "unreachable", detail: "reach.sh didn't finish within 5 minutes" }],
  ["3", ran({ code: 3, stderr: "squeue: checking\nno job running\n" }), [], { outcome: "no_office", detail: "no job running" }],
  ["0 with a bad spec", ran({ stdout: JSON.stringify({ ...SPEC, host: "-oProxyCommand=x" }) }), [0], { outcome: "broken" }],
  ["0 with no JSON", ran({ stdout: "hello\n" }), [0], { outcome: "broken" }],
  ["2", ran({ code: 2, stderr: "usage\n" }), [], { outcome: "broken", detail: "reach.sh exited 2: usage" }],
]

test.each(ROWS)("a reach.sh run is classified [%s]", (_label, r, statuses, want) => {
  const got = classify(r, statuses)
  expect(got).toMatchObject(want)
  if (got.outcome !== "ok") expect(got).not.toHaveProperty("spec")
  if (got.outcome === "broken" && want.detail === undefined) expect(got.detail).toStartWith("reach.sh printed a spec that isn't valid:")
})
