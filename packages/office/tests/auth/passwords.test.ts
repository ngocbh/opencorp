/** Passwords as salted scrypt hashes in PHC form, checked within fixed bounds. */
import crypto from "node:crypto"
import { expect, test } from "bun:test"
import { Person } from "@opencorp/protocol"
import { DUMMY_HASH, MIN_LENGTH, checkPassword, hashPassword, passwordProblem } from "../../src/auth/passwords.ts"

const PHC = /^\$scrypt\$ln=([0-9]+),r=([0-9]+),p=([0-9]+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/

function b64(data: Buffer): string {
  return data.toString("base64").replace(/=+$/, "")
}

test("a hash checks its password and no other", async () => {
  const phc = await hashPassword("correct horse")
  expect(phc.startsWith("$scrypt$ln=16,r=8,p=1$")).toBe(true)
  expect(phc).not.toContain("correct horse")
  expect(await checkPassword("correct horse", phc)).toBe(true)
  expect(await checkPassword("correct hors", phc)).toBe(false)
  expect(await checkPassword("", phc)).toBe(false)
})

test("a hash made at an earlier cost still checks", async () => {
  const salt = Buffer.from("0123456789abcdef")
  const key = crypto.scryptSync("an older password", salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  const phc = `$scrypt$ln=15,r=8,p=1$${b64(salt)}$${b64(key)}`
  expect(await checkPassword("an older password", phc)).toBe(true)
  expect(await checkPassword("another one", phc)).toBe(false)
})

test("each hash has its own salt", async () => {
  expect(await hashPassword("same password")).not.toBe(await hashPassword("same password"))
})

test("a hash fits the protocol", async () => {
  const password_hash = await hashPassword("12345678")
  expect(() =>
    Person.parse({ handle: "me", name: "Me", kind: "human", title: "CEO", manager: null, password_hash }),
  ).not.toThrow()
})

// A hash comes from the company repo, so it can't make the office spend unbounded time or memory.
test.each([
  [null],
  [""],
  ["plain"],
  ["$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA"],
  ["$scrypt$ln=15,r=8,p=1$c2FsdA"],
  ["$scrypt$ln=15,r=8,p=1$!!!$aGFzaA"],
  ["$scrypt$ln=30,r=8,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaA"],
  ["$scrypt$ln=15,r=8,p=500$c2FsdHNhbHRzYWx0c2FsdA$aGFzaA"],
  ["$scrypt$ln=15,r=4096,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaA"],
] as const)("an unknown or unreasonable hash checks nothing [%s]", async (phc) => {
  expect(await checkPassword("anything", phc)).toBe(false)
})

test("a password needs a minimum length", () => {
  expect(passwordProblem("a".repeat(MIN_LENGTH - 1))).toBe(`use at least ${MIN_LENGTH} characters`)
  expect(passwordProblem("a".repeat(MIN_LENGTH))).toBeNull()
  expect(MIN_LENGTH).toBe(12)
})

// Each hash would check if the length rule were missing, since Node's decoder drops a lone trailing character.
test.each([["salt"], ["key"]] as const)(
  "a hash with an impossible base64 length checks nothing [%s]",
  async (field) => {
    const pw = "a fast password"
    const options = { N: 2 ** 10, r: 8, p: 1 }
    let phc: string
    let valid: string
    if (field === "salt") {
      const text = "c2FsdHNhbHRzYWx0c2FsdA" + "QUF"
      expect(text.length % 4).toBe(1)
      const salt = Buffer.from(text, "base64")
      const key = crypto.scryptSync(pw, salt, 32, options)
      phc = `$scrypt$ln=10,r=8,p=1$${text}$${b64(key)}`
      valid = `$scrypt$ln=10,r=8,p=1$${b64(salt)}$${b64(key)}`
    } else {
      const salt = Buffer.from("0123456789abcdef")
      const key33 = crypto.scryptSync(pw, salt, 33, options)
      const text = b64(key33) + "A"
      expect(text.length).toBe(45)
      expect(Buffer.from(text, "base64").equals(key33)).toBe(true)
      phc = `$scrypt$ln=10,r=8,p=1$${b64(salt)}$${text}`
      valid = `$scrypt$ln=10,r=8,p=1$${b64(salt)}$${b64(key33)}`
    }
    expect(await checkPassword(pw, valid)).toBe(true)
    expect(await checkPassword(pw, phc)).toBe(false)
  },
)

test("a password is counted in characters", () => {
  expect(passwordProblem("🔒".repeat(11))).toBe(`use at least ${MIN_LENGTH} characters`)
  expect(passwordProblem("🔒".repeat(12))).toBeNull()
})

test("the dummy hash checks nothing", async () => {
  expect(DUMMY_HASH).toMatch(PHC)
  expect(await checkPassword("", DUMMY_HASH)).toBe(false)
  expect(await checkPassword("correct horse battery", DUMMY_HASH)).toBe(false)
})

test("a password that isnt well formed checks nothing", async () => {
  // Encoded as UTF-8, a lone surrogate turns into U+FFFD, so the two passwords would hash alike.
  const phc = await hashPassword("\uFFFD".repeat(12))
  expect(await checkPassword("\uD800" + "\uFFFD".repeat(11), phc)).toBe(false)
  expect(passwordProblem("\uD800".repeat(12))).toBe("use a password that is valid text")
})
