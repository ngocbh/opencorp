/** The connection spec: what reach.sh may print, and the remote command built from it. */
import { expect, test } from "bun:test"
import { Spec } from "../../src/reach/spec.ts"

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
