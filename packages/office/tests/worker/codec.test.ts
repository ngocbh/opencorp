/** The worker value codec: bigint, NaN, infinities and $v records round trip; forged tags are refused. */
import { expect, test } from "bun:test"
import { decode, encode } from "../../src/worker/codec.ts"

test("a bigint round trips", () => {
  for (const n of [0n, -1n, 2n ** 64n + 1n, -(2n ** 70n)]) expect(decode(encode(n))).toBe(n)
  expect(encode(2n ** 64n + 1n)).toBe('{"$v":"bigint","s":"18446744073709551617"}')
})

test("NaN round trips", () => {
  expect(encode(NaN)).toBe('{"$v":"nan"}')
  expect(decode(encode(NaN))).toBeNaN()
})

test("Infinity round trips", () => {
  expect(encode(Infinity)).toBe('{"$v":"inf"}')
  expect(decode(encode(Infinity))).toBe(Infinity)
})

test("negative Infinity round trips", () => {
  expect(encode(-Infinity)).toBe('{"$v":"-inf"}')
  expect(decode(encode(-Infinity))).toBe(-Infinity)
})

test("nested values round trip", () => {
  const value = {
    zeta: 1,
    alpha: [2.5, "x", null, true, false, [3n, { deep: [NaN, { deeper: -Infinity, big: -(2n ** 65n) }] }]],
    middle: { text: "héllo ✓ 日本", inf: Infinity, n: 7, f: -0.25 },
  }
  const back = decode(encode(value)) as typeof value
  expect(back).toEqual(value)
  expect(Object.keys(back)).toEqual(Object.keys(value))
  expect(Object.keys(back.middle)).toEqual(Object.keys(value.middle))
  expect(typeof back.zeta).toBe("number")
  expect(typeof back.middle.f).toBe("number")
  const inner = back.alpha[5] as [bigint, { deep: [number, { deeper: number, big: bigint }] }]
  expect(inner[0]).toBe(3n)
  expect(inner[1].deep[1].big).toBe(-(2n ** 65n))
})

test("a record with a $v key round trips", () => {
  const shared = { $v: 1 }
  const cases: [unknown, unknown][] = [
    [{ $v: 1 }, { $v: 1 }],
    [{ a: [{ $v: "bigint", s: "1" }] }, { a: [{ $v: "bigint", s: "1" }] }],
    [{ $v: "record", value: { $v: 1 } }, { $v: "record", value: { $v: 1 } }],
    [{ $v: { $v: 2n ** 70n } }, { $v: { $v: 2n ** 70n } }],
    [{ $v: "nan" }, { $v: "nan" }],
    [[{ toJSON: () => ({ $v: "inf" }) }], [{ $v: "inf" }]],
    [{ $v: undefined, a: 1 }, { a: 1 }],
    [{ a: shared, b: shared }, { a: { $v: 1 }, b: { $v: 1 } }],
  ]
  for (const [value, json] of cases) expect(decode(encode(value))).toStrictEqual(json)
  expect(encode({ $v: 1 })).toBe('{"$v":"record","value":{"$v":1}}')
})

test("a value with no json form is refused", () => {
  for (const value of [undefined, () => 1]) {
    expect(() => encode(value)).toThrow(TypeError)
    expect(() => encode(value)).toThrow(new TypeError("a value with no JSON form can't be sent"))
  }
  const cycle: Record<string, unknown> = { $v: 1 }
  cycle.self = cycle
  expect(() => encode(cycle)).toThrow(TypeError)
})

test("a forged tag is refused", () => {
  const forged = [
    '{"$v":"x"}',
    '{"$v":"bigint","s":"1.5"}',
    '{"$v":"bigint","s":"1","t":2}',
    '{"$v":"bigint","s":"-007"}',
    '{"$v":"bigint","s":"-0"}',
    '{"$v":"nan","s":"1"}',
    '[{"a":{"$v":"inf","x":null}}]',
    '{"$v":"record"}',
    '{"$v":"record","value":1}',
    '{"$v":"record","value":[]}',
    '{"$v":"record","value":null}',
    '{"$v":"record","value":{},"x":1}',
  ]
  for (const text of forged) {
    expect(() => decode(text)).toThrow(TypeError)
    expect(() => decode(text)).toThrow(new TypeError("a frame holds a $v record that isn't a tag"))
  }
})

test("a proto key in a decoded record stays a plain key", () => {
  const back = decode('{"__proto__": {"$v": "nan"}, "a": {"$v": "record", "value": {"__proto__": 1}}}') as {
    a: object
  }
  expect(Object.keys(back)).toEqual(["__proto__", "a"])
  expect(Object.getOwnPropertyDescriptor(back, "__proto__")?.value).toBeNaN()
  expect(Object.keys(back.a)).toEqual(["__proto__"])
  expect(Object.getOwnPropertyDescriptor(back.a, "__proto__")?.value).toBe(1)
  expect(Object.getPrototypeOf(back)).toBe(Object.prototype)
  expect(Object.getPrototypeOf(back.a)).toBe(Object.prototype)
})

test("text that is not json is refused with a fixed message", () => {
  for (const text of ["sk-SECRET123", '{"k": sk-secret']) {
    expect(() => decode(text)).toThrow(SyntaxError)
    expect(() => decode(text)).toThrow(new SyntaxError("a frame isn't valid JSON"))
  }
})

test("observer values are sent as their JSON form", () => {
  class Event {
    constructor(readonly node: string, readonly tokens: bigint) {}
    toJSON() {
      return { kind: "event", node: this.node, tokens: this.tokens }
    }
  }
  class Ref {
    readonly uri: string
    readonly mime: string | undefined
    #secret = "hidden"
    constructor(uri: string) {
      this.uri = uri
      this.mime = undefined
      Object.freeze(this)
    }
    secret() {
      return this.#secret
    }
  }
  expect(decode(encode([new Event("a#0", 12n), new Ref("file:///a")]))).toEqual([
    { kind: "event", node: "a#0", tokens: 12n },
    { uri: "file:///a" },
  ])
  expect(encode(new Event("a#0", 12n))).toBe('{"kind":"event","node":"a#0","tokens":{"$v":"bigint","s":"12"}}')
  expect(encode(new Ref("file:///a"))).toBe('{"uri":"file:///a"}')
})
