/** The socat Claude Code's Linux sandbox runs: one in a system folder as it is; one elsewhere through a link in a
 *  private folder, with the folders it runs and loads from read in the sandbox; each checked first, and run once. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { type EmployeePermission, claudeStart } from "../../../src/runtime/sandbox/harness_profile.ts"
import { fenceIn, freshFolder, harnessRoot } from "../../../src/runtime/sandbox/harness_temp.ts"
import { UnsafeProfile } from "../../../src/runtime/sandbox/policy.ts"
import { SocatUnusable, lddLibraries, parseLdd, prepareSocat } from "../../../src/tools/claude/socat.ts"
import { tempDir } from "../../helpers.ts"

/** An employee's permission over a temp home, and a socat installed as conda-forge lays one out under that home:
 *  `<prefix>/bin/socat` linking to `socat1`, loading `$ORIGIN/../lib`. */
function layout(script = "#!/bin/sh\necho 'socat version 1.8'\n") {
  const root = fs.realpathSync(tempDir())
  const home = path.join(root, "home")
  const ws = path.join(root, "ws")
  const prefix = path.join(home, ".local/opt/socat")
  const [bin, lib] = [path.join(prefix, "bin"), path.join(prefix, "lib")]
  for (const dir of [path.join(home, ".opencorp"), ws, bin, lib]) fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
  fs.writeFileSync(path.join(bin, "socat1"), script, { mode: 0o755 })
  fs.symlinkSync("socat1", path.join(bin, "socat"))
  for (const so of ["libssl.so.3", "libreadline.so.8"]) fs.writeFileSync(path.join(lib, so), "", { mode: 0o644 })
  const temp = harnessRoot("claude", root)
  const permission = (fields: Partial<EmployeePermission> = {}): EmployeePermission => ({
    workspace: ws, gitRoot: null, writable: true, network: false, tmpdir: freshFolder(temp, "S1"), fence: fenceIn(temp),
    folders: [], home, officeHome: path.join(home, ".opencorp"), ...fields,
  })
  // What ldd says it loads, through the binary's folder as `$ORIGIN/../lib` resolves.
  const libraries = () => [path.join(bin, "../lib/libssl.so.3"), path.join(bin, "../lib/libreadline.so.8"), "/lib64/libc.so.6"]
  return { root, home, prefix, bin, lib, temp, permission, libraries }
}

test("a socat outside the system folders is linked, alone, into a private folder, and the sandbox reads its folder and its libraries' folder, exactly", () => {
  const { bin, lib, temp, home, permission, libraries } = layout()
  const p = permission()
  const got = prepareSocat(p, path.join(bin, "socat"), { root: temp, name: "S1.bin", libraries })
  expect(got.programs).toBe(path.join(temp, "S1.bin"))
  expect(fs.readdirSync(got.programs ?? "")).toEqual(["socat"])
  // A link to the checked real file, so its `$ORIGIN` is its own folder.
  expect(fs.readlinkSync(path.join(got.programs!, "socat"))).toBe(path.join(bin, "socat1"))
  expect(got.reads).toEqual([bin, lib, fs.realpathSync("/lib64")])
  const start = claudeStart({ ...p, programs: got.programs!, programReads: got.reads })
  const rules = (start.settings.sandbox as { filesystem: Record<string, string[]> }).filesystem
  expect(rules.allowRead.filter((dir) => dir.startsWith(home))).toEqual([bin, lib])
  expect(start.env.PATH!.split(":")[0]).toBe(got.programs ?? "")
})

test("a socat in a system folder on the harness PATH is left as it is", () => {
  const { bin, temp, permission, libraries } = layout()
  const got = prepareSocat(permission(), path.join(bin, "socat"), { root: temp, name: "S1.bin", libraries, system: [bin] })
  expect(got).toEqual({ programs: null, reads: [] })
  expect(fs.existsSync(path.join(temp, "S1.bin"))).toBe(false)
})

