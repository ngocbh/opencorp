/** The connection spec: what reach.sh may print, and the remote command built from it. */
import { expect, test } from "bun:test"
import { lastJson, lastLine, parseSpec, Spec } from "../../src/reach/spec.ts"

/** The design's example spec. */
const EXAMPLE = {
  jump: ["nhb25@misha.ycrc.yale.edu"],
  host: "nhb25@r817u15n01",
  opencorp: "/gpfs/radev/pi/ying_rex/nhb25/opencorp/packages/cli/bin/opencorp",
  env: { OPENCORP_BUN: "/gpfs/radev/home/nhb25/.bun/bin/bun" },
}

const GOOD = { host: "h", opencorp: "/a/opencorp" }

const BAD: [string, Record<string, unknown>][] = [
  ["host -oProxyCommand=x", { ...GOOD, host: "-oProxyCommand=x" }],
  ["host -p", { ...GOOD, host: "-p" }],
  ["host a;b", { ...GOOD, host: "a;b" }],
  ["host a b", { ...GOOD, host: "a b" }],
  ["host u@h@x", { ...GOOD, host: "u@h@x" }],
  ["host U@h", { ...GOOD, host: "U@h" }],
  ["host h%", { ...GOOD, host: "h%" }],
  ["jump -J", { ...GOOD, jump: ["-J"] }],
  ["jump of 4 hops", { ...GOOD, jump: ["a", "b", "c", "d"] }],
  ["jump h:0", { ...GOOD, jump: ["h:0"] }],
  ["jump h:65536", { ...GOOD, jump: ["h:65536"] }],
  ["port 0", { ...GOOD, port: 0 }],
  ["port 70000", { ...GOOD, port: 70000 }],
  ["port as a string", { ...GOOD, port: "22" }],
  ["opencorp bin/opencorp", { ...GOOD, opencorp: "bin/opencorp" }],
  ["opencorp /a/../opencorp", { ...GOOD, opencorp: "/a/../opencorp" }],
  ["opencorp /a/opencorp2", { ...GOOD, opencorp: "/a/opencorp2" }],
  ["opencorp /a b/opencorp", { ...GOOD, opencorp: "/a b/opencorp" }],
  ["opencorp /a/op$x/opencorp", { ...GOOD, opencorp: "/a/op$x/opencorp" }],
  ["env LD_PRELOAD", { ...GOOD, env: { LD_PRELOAD: "/a/x.so" } }],
  ["env OPENCORP_BUN /a:/b", { ...GOOD, env: { OPENCORP_BUN: "/a:/b" } }],
  ["env PATH bin:/usr/bin", { ...GOOD, env: { PATH: "bin:/usr/bin" } }],
  ["a top-level key proxy", { ...GOOD, proxy: "x" }],
]

test("the design's example spec passes", () => {
  expect(Spec.parse(EXAMPLE)).toEqual(EXAMPLE)
})

test.each(BAD)("a spec that could inject an option or a shell word is refused [%s]", (_label, spec) => {
  expect(Spec.safeParse(spec).success).toBe(false)
})

test("a jump host may carry a user and a port", () => {
  const spec = { ...GOOD, jump: ["u@login:2222", "gw"] }
  expect(Spec.parse(spec)).toEqual(spec)
})

test("only the last non-blank line of output counts, so banners above are ignored", () => {
  expect(lastLine('Welcome\r\n{"a":1}\r\n\n')).toBe('{"a":1}')
  expect(lastLine("")).toBeNull()
  expect(lastLine(" \n\t\n")).toBeNull()
  expect(lastJson('Welcome\n{"a":1}\n')).toEqual({ a: 1 })
  expect(lastJson("Welcome\nnot json")).toBeUndefined()
  expect(lastJson("")).toBeUndefined()
})

test("a last line that isn't a valid spec is a problem that names fields, never values", () => {
  expect(parseSpec("x\nnot json")).toEqual({ problem: "its last line of output isn't JSON" })
  expect(parseSpec(`Welcome\n${JSON.stringify(EXAMPLE)}\n`)).toEqual({ spec: EXAMPLE })
  const bad = parseSpec(JSON.stringify({ ...GOOD, host: "-oProxyCommand=evil" }))
  expect("problem" in bad && bad.problem).toContain("host")
  expect("problem" in bad && bad.problem).not.toContain("evil")
  const nested = parseSpec(JSON.stringify({ ...GOOD, env: { PATH: "evil:/usr/bin" }, jump: ["a", "-evil"] }))
  expect("problem" in nested && nested.problem).toContain("env.PATH")
  expect("problem" in nested && nested.problem).toContain("jump.1")
  expect("problem" in nested && nested.problem).not.toContain("evil")
  expect(parseSpec("[1]")).toEqual({ problem: expect.stringContaining("the spec: ") })
})

test("a zod message that would quote the input says the field isn't allowed instead", () => {
  const extra = parseSpec(JSON.stringify({ ...GOOD, "\u001b[2Jproxy": 1 }))
  expect(extra).toEqual({ problem: "the spec: has a key that isn't allowed" })
  const nested = parseSpec(JSON.stringify({ ...GOOD, env: { LD_PRELOAD: "/x.so" } }))
  expect(nested).toEqual({ problem: "env: has a key that isn't allowed" })
})
