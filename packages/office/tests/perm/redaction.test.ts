/** Secret values never leave the monitor, whatever shape a kind's result or error takes. */
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import {
  auditArgs, casefold, DETAIL_CHARS, jsonDumps, quote, quotePlus, redact, repr, splitLines, strip,
} from "../../src/perm/redact.ts"

const PEM = "-----BEGIN KEY-----\nAAAABBBBCCCCDDDD\nEEEEFFFFGGGGHHHH\n-----END KEY-----\n"
const ESCAPED = "pa\\ss\"w\u00f6rd-123"
/** Python's ESCAPED_FORMS: the secret as stored, JSON-escaped (ASCII and raw), its repr body, quote(safe=""). */
const ESCAPED_FORMS = ["pa\\ss\"w\u00f6rd-123", "pa\\\\ss\\\"w\\u00f6rd-123", "pa\\\\ss\\\"w\u00f6rd-123",
  "pa\\\\ss\"w\u00f6rd-123", "pa%5Css%22w%C3%B6rd-123"]
const CONN = "conn-key-5f3a9c1e7b2d4a60"
const URLISH = "a b/c+key-0123"
const QUOTED = 'qu"ote-secret-99'
/** Python's base64.urlsafe_b64encode(f"??{CONN}>>".encode()). */
const URLSAFE = "Pz9jb25uLWtleS01ZjNhOWMxZTdiMmQ0YTYwPj4="

/** Python's base64.b64encode of the text's UTF-8. */
function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64")
}

/** Python's base64.encodebytes: base64 in lines of 76 characters, each ending in "\n". */
function encodebytes(text: string): string {
  const coded = b64(text)
  let out = ""
  for (let i = 0; i < coded.length; i += 76) out += coded.slice(i, i + 76) + "\n"
  return out
}

test("a secret stored with a trailing newline is scrubbed without it", () => {
  expect(redact("used abcdefgh-1234.", [], ["abcdefgh-1234\n"])).toBe("used [redacted].")
})

test("each long line of a multi line secret is scrubbed", () => {
  expect(redact("line AAAABBBBCCCCDDDD and x", [], [PEM])).toBe("line [redacted] and x")
})

test("short lines of a secret are left alone", () => {
  expect(redact("ab and cd", [], ["ab\ncd\nlong-enough-line"])).toBe("ab and cd")
})

test("a secret inside a longer one is scrubbed longest first", () => {
  expect(redact("xxabcdefghyy", [], ["abcdefgh", "xxabcdefghyy"])).toBe("[redacted]")
  expect(redact("xxabcdefghyy", [], ["xxabcdefghyy", "abcdefgh"])).toBe("[redacted]")
})

test("mapping keys and numbers are scrubbed", () => {
  expect(redact({ "x-abcdefgh": 1, pin: 12345678, n: 7 }, [], ["abcdefgh", "12345678"]))
    .toEqual({ "x-[redacted]": 1, pin: "[redacted]", n: 7 })
})

test("keys that scrub to the same text keep every value", () => {
  const got = redact({ "x-abcdefgh": 1, "x-12345678": 2, "[redacted]": 3, abcdefgh: 4 }, [], ["abcdefgh", "12345678"])
  expect(got).toEqual({ "x-[redacted]": 1, "x-[redacted]#2": 2, "[redacted]": 3, "[redacted]#2": 4 })
  expect(Object.keys(got as object)).toEqual(["x-[redacted]", "x-[redacted]#2", "[redacted]", "[redacted]#2"])
})

/** [label, text, a piece of the secret's form that must be gone]. */
const ENCODED: [string, string, string][] = [
  ["base64", b64(CONN), b64(CONN)],
  // The secret at each offset in its group of 3.
  ["basic user", "Basic " + b64("user:" + CONN), b64("user:" + CONN).slice(8, -4)],
  ["basic u", "Basic " + b64("u:" + CONN), b64("u:" + CONN).slice(4, -4)],
  ["basic ab", "Basic " + b64("ab:" + CONN), b64("ab:" + CONN).slice(4, -4)],
  // Python's base64.urlsafe_b64encode(f"??{CONN}>>".encode())
  ["urlsafe base64", URLSAFE, URLSAFE.slice(4, -4)],
  ["upper case", CONN.toUpperCase(), CONN.toUpperCase()],
  ["mixed case", "Conn-Key-5F3A9c1e7b2d4a60", "5F3A9c1e7b2d4a60"],
  // quote_plus(URLISH)
  ["quote plus", "https://h/?k=a+b%2Fc%2Bkey-0123", "c%2Bkey"],
  // quote(URLISH)
  ["quote", "https://h/?k=a%20b/c%2Bkey-0123", "c%2Bkey"],
  // quote(URLISH, safe="").lower()
  ["quote lower case", "https://h/?k=a%20b%2fc%2bkey-0123", "c%2bkey"],
  // json.dumps(json.dumps({"k": QUOTED}))
  ["json twice", String.raw`"{\"k\": \"qu\\\"ote-secret-99\"}"`, "ote-secret-99"],
  // json.dumps(json.dumps({"k": QUOTED}, ensure_ascii=False), ensure_ascii=False): the same text
  ["json twice unicode", String.raw`"{\"k\": \"qu\\\"ote-secret-99\"}"`, "ote-secret-99"],
]