test("a socat whose library folder the employee may write, or others may change, is refused before it ever runs", () => {
  // It leaves a mark if it runs.
  const marker = path.join(fs.realpathSync(tempDir()), "ran")
  const { root, bin, lib, temp, permission, libraries } = layout(`#!/bin/sh\ntouch ${marker}\n`)
  const shared = path.join(root, "shared")
  fs.mkdirSync(shared, { mode: 0o755 })
  const planted = () => [path.join(shared, "libssl.so.3")]
  fs.writeFileSync(planted()[0]!, "", { mode: 0o644 })
  const writing = permission({ folders: [{ path: shared, access: "write" }] })
  expect(() => prepareSocat(writing, path.join(bin, "socat"), { root: temp, name: "S1.bin", libraries: planted })).toThrow(
    UnsafeProfile,
  )
  fs.chmodSync(lib, 0o777)
  expect(() => prepareSocat(permission(), path.join(bin, "socat"), { root: temp, name: "S1.bin", libraries })).toThrow(
    /others than the user may write/,
  )
  // Nor does one whose library ldd can't find.
  const missing = () => {
    throw new SocatUnusable("libssl.so.3 => not found")
  }
  fs.chmodSync(lib, 0o755)
  expect(() => prepareSocat(permission(), path.join(bin, "socat"), { root: temp, name: "S1.bin", libraries: missing })).toThrow(
    /not found/,
  )
  expect(fs.existsSync(marker)).toBe(false)
  // Once its folders pass, it runs.
  prepareSocat(permission(), path.join(bin, "socat"), { root: temp, name: "S1.bin", libraries })
  expect(fs.existsSync(marker)).toBe(true)
})

test("a socat that doesn't run, or that misses a library, is refused saying so, not as an opaque bridge error", () => {
  const broken = layout("#!/bin/sh\necho 'error while loading shared libraries: libssl.so.3' >&2\nexit 127\n")
  const run = () => prepareSocat(broken.permission(), path.join(broken.bin, "socat"), {
    root: broken.temp, name: "S1.bin", libraries: broken.libraries,
  })
  expect(run).toThrow(SocatUnusable)
  expect(run).toThrow(/doesn't run.*libssl/)
  const missing = layout()
  expect(() =>
    prepareSocat(missing.permission(), path.join(missing.bin, "socat"), {
      root: missing.temp, name: "S1.bin", libraries: () => { throw new SocatUnusable("libssl.so.3 => not found") },
    }),
  ).toThrow(/libssl.so.3 => not found/)
})

test("ldd's libraries are the files it resolves, none for a script", () => {
  const libs = lddLibraries("/bin/ls")
  expect(libs.some((lib) => /\/libc\.so\.\d/.test(lib))).toBe(true)
  for (const lib of libs) expect(path.isAbsolute(lib) && fs.existsSync(lib), lib).toBe(true)
  const { bin } = layout()
  expect(lddLibraries(path.join(bin, "socat1"))).toEqual([])
})

test("ldd's output is read strictly: a library it can't find, or one at a path with a space, refuses the socat", () => {
  const out = (lines: string[]) => lines.join("\n")
  expect(
    parseLdd(
      out([
        "\tlinux-vdso.so.1 (0x00007ffe)",
        "\tlibssl.so.3 => /opt/socat/bin/../lib/libssl.so.3 (0x00001527)",
        "\tlibc.so.6 => /lib64/libc.so.6 (0x00001527)",
        "\t/lib64/ld-linux-x86-64.so.2 (0x00001527)",
      ]),
      "/opt/socat/bin/socat1",
    ),
  ).toEqual(["/opt/socat/bin/../lib/libssl.so.3", "/lib64/libc.so.6", "/lib64/ld-linux-x86-64.so.2"])
  expect(() => parseLdd(out(["\tlibssl.so.3 => not found"]), "/opt/socat/bin/socat1")).toThrow(/can't load libssl.so.3/)
  expect(() => parseLdd(out(["\tlibssl.so.3 => /opt/my libs/libssl.so.3 (0x0001)"]), "/opt/socat/bin/socat1")).toThrow(
    /a space/,
  )
  expect(parseLdd("\tnot a dynamic executable", "/opt/socat/bin/socat1")).toEqual([])
})
