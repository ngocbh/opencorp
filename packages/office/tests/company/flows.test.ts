/** Loading company flows confined to the repo (Python's `tests/company/test_flows.py`). */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { loadConfined, MAX_FLOW_FILE } from "../../src/company/flows.ts"
import { MAX_FILE } from "../../src/company/source.ts"
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

test("the flow size limit is the source view's file limit", () => {
  // Every flow that runs can then be viewed in HQ.
  expect(MAX_FLOW_FILE).toBe(MAX_FILE)
})