test.each(ENCODED)("encoded and recased forms of a secret are scrubbed [%s]", (_label, text, gone) => {
  const out = redact(`said: ${text}.`, [], [CONN, URLISH, QUOTED])
  expect(out.includes("[redacted]")).toBe(true)
  expect(out.includes(gone)).toBe(false)
})

test.each([0, 50, 56, 300])("a secret in base64 wrapped at 76 columns is scrubbed [%d]", (prefix) => {
  const data = "x".repeat(prefix) + CONN + "y".repeat(80)
  const core = b64("x".repeat(prefix) + CONN).slice(-28, -4)
  for (const wrapped of [encodebytes(data), encodebytes(data).replaceAll("\n", "\r\n"),
    JSON.stringify(encodebytes(data))]) {
    const out = redact("attachment:\n" + wrapped, [], [CONN])
    expect(out.includes("[redacted]")).toBe(true)
    const lines = out.replaceAll("\\n", "\n").split(/\r\n|\r|\n/).filter((line) => line.length > 8)
    const joined = lines.join("").replaceAll("\r", "")
    expect(joined.includes(core)).toBe(false)
    // No regex state is carried from one call to the next.
    expect(redact("attachment:\n" + wrapped, [], [CONN])).toBe(out)
  }
})

test("wrapped base64 without a secret is kept", () => {
  const text = encodebytes("z".repeat(400))
  expect(redact(text, [], [CONN])).toBe(text)
})

test("encoded forms dont scrub ordinary text", () => {
  const text = "hello conn-key world, Y29ubi1rZXk= and https://h/?q=conn"
  expect(redact(text, [], [CONN])).toBe(text)
})

test("scrubbing known values stays fast", () => {
  const values = Array.from({ length: 40 }, (_, i) => `secret-value-${String(i).padStart(4, "0")}-abcdefghij`)
  const blob = "x".repeat(1_000_000)
  const many = Array.from({ length: 20_000 }, (_, i) => `line ${i} with nothing secret in it`)
  // The same budget and single round as Python's test.
  const start = performance.now()
  redact(blob, [], values)
  redact(many, [], values)
  expect(performance.now() - start).toBeLessThan(2000)
}, 30_000)

// The first five are Python's LEAKS modes of the same names, which Python checks through Monitor.call; the two
// double-JSON cases follow the double-JSON vectors of "encoded and recased forms" with this secret. The texts are
// Python 3.12's outputs, E = ESCAPED.
const ESCAPED_TEXTS: [string, string][] = [
  // json.dumps({"p": E})
  ["json_text", "{\"p\": \"pa\\\\ss\\\"w\\u00f6rd-123\"}"],
  // json.dumps({"p": E}, ensure_ascii=False)
  ["json_text_unicode", "{\"p\": \"pa\\\\ss\\\"w\u00f6rd-123\"}"],
  // f"bad password {E!r}"
  ["repr", "bad password 'pa\\\\ss\"w\u00f6rd-123'"],
  // str(KeyError(E))
  ["key_error", "'pa\\\\ss\"w\u00f6rd-123'"],
  // "https://host/login?p=" + quote(E, safe="")
  ["url", "https://host/login?p=pa%5Css%22w%C3%B6rd-123"],
  // json.dumps(json.dumps(E))
  ["json_twice", "\"\\\"pa\\\\\\\\ss\\\\\\\"w\\\\u00f6rd-123\\\"\""],
  // json.dumps(json.dumps(E, ensure_ascii=False), ensure_ascii=False)
  ["json_twice_unicode", "\"\\\"pa\\\\\\\\ss\\\\\\\"w\u00f6rd-123\\\"\""],
]

