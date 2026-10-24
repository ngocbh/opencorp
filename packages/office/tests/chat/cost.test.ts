/** Session cost: model-call usage priced per model, and the session's cap. */
import { expect, test } from "bun:test"
import { CompanyDefaults } from "@opencorp/protocol"
import { DEFAULT_PRICE, ZERO_PRICE, callUsd, costCap } from "../../src/chat/cost.ts"
import { session } from "../store/helpers.ts"

test("a listed model uses its price", () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 2_000_000, total_tokens: 3_000_000 }
  expect(callUsd({ m: { input: 3, output: 15 } }, "m", usage)).toBeCloseTo(33.0, 9)
})

test("an unlisted or missing model uses the default price", () => {
  const usage = { input_tokens: 10, output_tokens: 3, total_tokens: 13 }
  const expected = (10 * DEFAULT_PRICE.input + 3 * DEFAULT_PRICE.output) / 1_000_000
  expect(callUsd({}, "stub", usage)).toBeCloseTo(expected, 9)
  expect(callUsd({}, null, usage)).toBeCloseTo(expected, 9)
})

test("a zero default prices an unpriced model at nothing and a priced one at its price", () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, total_tokens: 2_000_000 }
  expect(callUsd({}, "gpt-5.5", usage, { default: ZERO_PRICE })).toBe(0)
  expect(callUsd({ "gpt-5.5": { input: 1, output: 2 } }, "gpt-5.5", usage, { default: ZERO_PRICE })).toBeCloseTo(3.0, 9)
})

test("the cap is the sessions own else the company default", () => {
  const defaults = CompanyDefaults.parse({ cost_cap_usd: 5 })
  expect(costCap(session(), defaults)).toBe(5)
  expect(costCap(session({ cost_cap_usd: 0.5 }), defaults)).toBe(0.5)
  expect(costCap(session({ cost_cap_usd: 0 }), defaults)).toBe(0)
})

test("a model named like an object property uses the default price", () => {
  const usage = { input_tokens: 10, output_tokens: 3, total_tokens: 13 }
  const expected = (10 * DEFAULT_PRICE.input + 3 * DEFAULT_PRICE.output) / 1_000_000
  for (const model of ["constructor", "__proto__"]) {
    const usd = callUsd({}, model, usage)
    expect(Number.isFinite(usd)).toBe(true)
    expect(usd).toBeCloseTo(expected, 9)
  }
})
