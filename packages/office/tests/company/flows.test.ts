/** Loading company flows confined to the repo (Python's `tests/company/test_flows.py`). */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { LoadError } from "@ngocbh/yian"
import { expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { loadConfined, MAX_FLOW_FILE } from "../../src/company/flows.ts"
import { MAX_FILE } from "../../src/company/source.ts"
import { shortDir, tempDir } from "../helpers.ts"
import { CHAT, CHILD, company, leafFlow, makeCompany, parentFlow, usesFlow } from "./helpers.ts"

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
  await expect(load).rejects.toBeInstanceOf(LoadError)
  await expect(load).rejects.toThrow('uses: ref pinned echo@2 but the resolved file declares version: "1"')
})

test("a uses: child loads under the repo root, so its CODE outside the repo is refused", async () => {
  // Each nested load passes the root itself; yian would also hold the child's CODE to the parent's.
  const outside = path.join(tempDir(), "fn.ts")
  fs.writeFileSync(outside, 'export function fn(): string {\n  return "out"\n}\n')
  const root = makeCompany({ "shared/flows/main.yaml": usesFlow("main", ["coded"]) })
  const code = path.relative(path.join(root, "shared/flows"), outside)
  const coded = `id: coded\nname: coded\nnodes:\n  prep:\n    kind: code\n    code: ${code}:fn\n    output: str\n`
  fs.writeFileSync(path.join(root, "shared/flows/coded.yaml"), `${coded}output: \${prep.output}\n`)
  const load = loadConfined(root, path.join(root, "shared/flows/main.yaml"))
  await expect(load).rejects.toBeInstanceOf(LoadError)
  await expect(load).rejects.toThrow(/outside/)
})

test("a flow named with two leading dots inside the repo loads", async () => {
  const root = makeCompany({ "shared/flows/..x.yaml": CHAT })
  expect((await loadConfined(root, path.join(root, "shared/flows/..x.yaml"))).name).toBe("chat")
})

test("a flow whose yaml the office cant read is refused even if yian loads it", async () => {
  // The office's reader refuses merge cycles that yian accepts, so system.paths can't be checked.
  const flows = [
    CHAT + "system:\n  paths: [lib]\nx-m: &m {<<: *m}\n",
    CHAT + "system: &s {<<: *s, paths: [lib]}\n",
  ]
  for (const flow of flows) {
    const root = makeCompany({ "shared/flows/chat.yaml": flow })
    const load = loadConfined(root, path.join(root, "shared/flows/chat.yaml"))
    await expect(load).rejects.toBeInstanceOf(RangeError)
    await expect(load).rejects.toThrow(/system.paths can't be checked/)
  }
})

/** `text` (ASCII) padded with `#PADPAD...` comment lines to exactly `size` bytes. */
function padded(text: string, size: number): string {
  let out = text
  while (out.length < size) {
    const room = size - out.length
    out += room < 9 ? "#".repeat(room - 1) + "\n" : "#PADPAD" + "x".repeat(Math.min(room, 1024) - 8) + "\n"
  }
  return out
}

/** Loads `file` under `root` in a child bun, with `env` added and every `fs.openSync` of a flow counted; the
 *  child is killed after 10 s, so a load that blocks can't hang the test. Returns its exit status and output. */
function loadInChild(root: string, file: string, env: Record<string, string> = {}) {
  const flows = path.resolve(import.meta.dir, "../../src/company/flows.ts")
  const script = `
    import fs from "node:fs"
    const { loadConfined } = await import(${JSON.stringify(flows)})
    const opens = []
    const open = fs.openSync
    fs.openSync = (p, ...rest) => { if (String(p).endsWith(".yaml")) opens.push(String(p)); return open(p, ...rest) }
    let error = null
    try { await loadConfined(process.argv[1], process.argv[2]) } catch (e) { error = e instanceof Error ? e.message : String(e) }
    console.log(JSON.stringify({ error, opens }))
  `
  const result = spawnSync(
    process.execPath,
    ["--no-install", "--no-env-file", "--config=/dev/null", "-e", script, root, file],
    { timeout: 10_000, killSignal: "SIGKILL", encoding: "utf8", env: { ...process.env, ...env } },
  )
  const out = result.status === 0 ? JSON.parse(result.stdout) as { error: string | null; opens: string[] } : null
  return { status: result.status, stderr: result.stderr, error: out?.error ?? null, opens: out?.opens ?? [] }
}

/** How many of `spy`'s calls opened a path ending in `suffix`. */
function opened(spy: { mock: { calls: unknown[][] } }, suffix: string): number {
  return spy.mock.calls.filter(([p]) => String(p).endsWith(suffix)).length
}

test("a flow over the size limit is refused without its content in the message", async () => {
  const root = makeCompany({ "shared/flows/chat.yaml": padded(CHAT, MAX_FLOW_FILE + 1) })
  const load = loadConfined(root, path.join(root, "shared/flows/chat.yaml"))
  await expect(load).rejects.toBeInstanceOf(RangeError)
  const error = await load.catch((e: Error) => e)
  expect((error as Error).message).toBe("shared/flows/chat.yaml is over the 1 MiB flow size limit")
})

test("a flow of exactly the size limit loads", async () => {
  const root = makeCompany({ "shared/flows/chat.yaml": padded(CHAT, MAX_FLOW_FILE) })
  expect((await loadConfined(root, path.join(root, "shared/flows/chat.yaml"))).name).toBe("chat")
})

test("a child that grows past the size limit after its stat is refused", async () => {
  const root = makeCompany({
    "shared/flows/chat.yaml": parentFlow("echo"),
    "shared/flows/echo.yaml": padded(CHILD, MAX_FLOW_FILE + 10),
  })
  const real = fs.fstatSync
  // The stat sees a small file, as if the file grew between the stat and the read.
  const fstat = spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
    const stats = real(fd)
    return Object.assign(stats, { size: Math.min(stats.size, 100) })
  }) as typeof fs.fstatSync)
  try {
    await expect(loadConfined(root, path.join(root, "shared/flows/chat.yaml")))
      .rejects.toThrow(/shared\/flows\/echo\.yaml is over the 1 MiB flow size limit/)
  } finally {
    fstat.mockRestore()
  }
})