test.each(ESCAPED_TEXTS)(
  "every escaped form of a secret with quotes backslashes and non ascii is scrubbed [%s]",
  (_label, text) => {
    const out = redact(text, [], [ESCAPED])
    expect(out.includes("[redacted]")).toBe(true)
    expect(ESCAPED_FORMS.filter((form) => out.includes(form)).length).toBe(0)
  },
)

test("a secret recased with a dotted or dotless i is scrubbed", () => {
  expect(redact("used ABCDEFGH\u0130.", [], ["abcdefghi"])).toBe("used [redacted].")
  expect(redact("abcdefghi and abcdefgh\u0131", [], ["abcdefghi"])).toBe("[redacted] and [redacted]")
})

test("values under secret keys are redacted at any depth", () => {
  const got = redact({ token: "plain-1", job: "train", nested: { token: 5, list: [{ token: ["a"] }, "keep"] } },
    ["token"], [])
  expect(got).toEqual({ token: "[redacted]", job: "train",
    nested: { token: "[redacted]", list: [{ token: "[redacted]" }, "keep"] } })
})

test("a key named __proto__ stays a plain key", () => {
  const got = redact(JSON.parse('{"__proto__": "abcdefgh-1 x", "b": 1}'), [], ["abcdefgh-1"]) as object
  expect(Object.getPrototypeOf(got)).toBe(Object.prototype)
  expect(Object.getOwnPropertyDescriptor(got, "__proto__")?.value).toBe("[redacted] x")
  expect(Object.keys(got)).toEqual(["__proto__", "b"])
})

test("audit args longer than the cap are cut to it", () => {
  // Python's synthetic test token.
  const TOKEN = "s3cr3t-t0ken-value"
  const cut = auditArgs({ job: "x".repeat(3000) + TOKEN }, ["vault_token"], [TOKEN])
  expect(Object.keys(cut)).toEqual(["truncated"])
  const truncated = cut.truncated as string
  expect(truncated.length).toBe(DETAIL_CHARS)
  expect(truncated.startsWith('{"job": "xxx')).toBe(true)
  expect(JSON.stringify(cut).includes(TOKEN)).toBe(false)
  expect(auditArgs({ job: "small", vault_token: TOKEN }, ["vault_token"], [TOKEN]))
    .toEqual({ job: "small", vault_token: "[redacted]" })
  expect(auditArgs({ n: 12345678901234567890n, x: NaN, y: [1.5, true, null] }, [], []))
    .toEqual({ n: 12345678901234567890n, x: NaN, y: [1.5, true, null] })
  // Python 3.12's output: the secret inside the kept part is redacted before the cut.
  const front = auditArgs({ job: TOKEN + "x".repeat(3000) }, ["vault_token"], [TOKEN]).truncated as string
  expect(front.startsWith('{"job": "[redacted]xxx')).toBe(true)
  const kinds = auditArgs({ x: NaN, n: 12345678901234567890n, y: [1.5, true, null], s: "x".repeat(3000) }, [], [])
  expect((kinds.truncated as string)
    .startsWith('{"x": NaN, "n": 12345678901234567890, "y": [1.5, true, null], "s": "xxx')).toBe(true)
})

test("a secret holding regex characters is scrubbed only as written", () => {
  // Python 3.12's results; Python gets this from re.escape.
  const special = "a.b*c+d?e^f$g(h)i[j]k{l}m|n/o\\p-q"
  expect(redact("x a.b*c+d?e^f$g(h)i[j]k{l}m|n/o\\p-q y", [], [special])).toBe("x [redacted] y")
  expect(redact("X A.B*C+D?E^F$G(H)I[J]K{L}M|N/O\\P-Q y", [], [special])).toBe("X [redacted] y")
  expect(redact("a.cdefghij aXcdefghij", [], ["a.cdefghij"])).toBe("[redacted] aXcdefghij")
  expect(redact("ab*cdefghij abbcdefghij acdefghij", [], ["ab*cdefghij"])).toBe("[redacted] abbcdefghij acdefghij")
})

test("a secret in base64 is scrubbed in either alphabet", () => {
  // Python's own url-safe vector holds no "-" or "_", so this pins the alphabet folding; the secret's base64 core
  // holds "+" and "/". Values are Python 3.12's results.
  const secret = "key~~~~>>>>??"
  // base64.urlsafe_b64encode(b"u:" + secret)
  expect(redact("Basic dTprZXl-fn5-Pj4-Pj8_.", [], [secret])).toBe("Basic dTp[redacted].")
  // base64.b64encode(b"u:" + secret)
  expect(redact("Basic dTprZXl+fn5+Pj4+Pj8/.", [], [secret])).toBe("Basic dTp[redacted].")
})

