/** The worker's markdown store: each read and write is a request the office answers from its own store. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { FileMarkdownStore, type MarkdownStore, MarkdownVersionMismatch } from "@ngocbh/yian"
import { BaseHandlers } from "../../src/worker/rpc.ts"
import { RemoteMarkdownStore } from "../../src/worker/remote_store.ts"
import { tempDir } from "../helpers.ts"
import { officeEnd } from "./helpers.ts"

/** An office store at `profile.md` holding `# Minh\n`, and the worker's store over it. */
async function stores(): Promise<{ dir: string; local: FileMarkdownStore; remote: RemoteMarkdownStore }> {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, "profile.md"), "# Minh\n")
  const local = new FileMarkdownStore(path.join(dir, "profile.md"))
  const remote = new RemoteMarkdownStore(await officeEnd(new BaseHandlers({ stores: { profile: local } })), "profile")
  return { dir, local, remote }
}

/** What `promise` rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection")
    },
    (error: unknown) => error,
  )
}

test("it is a markdown store", async () => {
  const { remote } = await stores()
  const store: MarkdownStore = remote
  expect(typeof store.read).toBe("function")
  expect(typeof store.write).toBe("function")
})

test("read and write round trip", async () => {
  const { local, remote } = await stores()
  const [text, version] = await remote.read()
  expect([text, version]).toEqual([...(await local.read())])
  const fresh = await remote.write("# Minh\nTerse.\n", { baseVersion: version })
  expect(await remote.read()).toEqual(["# Minh\nTerse.\n", fresh])
  expect([...(await local.read())]).toEqual(["# Minh\nTerse.\n", fresh])
  expect(await remote.read(version)).toEqual(["# Minh\n", version])
})

test("an unknown version is a range error", async () => {
  const { remote } = await stores()
  const error = await rejection(remote.read("sha256:" + "0".repeat(64)))
  expect(error).toBeInstanceOf(RangeError)
  expect((error as Error).message).toContain("unknown document version")
})

test("a stale base is a mismatch with both versions", async () => {
  const { local, remote } = await stores()
  const [, old] = await remote.read()
  const current = await local.write("changed\n", { baseVersion: old })
  const error = await rejection(remote.write("mine\n", { baseVersion: old }))
  expect(error).toBeInstanceOf(MarkdownVersionMismatch)
  const { expected, current: now } = error as MarkdownVersionMismatch
  expect([expected, now]).toEqual([old, current])
})

test("provenance arrives as json", async () => {
  const { dir, remote } = await stores()
  const [, version] = await remote.read()
  await remote.write("x\n", { baseVersion: version, provenance: { run_id: "r1", frame: ["a", 1n], big: 2n ** 64n } })
  const lines = fs.readFileSync(path.join(dir, ".profile.md.writes.jsonl"), "utf8").split("\n").filter(Boolean)
  expect(lines).toHaveLength(1)
  // The line's own text: JSON.parse would round 2^64.
  expect(lines[0]).toContain('"provenance": {"big": 18446744073709551616, "frame": ["a", 1], "run_id": "r1"}')
})

test("an undecodable document is a range error", async () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, "profile.md"), Buffer.from([0xff, 0xfe]))
  const profile = new FileMarkdownStore(path.join(dir, "profile.md"))
  const rpc = await officeEnd(new BaseHandlers({ stores: { profile } }))
  const error = await rejection(new RemoteMarkdownStore(rpc, "profile").read())
  expect(error).toBeInstanceOf(RangeError)
  expect(Object.hasOwn(error as object, "code")).toBe(false)
})

test("any other failure is a system error", async () => {
  const { remote } = await stores()
  const error = await rejection(new RemoteMarkdownStore(remote.rpc, "notes").read())
  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({ code: "EIO", syscall: "read", message: "no store named 'notes'" })
})

test("an invalid reply is a range error", async () => {
  const refusing: MarkdownStore = {
    read: () => ["", "v0"] as const,
    write: () => {
      throw new TypeError("text must be a string")
    },
  }
  const rpc = await officeEnd(new BaseHandlers({ stores: { profile: refusing } }))
  const error = await rejection(new RemoteMarkdownStore(rpc, "profile").write("x", { baseVersion: "v0" }))
  expect(error).toBeInstanceOf(RangeError)
  expect(Object.hasOwn(error as object, "code")).toBe(false)
  expect((error as Error).message).toBe("text must be a string")
})

test("a closed channel is a system error", async () => {
  const { remote } = await stores()
  remote.rpc.channel.close()
  const error = await rejection(remote.read())
  expect(error).toMatchObject({ code: "EIO", syscall: "read" })
})
