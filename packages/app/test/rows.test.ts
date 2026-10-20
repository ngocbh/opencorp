import { expect, test } from "bun:test"
import { fromTree, label, visibleRows } from "../src/company/rows"
import { buildTree } from "../src/company/tree"
import { person } from "./people"

// ceo ─┬─ al ─┬─ bo
//      │      └─ cy
//      └─ dee
const tree = buildTree([person("ceo", null), person("al", "ceo"), person("bo", "al"), person("cy", "al"), person("dee", "ceo")],
  { name: "A", ceo: "ceo" })
const items = fromTree(tree.roots)

test("visible rows: roots, and the children of open items, with level, parent and position", () => {
  const rows = visibleRows(items, (item) => item.id !== "al")
  expect(rows.map((r) => [r.item.id, r.level, r.parent, r.open, r.posinset, r.setsize])).toEqual([
    ["ceo", 1, null, true, 1, 1],
    ["al", 2, "ceo", false, 1, 2],
    ["dee", 2, "ceo", false, 2, 2],
  ])
})

test("isOpen is asked only about branches, with each one's depth; a leaf is never open", () => {
  const asked: [string, number][] = []
  const rows = visibleRows(items, (item, depth) => (asked.push([item.id, depth]), true))
  expect(asked).toEqual([["ceo", 0], ["al", 1]])
  expect(rows.find((r) => r.item.id === "dee")?.open).toBe(false)
})

test("a person's label is their name and title", () => {
  expect(label(items[0])).toBe("Ceo, T")
})