/** Every code point but the surrogates, in order: the input Python's digests were taken over. */
const EVERY = (() => {
  const parts: string[] = []
  for (let cp = 0; cp < 0x110000; cp++) if (cp < 0xd800 || cp > 0xdfff) parts.push(String.fromCodePoint(cp))
  return parts.join("")
})()

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

// Digests from Python 3.12.14 (unidata 15.0.0), where
// every = "".join(chr(c) for c in range(0x110000) if not 0xd800 <= c <= 0xdfff)

test("json dumps matches python on every code point", () => {
  // sha256(json.dumps(every))
  expect(sha256(jsonDumps(EVERY))).toBe("990d69fa67b7e2bf13ab781ecd44ff0fde2648926afe1ceed0d0710fa8ddaf0a")
  // sha256(json.dumps(every, ensure_ascii=False))
  expect(sha256(jsonDumps(EVERY, false))).toBe("57e981f64bd97f179471154328d2c7c9202ce92fa5503814073aaff388c877f2")
  expect(jsonDumps("a\ud800b")).toBe("\"a\\ud800b\"")
  expect(jsonDumps("a\ud800b", false)).toBe("\"a\ud800b\"")
  expect(jsonDumps("x\u{1f600}")).toBe("\"x\\ud83d\\ude00\"")
}, 30_000)

test("quote and quote plus match python on every code point", () => {
  // sha256(quote(every, safe=""))
  expect(sha256(quote(EVERY, ""))).toBe("0bca66b137cb99ea9f540fda9f9efd55b539fbd03d3c51078a95cee07c4521c6")
  // sha256(quote(every))
  expect(sha256(quote(EVERY))).toBe("3a660fcab63ae4a0874f02807d415a323c413c76cc2639a50e4d65c3e97faa2a")
  // sha256(quote_plus(every))
  expect(sha256(quotePlus(EVERY))).toBe("1a72de016981673af121a10c0564f392fc05768f7d267c54f6a07f0cf46b2271")
  expect(quotePlus("a b/c+key-0123")).toBe("a+b%2Fc%2Bkey-0123")
  expect(quote("a b/c+key-0123")).toBe("a%20b/c%2Bkey-0123")
  expect(quote("a\u00e9/b~", "\u00e9")).toBe("a%C3%A9%2Fb~")
}, 30_000)

test("strip and splitlines follow python whitespace and line breaks", () => {
  expect(strip(" \x1c\x1fa b\x85\ufeff")).toBe("a b\x85\ufeff")
  expect(strip("\u3000\u2028v\u205f")).toBe("v")
  expect(splitLines(" a\x0bb\x0cc\x1cd\x85e\u2028f\r\ng\rh\n")).toEqual([" a", "b", "c", "d", "e", "f", "g", "h"])
  expect(splitLines("")).toEqual([])
  expect(splitLines("\n\n")).toEqual(["", ""])
  expect(splitLines("a\u2029")).toEqual(["a"])
  expect(splitLines("x\r\r\n")).toEqual(["x", ""])
})

test("casefold matches python on every code point", () => {
  // sha256(every.casefold())
  expect(sha256(casefold(EVERY))).toBe("0b6a26871128d7c8ad48627484bd71d3270ab34d7ffdd4539299ea376e8792d5")
  expect(casefold("Stra\u00dfe \u03a3\u03c2 \ufb01 \u0130 \u13a0\uab70 \u212a \u017f \u1e9e \u1f88"))
    .toBe("strasse \u03c3\u03c3 fi i\u0307 \u13a0\u13a0 k s ss \u1f00\u03b9")
  expect(casefold("MiXeD-Case_42")).toBe("mixed-case_42")
  expect(casefold("a\ud800B")).toBe("a\ud800b")
}, 30_000)

test("repr matches python on every code point", () => {
  // sha256(repr(every))
  expect(sha256(repr(EVERY))).toBe("6284623c097853b9600bc0c423b89049479c29857947f0b475293907c3d64cf5")
  expect(repr("it's")).toBe("\"it's\"")
  expect(repr("both ' and \"")).toBe("'both \\' and \"'")
  expect(repr("a\ud800b")).toBe("'a\\ud800b'")
  expect(repr("tab\there\x7f\x85\xa0\u200b\u{e0001}\u0378"))
    .toBe("'tab\\there\\x7f\\x85\\xa0\\u200b\\U000e0001\\u0378'")
  expect(repr("x\u{1f600}")).toBe("'x\u{1f600}'")
}, 30_000)
