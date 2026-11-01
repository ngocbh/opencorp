/** The Hq object an office carries. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import type { Office } from "../../src/daemon/office.ts"
import { Hq, attach } from "../../src/hq/core.ts"
import { officeApi } from "../../src/hq/version.ts"
import { HqSessionRecord, newId } from "../../src/store/store.ts"
import { shortDir, tempDir } from "../helpers.ts"
import { makeOffice } from "../daemon/helpers.ts"

const log = () => {}

/** Moves the office's dir to a short path, so hq.sock fits in sun_path. */
function shortOffice(office: Office): string {
  const dir = shortDir()
  ;(office.paths as { office: string }).office = dir
  return dir
}

test("hq reads its settings and reports health", () => {
  const office = makeOffice()
  const tmp = tempDir()
  fs.mkdirSync(office.paths.office, { recursive: true })
  fs.mkdirSync(path.join(tmp, "dist"))
  fs.writeFileSync(path.join(tmp, "dist", "build.json"), JSON.stringify({ build: "b1", api: "x" }))
  const settings = { tcp: false, app_dir: path.join(tmp, "dist") }
  fs.writeFileSync(path.join(office.paths.office, "hq.json"), JSON.stringify(settings))
  const hq = Hq.create(office, { log })
  expect(hq.config.tcp).toBe(false)
  const health = hq.health()
  expect(health.ok).toBe(true)
  expect(health.office.api).toBe(officeApi())
  expect(health.app?.build).toBe("b1")
})

test("hq shares the offices snapshot cache", () => {
  const office = makeOffice()
  expect(Hq.create(office, { log }).snapshots).toBe(office.snapshots)
})

test("attach puts hq on the office and prunes expired sessions at start", async () => {
  const office = makeOffice()
  office.store.addHqSession(
    new HqSessionRecord({
      id: newId(),
      person: "ngocbh",
      name: "web-abc123",
      label: "Safari",
      secretSha256: "a".repeat(64),
      passwordFp: "0".repeat(16),
      issuedBy: "ngocbh",
      via: "pair",
      createdAt: "2026-10-19T10:00:00.000Z",
      expiresAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
    }),
  )
  const hq = attach(office, { log, listen: false })
  expect(office.hq).toBe(hq)
  expect(hq.listen).toBe(false)
  await office.start()
  try {
    expect(office.store.listHqSessions()).toEqual([])
  } finally {
    await office.stop()
  }
})

test("mint without tcp has no url or file", async () => {
  const office = makeOffice()
  const hq = attach(office, { log, listen: false })
  const code = await hq.mint("ngocbh", { issuer: "ngocbh", openFile: true })
  expect(code.url).toBeNull()
  expect(code.open_file).toBeNull()
  expect(code.path).toStartWith("/pair#")
  expect(code.socket).toBe(path.join(office.paths.office, "hq.sock"))
  expect(code.port).toBe(hq.config.port)
  expect(hq.codes.redeem(code.path.split("#")[1]!)?.handle).toBe("ngocbh")
})

test("mint while listening writes a file that stopping deletes", async () => {
  const office = makeOffice()
  fs.mkdirSync(office.paths.office, { recursive: true, mode: 0o700 })
  const hq = attach(office, { log, listen: false })
  hq.boundPort = 49999
  await office.start()
  let file: string
  try {
    const code = await hq.mint("ngocbh", { issuer: "ngocbh", openFile: true })
    expect(code.url).toBe(`http://127.0.0.1:49999${code.path}`)
    expect(code.port).toBe(49999)
    file = path.resolve(office.paths.office, code.open_file!)
    expect(fs.readFileSync(file, "utf8")).toContain(code.url!)
  } finally {
    await office.stop()
  }
  expect(fs.existsSync(file)).toBe(false)
})

