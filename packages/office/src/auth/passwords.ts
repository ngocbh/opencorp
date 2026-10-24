/** Passwords, kept only as salted scrypt hashes in PHC form: `$scrypt$ln=16,r=8,p=1$<salt>$<hash>`. */
import crypto from "node:crypto"

/** The fewest characters a new password has. */
export const MIN_LENGTH = 12

/** A hash no password matches, checked for an unknown handle so it costs what a known one does. */
export const DUMMY_HASH = "$scrypt$ln=16,r=8,p=1$b3BlbmNvcnAgaHEgc2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

// The hashes sit in the company repo, where anyone who reads it can guess offline: each guess
// costs 64 MiB and about a tenth of a second. Older hashes carry their own cost and still check.
const LN = 16
const R = 8
const P = 1
const PHC = /^\$scrypt\$ln=([0-9]+),r=([0-9]+),p=([0-9]+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/
// The most work a check does: a hash comes from the company repo, so it can't ask for unbounded time or memory.
const MAX_LN = 17
const MAX_P = 4
const MAX_MEMORY = 256 * 1024 * 1024
const MAX_SALT = 64
const MIN_KEY = 16
const MAX_KEY = 64

function b64(data: Buffer): string {
  return data.toString("base64").replace(/=+$/, "")
}

/** scrypt of `password` (as UTF-8) with N = 2^`ln`. Bun throws synchronously for parameters BoringSSL refuses
 *  (e.g. `ln=16, r=1`: N must be below 2^(16r); memory over `maxmem`), so a caller's own bounds don't rule out
 *  a throw. */
function scrypt(password: string, salt: Buffer, ln: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(Buffer.from(password), salt, keylen, { N: 2 ** ln, r, p, maxmem: MAX_MEMORY }, (error, key) =>
      error ? reject(error) : resolve(key),
    )
  })
}

/** Why `password` can't be a new password, or null if it can. */
export function passwordProblem(password: string): string | null {
  // Counted in code points, as Python's len counts them.
  if ([...password].length < MIN_LENGTH) return `use at least ${MIN_LENGTH} characters`
  if (!password.isWellFormed()) return "use a password that is valid text"
  return null
}

/** A new salted hash of `password`; takes about a tenth of a second. Throws a `TypeError` if `password` isn't
 *  well-formed text. */
export async function hashPassword(password: string): Promise<string> {
  // Python's encode refuses a lone surrogate; UTF-8 encoding here would turn it into U+FFFD.
  if (!password.isWellFormed()) throw new TypeError("a password must be valid text")
  const salt = crypto.randomBytes(16)
  return `$scrypt$ln=${LN},r=${R},p=${P}$${b64(salt)}$${b64(await scrypt(password, salt, LN, R, P, 32))}`
}

/** Whether `password` is the one `phc` hashes; false for no hash or one this office can't check. */
export async function checkPassword(password: string, phc: string | null | undefined): Promise<boolean> {
  // A lone surrogate encodes as U+FFFD, so it would match another password; Python's encode refuses it.
  if (!password.isWellFormed()) return false
  const match = PHC.exec(phc ?? "")
  if (match === null) return false
  const ln = Number(match[1]), r = Number(match[2]), p = Number(match[3])
  // The memory Python's OpenSSL asks for; Bun's BoringSSL needs 128·r bytes less, so Python's bound holds.
  if (ln < 1 || ln > MAX_LN || p < 1 || p > MAX_P || r < 1 || 128 * r * (2 ** ln + p + 2) > MAX_MEMORY) return false
  const [saltText, wantText] = [match[4]!, match[5]!]
  // Node's decoder drops a lone trailing character; Python's strict decoder refuses it.
  if (saltText.length % 4 === 1 || wantText.length % 4 === 1) return false
  const salt = Buffer.from(saltText, "base64")
  const want = Buffer.from(wantText, "base64")
  // scrypt's PBKDF2 steps cost (salt + key length)·r·p, so a huge salt or key would burn CPU within the bounds
  // above. Office and Python hashes have a 16-byte salt and a 32-byte key.
  if (salt.length > MAX_SALT || want.length < MIN_KEY || want.length > MAX_KEY) return false
  let got: Buffer
  try {
    got = await scrypt(password, salt, ln, r, p, want.length)
  } catch {
    return false
  }
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}
