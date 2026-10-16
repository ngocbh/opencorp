import type { ConnectionList } from "@agent-corp/protocol"
import { expect, test } from "bun:test"
import { modelLabel } from "../../../src/office/models"
import { costLabel } from "../../../src/routes/session/sidebar"

const list: ConnectionList = {
  connections: [
    { name: "office", provider: "azure", method: "api_key", model: "gpt-4o" },
    { name: "chatgpt", provider: "chatgpt", method: "subscription", model: "gpt-5" },
  ],
  default: "office",
  can_manage: true,
}

test("costLabel gives the cost, against the cap when there is one", () => {
  expect(costLabel({ cost: 0.12, cost_cap_usd: null, connection: "office" }, list)).toBe("$0.12")
  expect(costLabel({ cost: 0.12, cost_cap_usd: 5, connection: "office" }, list)).toBe("$0.12 of $5.00")
  // A null connection is office.
  expect(costLabel({ cost: 0, cost_cap_usd: null, connection: null }, list)).toBe("$0.00")
  expect(costLabel({ cost_cap_usd: null, connection: "office" }, list)).toBeUndefined()
})

test("without the connection list, costLabel can't tell a subscription and gives the cost alone", () => {
  expect(costLabel({ cost: 0, cost_cap_usd: null, connection: "chatgpt" })).toBe("$0.00")
  expect(costLabel({ cost_cap_usd: null, connection: "chatgpt" })).toBeUndefined()
})

test("on a subscription connection, costLabel says subscription, unpriced", () => {
  expect(costLabel({ cost_cap_usd: null, connection: "chatgpt" }, list)).toBe("subscription, unpriced")
  expect(costLabel({ cost: 0, cost_cap_usd: null, connection: "chatgpt" }, list)).toBe("$0.00 (subscription, unpriced)")
  expect(costLabel({ cost: 0.4, cost_cap_usd: 5, connection: "chatgpt" }, list)).toBe(
    "$0.40 of $5.00 (subscription, unpriced)",
  )
})

test("a Codex session shows Codex's model and its tokens as unpriced", () => {
  const codex = {
    harness: "codex",
    harness_model: "gpt-5.5-codex",
    cost: 0,
    cost_cap_usd: null,
    connection: "office",
    model: null,
    harness_usage: { input_tokens: 12300, cached_input_tokens: 8000, output_tokens: 900 },
  } as const
  expect(modelLabel(codex)).toBe("gpt-5.5-codex (Codex)")
  expect(costLabel(codex)).toBe("12.3k in · 900 out (Codex login, unpriced)")
  expect(costLabel({ ...codex, harness_usage: null })).toBe("Codex login, unpriced")
  expect(modelLabel({ ...codex, harness_model: null })).toBe("Codex")
})