test("status before listening", async () => {
  const office = makeOffice()
  const hq = attach(office, { log, listen: false })
  hq.otherUsers = async () => []
  const status = await hq.status()
  expect(status.url).toBeNull()
  expect(status.tcp.listening).toBe(false)
  expect(status.health.office.api).toBeTruthy()
  expect(status.socket).toBe(path.join(office.paths.office, "hq.sock"))
  expect(status.socket_error).toBeNull()
})

test("status carries why hq sock isnt listening once", async () => {
  const office = makeOffice()
  const hq = attach(office, { log, listen: false })
  hq.otherUsers = async () => []
  hq.socketError = "AF_UNIX path too long"
  const status = await hq.status()
  expect(status.socket_error).toBe("AF_UNIX path too long")
  expect(status.warnings!.some((w) => w.includes("AF_UNIX"))).toBe(false)
})

test("status names ignored settings", async () => {
  const office = makeOffice()
  fs.mkdirSync(office.paths.office, { recursive: true })
  fs.writeFileSync(path.join(office.paths.office, "hq.json"), "{")
  const hq = attach(office, { log, listen: false })
  hq.otherUsers = async () => []
  expect((await hq.status()).warnings![0]).toStartWith(
    "settings ignored, so the web port stays off until hq.json is fixed (restart to apply): ",
  )
})

test("ignored settings are the only warning while tcp is off", async () => {
  const office = makeOffice()
  fs.mkdirSync(office.paths.office, { recursive: true })
  fs.writeFileSync(path.join(office.paths.office, "hq.json"), "{")
  const hq = attach(office, { log, listen: false })
  hq.otherUsers = async () => ["bob"]
  const warnings = (await hq.status()).warnings!
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toStartWith("settings ignored, so the web port stays off")
})

test("start deletes redirect files a crash left", async () => {
  const office = makeOffice()
  const dir = office.paths.office
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const left = [path.join(dir, "pair-0123456789abcdef.html"), path.join(dir, ".pair-0a.html.123.tmp")]
  const kept = path.join(dir, "hq.json")
  for (const file of left) fs.writeFileSync(file, "x")
  fs.writeFileSync(kept, "{}")
  attach(office, { log, listen: false })
  await office.start()
  try {
    expect(left.some((file) => fs.existsSync(file))).toBe(false)
    expect(fs.existsSync(kept)).toBe(true)
  } finally {
    await office.stop()
  }
})

test("status warns when tcp is on and others use the host", async () => {
  const office = makeOffice()
  const hq = attach(office, { log, listen: false })
  hq.otherUsers = async () => ["ann"]
  hq.config = { ...hq.config, tcp: true }
  expect((await hq.status()).warnings!.some((w) => w.includes("other users (ann)"))).toBe(true)
  hq.config = { ...hq.config, tcp: false }
  expect((await hq.status()).warnings).toEqual([])
})

test("a listening hq starts and stops its listeners with the office", async () => {
  const office = makeOffice()
  const dir = shortOffice(office)
  fs.writeFileSync(path.join(dir, "hq.json"), JSON.stringify({ tcp: false }))
  const hq = attach(office, { log })
  await office.start()
  try {
    expect(hq.listeners).not.toBeNull()
    expect(fs.existsSync(hq.socket)).toBe(true)
  } finally {
    await office.stop()
  }
  expect(fs.existsSync(hq.socket)).toBe(false)
})

test("stop forgets the codes even when the listeners fail to stop", async () => {
  const office = makeOffice()
  const dir = shortOffice(office)
  fs.writeFileSync(path.join(dir, "hq.json"), JSON.stringify({ tcp: false }))
  const hq = attach(office, { log })
  await office.start()
  const listeners = hq.listeners!
  const realStop = listeners.stop.bind(listeners)
  try {
    await hq.mint("ngocbh", { issuer: "ngocbh", openFile: false })
    listeners.stop = async () => {
      throw new Error("boom")
    }
    expect(hq.codes.toJSON().pending).toBe(1)
    await expect(hq.stop()).rejects.toThrow("boom")
    expect(hq.codes.toJSON().pending).toBe(0)
  } finally {
    await realStop()
    await office.stop()
  }
})