test("a FIFO child is refused without blocking", () => {
  const root = makeCompany({ "shared/flows/chat.yaml": parentFlow("echo") })
  expect(spawnSync("mkfifo", [path.join(root, "shared/flows/echo.yaml")]).status).toBe(0)
  const result = loadInChild(root, path.join(root, "shared/flows/chat.yaml"))
  expect(result.status).toBe(0) // null when the child was killed
  expect(result.error).toMatch(/shared\/flows\/echo\.yaml is not a regular file/)
})

test("a directory child is refused as not a regular file", async () => {
  const root = makeCompany({ "shared/flows/chat.yaml": parentFlow("echo") })
  fs.mkdirSync(path.join(root, "shared/flows/echo.yaml"))
  await expect(loadConfined(root, path.join(root, "shared/flows/chat.yaml")))
    .rejects.toThrow(/shared\/flows\/echo\.yaml is not a regular file/)
})

test("a socket child is refused as not a regular file", async () => {
  const root = makeCompany({ "shared/flows/chat.yaml": parentFlow("echo") }, shortDir())
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(path.join(root, "shared/flows/echo.yaml"), resolve))
  try {
    const error = await loadConfined(root, path.join(root, "shared/flows/chat.yaml")).catch((e: Error) => e)
    expect((error as Error).message).toMatch(/shared\/flows\/echo\.yaml is not a regular file/)
    expect((error as Error).message).not.toContain(root)
    expect((error as Error).message).not.toContain(fs.realpathSync(root))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("a missing uses: child is named repo relative", async () => {
  const root = makeCompany({ "shared/flows/chat.yaml": parentFlow("echo") })
  const error = await loadConfined(root, path.join(root, "shared/flows/chat.yaml")).catch((e: Error) => e)
  expect((error as Error).message).toMatch(/shared\/flows\/echo\.yaml does not exist/)
  expect((error as Error).message).not.toContain(fs.realpathSync(root))
  expect((error as Error).message).not.toContain("ENOENT")
})

test.skipIf(process.getuid?.() === 0)("an unreadable child names its errno, repo relative", async () => {
  const root = makeCompany({ "shared/flows/chat.yaml": parentFlow("echo"), "shared/flows/echo.yaml": CHILD })
  const echo = path.join(root, "shared/flows/echo.yaml")
  fs.chmodSync(echo, 0)
  try {
    const error = await loadConfined(root, path.join(root, "shared/flows/chat.yaml")).catch((e: Error) => e)
    expect((error as Error).message).toMatch(/shared\/flows\/echo\.yaml can't be opened \(EACCES\)/)
    expect((error as Error).message).not.toContain(fs.realpathSync(root))
  } finally {
    fs.chmodSync(echo, 0o644)
  }
})

test("a child that grows after its stat but stays under the limit is read in full", async () => {
  const root = makeCompany({ "shared/flows/chat.yaml": parentFlow("echo"), "shared/flows/echo.yaml": CHILD })
  const real = fs.fstatSync
  // The stat sees 10 bytes, too few to load, so a read cut to the stat's size would fail.
  const fstat = spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
    const stats = real(fd)
    return Object.assign(stats, { size: Math.min(stats.size, 10) })
  }) as typeof fs.fstatSync)
  try {
    expect((await loadConfined(root, path.join(root, "shared/flows/chat.yaml"))).name).toBe("chat")
  } finally {
    fstat.mockRestore()
  }
})

