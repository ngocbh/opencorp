/** Each harness's private folder under /tmp: its sessions' fresh temp folders, the fence, and the sweep after a
 *  crash. Codex's own uses are tested with its threads (`tests/features/codex/thread.test.ts`). */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import {
  fenceIn,
  freshFolder,
  harnessRoot,
  removeFolder,
  sweepTemp,
} from "../../../src/runtime/sandbox/harness_temp.ts"
import { UnsafeProfile } from "../../../src/runtime/sandbox/policy.ts"
import { tempDir } from "../../helpers.ts"

test("each harness's folder is the user's own private folder under the base, apart from the other's", () => {
  const base = fs.realpathSync(tempDir())
  const claude = harnessRoot("claude", base)
  const codex = harnessRoot("codex", base)
  expect(claude).toBe(path.join(base, `opencorp-${process.getuid!()}`, "claude"))
  expect(codex).toBe(path.join(base, `opencorp-${process.getuid!()}`, "codex"))
  for (const dir of [path.dirname(claude), claude, codex]) {
    const stat = fs.lstatSync(dir)
    expect([stat.isDirectory(), stat.mode & 0o777]).toEqual([true, 0o700])
  }
  expect(harnessRoot("claude", base)).toBe(claude)
  // A link, or a folder others may read, is refused.
  const linked = fs.realpathSync(tempDir())
  fs.mkdirSync(path.join(linked, `opencorp-${process.getuid!()}`), { mode: 0o700 })
  fs.symlinkSync(fs.realpathSync(tempDir()), path.join(linked, `opencorp-${process.getuid!()}`, "claude"))
  expect(() => harnessRoot("claude", linked)).toThrow(UnsafeProfile)
  fs.chmodSync(claude, 0o750)
  expect(() => harnessRoot("claude", base)).toThrow(/isn't private/)
})

test("a session's folder is made fresh and private, and is removed even where a command left it unwritable", () => {
  const root = harnessRoot("claude", fs.realpathSync(tempDir()))
  const dir = freshFolder(root, "S1")
  expect(fs.lstatSync(dir).mode & 0o777).toBe(0o700)
  fs.mkdirSync(path.join(dir, "locked"))
  fs.writeFileSync(path.join(dir, "locked/f"), "x")
  fs.chmodSync(path.join(dir, "locked"), 0o500)
  expect(fs.readdirSync(freshFolder(root, "S1"))).toEqual([])
  removeFolder(root, "S1")
  expect(fs.existsSync(dir)).toBe(false)
  expect(() => freshFolder(root, "../S1")).toThrow()
  expect(() => freshFolder(root, "")).toThrow()
})

test("the fence is an empty file of the user's alone, made once", () => {
  const root = harnessRoot("claude", fs.realpathSync(tempDir()))
  const fence = fenceIn(root)
  expect(fence).toBe(path.join(root, "fence"))
  expect([fs.readFileSync(fence, "utf8"), fs.statSync(fence).mode & 0o777]).toEqual(["", 0o600])
  expect(fenceIn(root)).toBe(fence)
})

test("the sweep removes the stale folders it names and dead doctor probes', and says which harness failed", () => {
  const root = harnessRoot("claude", fs.realpathSync(tempDir()))
  fenceIn(root)
  for (const name of ["S1", "other", `doctor-${process.pid}`, "doctor-999999999"]) freshFolder(root, name)
  const lines: string[] = []
  sweepTemp(root, (name) => name === "S1", (line) => lines.push(line))
  expect(fs.readdirSync(root).sort()).toEqual([`doctor-${process.pid}`, "fence", "other"].sort())
  expect(lines).toEqual([])
})

test("the sweep removes a folder a copy left half made once the process making it is gone, and keeps one still being made", () => {
  const root = harnessRoot("codex", fs.realpathSync(tempDir()))
  for (const name of [`install-a.${process.pid}.part`, "install-b.999999999.part"]) freshFolder(root, name)
  sweepTemp(root, () => false, () => {})
  expect(fs.readdirSync(root)).toEqual([`install-a.${process.pid}.part`])
})
