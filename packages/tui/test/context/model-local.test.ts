import { beforeEach, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { createSignal } from "solid-js"
import { createModelState } from "../../src/context/local"
import { Global } from "../../src/core/global"
import { until } from "../fixture/until"

// Under the preload's AGENT_CORP_HOME, one file per test, so a write still queued by one test
// can't land in the next.
let n = 0
beforeEach(() => n++)
const file = () => path.join(Global.Path.state, `model-local-${n}`, "model.json")

async function open(connections: () => readonly string[] | undefined = () => undefined) {
  const state = createModelState(file(), connections)
  await until(() => state.ready)
  return state
}

const pick = (connection: string, model: string) => ({ connection, model })

test("recents are deduplicated, newest first, and capped at 10", async () => {
  const state = await open()
  state.pick(pick("office", "gpt-4o"))
  state.pick(pick("azure-2", "gpt-4o-mini"))
  state.pick(pick("office", "gpt-4o"))
  expect(state.recent()).toEqual([pick("office", "gpt-4o"), pick("azure-2", "gpt-4o-mini")])
  for (let i = 0; i < 12; i++) state.pick(pick("office", `m${i}`))
  expect(state.recent()).toHaveLength(10)
  expect(state.recent()[0]).toEqual(pick("office", "m11"))
  expect(state.recent().at(-1)).toEqual(pick("office", "m2"))
})

test("favorites toggle", async () => {
  const state = await open()
  state.toggleFavorite(pick("office", "gpt-4o"))
  state.toggleFavorite(pick("azure-2", "o3-mini"))
  expect(state.isFavorite(pick("office", "gpt-4o"))).toBe(true)
  state.toggleFavorite(pick("office", "gpt-4o"))
  expect(state.isFavorite(pick("office", "gpt-4o"))).toBe(false)
  expect(state.favorite()).toEqual([pick("azure-2", "o3-mini")])
})

test("the file survives a restart", async () => {
  const first = await open()
  first.pick(pick("azure-2", "gpt-4o-mini"))
  first.toggleFavorite(pick("office", "gpt-4.1"))
  await until(() => existsSync(file()) && readFileSync(file(), "utf8").includes("gpt-4.1"))
  const second = await open()
  expect(second.recent()).toEqual([pick("azure-2", "gpt-4o-mini")])
  expect(second.favorite()).toEqual([pick("office", "gpt-4.1")])
})

test("an entry whose connection is gone is hidden, not deleted", async () => {
  const [names, setNames] = createSignal<readonly string[] | undefined>(["office", "azure-2"])
  const state = await open(names)
  state.pick(pick("azure-2", "gpt-4o-mini"))
  state.pick(pick("office", "gpt-4o"))
  state.toggleFavorite(pick("azure-2", "o3-mini"))
  setNames(["office"])
  expect(state.recent()).toEqual([pick("office", "gpt-4o")])
  expect(state.favorite()).toEqual([])
  setNames(["office", "azure-2"])
  expect(state.recent()).toEqual([pick("office", "gpt-4o"), pick("azure-2", "gpt-4o-mini")])
  expect(state.favorite()).toEqual([pick("azure-2", "o3-mini")])
})