test("the flow size limit is the source view's file limit", () => {
  // Every flow that runs can then be viewed in HQ.
  expect(MAX_FLOW_FILE).toBe(MAX_FILE)
})

test("a diamond of uses: loads each file once", async () => {
  const files: Record<string, string> = { "shared/flows/l4.yaml": leafFlow("l4") }
  for (let i = 0; i < 4; i++) files[`shared/flows/l${i}.yaml`] = usesFlow(`l${i}`, [`l${i + 1}`, `l${i + 1}`])
  const root = makeCompany(files)
  const open = spyOn(fs, "openSync")
  try {
    expect((await loadConfined(root, path.join(root, "shared/flows/l0.yaml"))).name).toBe("l0")
    expect([0, 1, 2, 3, 4].map((i) => opened(open, `/l${i}.yaml`))).toEqual([1, 1, 1, 1, 1])
  } finally {
    open.mockRestore()
  }
})

test("a cycle through a child imported twice is still a cycle", async () => {
  const root = makeCompany({
    "shared/flows/l0.yaml": usesFlow("l0", ["l1", "l1"]),
    "shared/flows/l1.yaml": usesFlow("l1", ["l0"]),
  })
  await expect(loadConfined(root, path.join(root, "shared/flows/l0.yaml")))
    .rejects.toThrow(/flow-reference cycle at shared\/flows\/l0\.yaml/)
})

test("a pinned version is checked against a child already loaded for another alias", async () => {
  const root = makeCompany({
    "shared/flows/chat.yaml": usesFlow("chat", ["echo", "echo@2"]),
    "shared/flows/echo.yaml": leafFlow("echo").replace("name: echo", "name: echo\nversion: '1'"),
  })
  const open = spyOn(fs, "openSync")
  try {
    await expect(loadConfined(root, path.join(root, "shared/flows/chat.yaml"))).rejects.toThrow(/version/)
    expect(opened(open, "/echo.yaml")).toBe(1)
  } finally {
    open.mockRestore()
  }
})

test("a child already loaded is held to the uses: depth limit where it is imported again", () => {
  // main -> s -> t -> u is 3 files deep; main -> d1 -> d2 -> t -> u is 4, past the limit of 3.
  const root = makeCompany({
    "shared/flows/main.yaml": usesFlow("main", ["s", "d1"]),
    "shared/flows/s.yaml": usesFlow("s", ["t"]),
    "shared/flows/t.yaml": usesFlow("t", ["u"]),
    "shared/flows/u.yaml": leafFlow("u"),
    "shared/flows/d1.yaml": usesFlow("d1", ["d2"]),
    "shared/flows/d2.yaml": usesFlow("d2", ["t"]),
  })
  // yian reads its limits once per process, so the load runs in a child with its own.
  const result = loadInChild(root, path.join(root, "shared/flows/main.yaml"), { YIAN_MAX_CALL_NESTING: "3" })
  expect(result.status).toBe(0)
  expect(result.error).toMatch(/past the call nesting limit of 3/)
  expect(result.opens.filter((p) => p.endsWith("/t.yaml"))).toHaveLength(1)
})
