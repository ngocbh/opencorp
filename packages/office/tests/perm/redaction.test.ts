/** Secret values never leave the monitor, whatever shape a kind's result or error takes. */
import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import { casefold, jsonDumps, quote, quotePlus, repr, splitLines, strip } from "../../src/perm/redact.ts"

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
