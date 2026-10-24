/** Browser sessions: hashed, 30 days, checked against the person at HEAD on every request. */
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { parse, stringify } from "yaml"
import type { CompanyGit } from "../../src/company/git.ts"
import { Fingerprints, passwordFp, passwordFps } from "../../src/hq/sessions.ts"
import { git } from "../company/helpers.ts"
import { makeOffice } from "../daemon/helpers.ts"

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

/** Applies `changes` to `people/<handle>/person.yaml` in `company` and commits it; an undefined value drops its
 *  key. */
function handEdit(company: string, handle: string, changes: Record<string, unknown>): void {
  const file = path.join(company, "people", handle, "person.yaml")
  const data: Record<string, unknown> = { ...parse(fs.readFileSync(file, "utf8")), ...changes }
  for (const [key, value] of Object.entries(data)) if (value === undefined) delete data[key]
  fs.writeFileSync(file, stringify(data))
  git(company, "commit", "-qam", `edit ${handle}`)
}

test("password fp is 16 hex of the hash or empty", () => {
  expect(passwordFp(null)).toBe(sha256("").slice(0, 16))
  expect(passwordFp("$scrypt$x")).toBe(sha256("$scrypt$x").slice(0, 16))
})

test("fingerprints are loaded once per recent commit", async () => {
  const office = makeOffice()
  const loads: string[] = []
  const cache = new Fingerprints(office.git, (g: CompanyGit, sha: string) => {
    loads.push(sha)
    return passwordFps(g, sha)
  })
  const first = await office.git.readHead()
  await Promise.all([cache.at(first), cache.at(first)])
  handEdit(office.paths.company, "ngocbh", { title: "Boss" })
  const second = await office.git.readHead()
  for (const sha of [second, first, second]) await cache.at(sha)
  expect(loads).toEqual([first, second])
})

test("a failed fingerprint load is tried again", async () => {
  const office = makeOffice()
  let loads = 0
  const cache = new Fingerprints(office.git, (g: CompanyGit, sha: string) => {
    loads++
    return loads === 1 ? Promise.reject(new Error("git went away")) : passwordFps(g, sha)
  })
  const sha = await office.git.readHead()
  await expect(cache.at(sha)).rejects.toThrow("git went away")
  const humans = await cache.at(sha)
  expect(humans.fps.get("ngocbh")).toBe(passwordFp(null))
  expect(loads).toBe(2)
})
