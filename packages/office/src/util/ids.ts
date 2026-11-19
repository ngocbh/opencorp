/** The office's ids: ULIDs, strictly increasing within this process. */
import { randomBytes } from "node:crypto"

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const RANDOM_LIMIT = 1n << 80n
let lastTime = -1
let lastRandom = 0n

/** `n` in Crockford base32, `length` chars, zero-padded. */
function base32(n: bigint, length: number): string {
  let out = ""
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[Number(n & 31n)] + out
    n >>= 5n
  }
  return out
}

/** A new ULID: 48-bit ms time + 80 random bits, Crockford base32, strictly increasing within this process.
 *  When the clock hasn't moved past the last id's time (same ms, or it went back), the id keeps the last
 *  time and takes the last random part plus one. */
export function newId(): string {
  const t = Date.now()
  if (t > lastTime) {
    lastTime = t
    lastRandom = BigInt(`0x${randomBytes(10).toString("hex")}`)
  } else if (++lastRandom === RANDOM_LIMIT) {
    lastTime += 1
    lastRandom = BigInt(`0x${randomBytes(10).toString("hex")}`)
  }
  return base32(BigInt(lastTime), 10) + base32(lastRandom, 16)
}
