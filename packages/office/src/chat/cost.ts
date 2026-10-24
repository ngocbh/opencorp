/** Session cost: model-call usage priced per model, and the session's cap. */
import type { CompanyDefaults } from "@opencorp/protocol"
import type { z } from "zod"
import type { SessionRecord } from "../store/store.ts"
import type { Price } from "./provider.ts"

/** The data form of one model call's usage (yian's `TokenUsage.toJSON()`, as it crosses the worker channel). */
export interface CallUsage {
  input_tokens: number
  output_tokens: number
}

/** The price of a model the provider file doesn't list: high, so an unknown model hits its cap early. */
export const DEFAULT_PRICE: Price = Object.freeze({ input: 15, output: 75 })

/** The price of a subscription's model the provider file doesn't list: the subscription already pays for it. */
export const ZERO_PRICE: Price = Object.freeze({ input: 0, output: 0 })

/** The price of one model call's `usage`; `default` prices a model `prices` doesn't list. */
export function callUsd(
  prices: Readonly<Record<string, Price>>,
  model: string | null | undefined,
  usage: CallUsage,
  { default: fallback = DEFAULT_PRICE }: { default?: Price } = {},
): number {
  const key = model || ""
  // Own keys only: a model named `constructor` or `__proto__` must not price at an inherited property.
  const price = Object.hasOwn(prices, key) ? prices[key] : fallback
  return (usage.input_tokens * price.input + usage.output_tokens * price.output) / 1_000_000
}

/** The session's cap in USD: its own, else the company default. */
export function costCap(session: SessionRecord, defaults: z.output<typeof CompanyDefaults>): number {
  return session.cost_cap_usd ?? defaults.cost_cap_usd
}
