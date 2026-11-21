/** Doctor's probe of Claude Code: a start as a session's, under an employee's permission in a fresh read-only folder,
 *  that reads the sign-in from `initialize` and sends no message. Every run is D4's fake. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { UnsafeProfile } from "../../../src/runtime/sandbox/policy.ts"
import { type FakeClaudeScript, installFakeClaude } from "../../../src/testing/fake_claude.ts"
import {
  ClaudeSandboxUnavailable,
  ClaudeSignedOut,
  ClaudeTooOld,
  nativeClaude,
} from "../../../src/tools/claude/claude.ts"
import { probeStart } from "../../../src/tools/claude/probe.ts"
import { tempDir } from "../../helpers.ts"

setDefaultTimeout(30_000)

/** A fake Claude Code only the user may change, a home and an office home, and where the harness folder goes. */
function setup(script: FakeClaudeScript = {}) {
  const root = fs.realpathSync(tempDir())
  const fake = installFakeClaude(path.join(root, "fake"), { version: "2.1.325", ...script })
  for (const dir of [path.join(root, "fake"), fake.bin]) fs.chmodSync(dir, 0o755)
  const home = path.join(root, "home")
  fs.mkdirSync(path.join(home, ".opencorp"), { recursive: true })
  const base = path.join(root, "tmp")
  fs.mkdirSync(base)
  const options = {
    claude: nativeClaude(fake.claude),
    env: { PATH: "/usr/bin:/bin", HOME: home },
    environ: {},
    home,
    officeHome: path.join(home, ".opencorp"),
    base,
  }
  const harness = path.join(base, `opencorp-${process.getuid!()}`, "claude")
  return { root, fake, options, harness }
}

test("doctor's probe starts claude as a session does, in a fixed read-only folder, sends no message, keeps no session, and removes its temp folder", async () => {
  const { fake, options, harness } = setup()
  const probed = await probeStart(options)
  expect(probed).toEqual({ error: null, log: path.join(harness, "doctor-claude.log") })
  const start = fake.log().find((e) => e.dir === "start")!
  const folder = path.join(harness, `doctor-${process.pid}`)
  // The same folder every run, so Claude Code's own record of the folders it ran in doesn't grow with each.
  expect(start.cwd).toBe(path.join(harness, "doctor-ws"))
  expect(start.flags).toMatchObject({
    "setting-sources": "",
    "strict-mcp-config": true,
    "permission-mode": "acceptEdits",
    "no-session-persistence": true,
  })
  const sandbox = start.flags!.settings.sandbox
  expect([sandbox.enabled, sandbox.failIfUnavailable]).toEqual([true, true])
  // Read-only: its folder is a write deny, and no edit tool may run.
  expect(sandbox.filesystem.denyWrite).toContain(path.join(harness, "doctor-ws"))
  expect(start.flags!.settings.permissions.deny).toContain("Edit")
  expect(start.env).toMatchObject({ TMPDIR: path.join(folder, "tmp"), CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" })
  const sent = fake.log().filter((e) => e.dir === "in").map((e) => e.msg!.type)
  expect(sent).toEqual(["control_request"])
  expect(fs.readdirSync(harness).sort()).toEqual(["doctor-claude.log", "doctor-ws", "fence"])
  expect(fs.readdirSync(path.join(harness, "doctor-ws"))).toEqual([])
  // Again, the same folder.
  expect((await probeStart(options)).error).toBeNull()
  expect(fake.log().filter((e) => e.dir === "start").map((e) => e.cwd)).toEqual([start.cwd, start.cwd])
})

test("a probe signed out, too old, or whose sandbox can't start says why, with the log", async () => {
  for (const [script, kind] of [
    [{ signed_out: true }, ClaudeSignedOut],
    [{ version: "2.1.300" }, ClaudeTooOld],
    [{ sandbox_unavailable: true }, ClaudeSandboxUnavailable],
  ] as const) {
    const { options, harness } = setup(script)
    const probed = await probeStart(options)
    expect(probed.error, JSON.stringify(script)).toBeInstanceOf(kind)
    expect(probed.log).toBe(path.join(harness, "doctor-claude.log"))
    expect(fs.readdirSync(harness).sort()).toEqual(["doctor-claude.log", "doctor-ws", "fence"])
  }
})

test("a probe of a claude others could change refuses before running it, and a dead probe's folder is swept", async () => {
  const { fake, options, harness } = setup()
  fs.mkdirSync(path.join(harness, "doctor-999999999"), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.dirname(harness), 0o700)
  fs.chmodSync(fake.bin, 0o775)
  const probed = await probeStart(options)
  expect(probed.error).toBeInstanceOf(UnsafeProfile)
  expect(probed.error!.message).toContain("others than the user may write")
  expect(fake.log().filter((e) => e.dir === "start")).toEqual([])
  expect(fs.readdirSync(harness).sort()).toEqual(["doctor-ws", "fence"])
  // So is one in a folder another person may write, or reached through a link there.
  fs.chmodSync(fake.bin, 0o755)
  const shared = path.dirname(fake.bin)
  expect((await probeStart({ ...options, othersWritable: [shared] })).error).toBeInstanceOf(UnsafeProfile)
  const link = path.join(path.dirname(shared), "claude-link")
  fs.symlinkSync(fake.claude, link)
  expect((await probeStart({ ...options, claude: { ...options.claude, found: link }, othersWritable: [path.dirname(link)] })).error).toBeInstanceOf(UnsafeProfile)
  expect(fake.log().filter((e) => e.dir === "start")).toEqual([])
})
