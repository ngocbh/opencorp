/** The replay: what a run of reach.sh means, running it, and `reach_hq`, the flow that runs it on every visit. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { classify, type Reached, runReach, runScript } from "../../src/reach/replay.ts"
import type { ReachPaths } from "../../src/reach/paths.ts"
import type { Ran } from "../../src/reach/ssh.ts"
import { DEFAULT_PORT, sha256, writeAccess } from "../../src/reach/state.ts"
import { writePrivate } from "../../src/secrets.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { fakeLlm } from "../chat/helpers.ts"
import { fakeHome, reachCtx } from "./helpers.ts"

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

/** Writes `body` as `<home>/hq/reach.sh` (0600) and resolves to its path. */
function writeScript(file: string, body: string): string {
  fs.writeFileSync(file, body, { mode: 0o600 })
  return file
}

test("reach.sh runs with only our env, stdin from /dev/null, in the hq folder, its stderr to the owner", async () => {
  const { dir, fake } = fakeHome()
  const echoed: string[] = []
  const ctx = await reachCtx(dir, fake, {
    env: { PATH: "/usr/bin:/bin", HOME: dir, SSH_AUTH_SOCK: path.join(dir, "agent"), SECRET: "x" },
    echo: (t) => void echoed.push(t),
  })
  const script = writeScript(
    ctx.paths.script,
    [
      "env | cut -d= -f1 | sort >&2",
      "[ -t 0 ] || echo nostdin >&2",
      'echo "cwd=$(pwd)" >&2',
      `printf '%s\\n' '${JSON.stringify(SPEC)}'`,
      "",
    ].join("\n"),
  )
  const got = await runScript(script, ctx)
  expect(got).toEqual({ outcome: "ok", spec: SPEC, detail: "" })
  const lines = echoed.join("").split("\n").filter((l) => l !== "")
  const names = lines.filter((l) => /^[A-Z_][A-Z0-9_]*$/.test(l) && !["PWD", "SHLVL", "_"].includes(l))
  expect(names).toEqual(["HOME", "OPENCORP_SSH_CONFIG", "OPENCORP_SSH_STATUS", "PATH", "SSH_AUTH_SOCK"])
  expect(lines).toContain("nostdin")
  expect(lines).toContain(`cwd=${ctx.paths.dir}`)
})

test("a 255 inside a pipeline in reach.sh is couldn't connect", async () => {
  const { dir, fake } = fakeHome({ login: "refuse" })
  const ctx = await reachCtx(dir, fake)
  const script = writeScript(ctx.paths.script, `set -eu\nssh x true | cat\nprintf '%s\\n' '${JSON.stringify(SPEC)}'\n`)
  const got = await runScript(script, ctx)
  expect(got.outcome).toBe("unreachable")
  expect(got.detail).toContain("Permission denied")
})

/** Writes `body` as the approved reach.sh: the script and its sha256 in access.json. */
async function approved(paths: ReachPaths, body: string): Promise<void> {
  await writePrivate(paths.script, body)
  await writePrivate(paths.approved, body)
  await writeAccess(paths, {
    port: DEFAULT_PORT,
    sha256: sha256(body),
    learned_at: "2026-11-11T10:00:00.000Z",
    last_used_at: null,
    signed_in_at: null,
  })
}

test("a replay makes no model call even with a provider file next to it", async () => {
  const llm = await fakeLlm()
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  await writePrivate(ctx.paths.provider, JSON.stringify({ llm_config: LLM_CONFIG, env: llm.env() }))
  const spec = { ...SPEC, port: 2222, env: { OPENCORP_HOME: "/h/o" } }
  await approved(ctx.paths, `printf '%s\\n' '${JSON.stringify(spec)}'\n`)
  expect(await runReach(ctx)).toEqual({ outcome: "ok", spec, detail: "" })
  expect(llm.requests()).toEqual([])
})

test("a replay runs no reach.sh whose sha256 isn't the approved one", async () => {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  const marker = path.join(dir, "ran")
  await approved(ctx.paths, `printf '%s\\n' '${JSON.stringify(SPEC)}'\n`)
  await writePrivate(ctx.paths.script, `touch '${marker}'\nprintf '%s\\n' '${JSON.stringify(SPEC)}'\n`)
  const got = await runReach(ctx)
  expect(got).toEqual({ outcome: "broken", detail: "reach.sh isn't the approved one" })
  expect(fs.existsSync(marker)).toBe(false)
})

test("a replay with no access.json yet is broken and runs nothing", async () => {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  const marker = path.join(dir, "ran")
  await writePrivate(ctx.paths.script, `touch '${marker}'\n`)
  expect((await runReach(ctx)).outcome).toBe("broken")
  expect(fs.existsSync(marker)).toBe(false)
})
