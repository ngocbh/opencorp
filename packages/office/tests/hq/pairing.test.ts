/** One-time pairing codes: 128 bits, single use, 5 minutes, never logged, no failure throttle. */
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { inspect } from "node:util"
import { expect, onTestFinished, test } from "bun:test"
import { MAX_PENDING, PairCodes, TTL } from "../../src/hq/pairing.ts"
import { tempDir } from "../helpers.ts"

const T0 = new Date("2026-10-19T10:00:00Z")

/** A clock the test moves by setting `now`. */
class Clock {
  now = T0
  call = (): Date => this.now
}

const URL = (code: string): string => "http://127.0.0.1:49380/pair#" + code

/** Codes in `dir` with `clock`, logging into `lines`; closed when the current test finishes. */
function pairCodes(dir: string, clock = new Clock(), lines: string[] = []): PairCodes {
  const codes = new PairCodes(dir, { clock: clock.call, log: (line) => lines.push(line) })
  onTestFinished(() => codes.close())
  return codes
}

const MINT = { issuer: "ngocbh", url: URL, openFile: false }

test("a code is 128 bits and works once", async () => {
  const codes = pairCodes(tempDir())
  const minted = await codes.mint("ngocbh", MINT)
  expect(minted.code).toHaveLength(22)
  expect(Buffer.from(minted.code, "base64url")).toHaveLength(16)
  expect(minted.file).toBeNull()
  expect(minted.expiresAt).toEqual(new Date(T0.getTime() + TTL))
  const pending = codes.redeem(minted.code)
  expect([pending?.handle, pending?.issuer]).toEqual(["ngocbh", "ngocbh"])
  expect(codes.redeem(minted.code)).toBeNull()
})

test("a code expires after five minutes and its file goes", async () => {
  const dir = tempDir()
  const clock = new Clock()
  const codes = pairCodes(dir, clock)
  const minted = await codes.mint("ngocbh", { ...MINT, openFile: true })
  const file = minted.file!
  expect(path.dirname(file)).toBe(dir)
  expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  expect(fs.readFileSync(file, "utf8")).toContain(URL(minted.code))
  clock.now = new Date(T0.getTime() + TTL)
  codes.sweep()
  expect(fs.existsSync(file)).toBe(false)
  expect(codes.redeem(minted.code)).toBeNull()
})

test("using a code deletes its file", async () => {
  const codes = pairCodes(tempDir())
  const minted = await codes.mint("ngocbh", { ...MINT, openFile: true })
  codes.redeem(minted.code)
  expect(fs.existsSync(minted.file!)).toBe(false)
})

test("no file without a url", async () => {
  const dir = tempDir()
  const codes = pairCodes(dir)
  const minted = await codes.mint("ngocbh", { ...MINT, url: () => null, openFile: true })
  expect(minted.file).toBeNull()
  // Nothing written and no lock taken.
  expect(fs.readdirSync(dir)).toEqual([])
})

test("at most 16 pending and the oldest goes first", async () => {
  const codes = pairCodes(tempDir())
  const first = await codes.mint("ngocbh", { ...MINT, openFile: true })
  const rest = []
  for (let i = 0; i < MAX_PENDING; i++) rest.push(await codes.mint("ngocbh", MINT))
  expect(codes.redeem(first.code)).toBeNull()
  expect(fs.existsSync(first.file!)).toBe(false)
  expect(rest.every((m) => codes.redeem(m.code) !== null)).toBe(true)
})

test("many wrong codes never block the right one", async () => {
  const codes = pairCodes(tempDir())
  const minted = await codes.mint("ngocbh", MINT)
  for (let i = 0; i < 1000; i++) expect(codes.redeem(`wrong${i}`)).toBeNull()
  expect(codes.redeem(minted.code)).not.toBeNull()
})

test("close forgets every code and deletes the files", async () => {
  const dir = tempDir()
  const codes = pairCodes(dir)
  const minted = await codes.mint("ngocbh", { ...MINT, openFile: true })
  codes.close()
  expect(codes.redeem(minted.code)).toBeNull()
  // The folder's lock file stays after a write; no redirect or temp file may.
  expect(fs.readdirSync(dir).filter((name) => /^\.?pair-/.test(name))).toEqual([])
})

test("a code is never logged", async () => {
  const lines: string[] = []
  const codes = pairCodes(tempDir(), new Clock(), lines)
  const minted = await codes.mint("ngocbh", { ...MINT, openFile: true })
  codes.redeem(minted.code)
  codes.redeem(minted.code)
  const text = lines.join("\n")
  expect(text).toContain("pairing code")
  expect(text).not.toContain(minted.code)
})

test("remove leftovers deletes redirect and temp files only", () => {
  const dir = tempDir()
  const names = ["pair-0123abcd.html", ".pair-0123abcd.html.4242.tmp", ".lock", "other.txt", "pair-0123abcd.txt"]
  for (const name of names) fs.writeFileSync(path.join(dir, name), "x")
  pairCodes(dir).removeLeftovers()
  expect(fs.readdirSync(dir).sort()).toEqual([".lock", "other.txt", "pair-0123abcd.txt"])
  // A missing folder is fine.
  pairCodes(path.join(dir, "missing")).removeLeftovers()
})

test("its inspect and json show no key or code", async () => {
  const dir = tempDir()
  const codes = pairCodes(dir)
  const minted = await codes.mint("ngocbh", MINT)
  const key = createHash("sha256").update(minted.code).digest("hex")
  const shown = [inspect(codes, { showHidden: true, depth: 10 }), JSON.stringify(codes)]
  for (const text of shown) {
    expect(text).toContain("pending")
    expect(text).not.toContain(minted.code)
    expect(text).not.toContain(key)
  }
  expect(JSON.parse(JSON.stringify(codes))).toEqual({ officeDir: dir, pending: 1 })
})
