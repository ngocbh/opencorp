import { expect, test } from "bun:test"
import { buildTree } from "../src/company/tree"
import { person } from "./people"

const company = { name: "Acme", ceo: "ceo" }
const handles = (nodes: { person: { handle: string }; children: any[] }[]): unknown =>
  nodes.map((n) => (n.children.length ? [n.person.handle, handles(n.children)] : n.person.handle))

test("the CEO is the first root, then others with no manager; children by name", () => {
  const people = [person("zed", null), person("ceo", null), person("bea", "ceo"), person("al", "ceo"), person("cy", "al")]
  const t = buildTree(people, company)
  expect(handles(t.roots)).toEqual([["ceo", [["al", ["cy"]], "bea"]], "zed"])
  expect(t.unplaced).toEqual([])
  expect(t.ceoHasManager).toBe(false)
})

test("an unknown manager or a cycle is unplaced, with everyone under them", () => {
  const people = [person("ceo", null), person("ann", "ghost"), person("bo", "cat"), person("cat", "bo"), person("dee", "bo")]
  const t = buildTree(people, company)
  expect(t.unplaced.map((p) => p.handle).sort()).toEqual(["ann", "bo", "cat", "dee"])
  expect(handles(t.roots)).toEqual(["ceo"])
})

test("someone who manages themselves is unplaced", () => {
  const t = buildTree([person("ceo", null), person("al", "al"), person("bo", "al")], company)
  expect(t.unplaced.map((p) => p.handle)).toEqual(["al", "bo"])
  expect(handles(t.roots)).toEqual(["ceo"])
})

test("a CEO with a manager stays a root and the edge up isn't drawn", () => {
  const t = buildTree([person("ceo", "boss"), person("boss", null)], company)
  expect(handles(t.roots)).toEqual(["ceo", "boss"])
  expect(t.ceoHasManager).toBe(true)
})

test("with no company file, everyone without a manager is a root", () => {
  const t = buildTree([person("a", null), person("b", null), person("c", "a")], null)
  expect(handles(t.roots)).toEqual([["a", ["c"]], "b"])
})

test("a CEO missing from the people changes nothing", () => {
  const t = buildTree([person("b", null), person("a", null)], company)
  expect(handles(t.roots)).toEqual(["a", "b"])
  expect(t.ceoHasManager).toBe(false)
})

test("an empty company is an empty tree", () => {
  expect(buildTree([], company)).toEqual({ roots: [], unplaced: [], ceoHasManager: false })
  expect(buildTree([], null)).toEqual({ roots: [], unplaced: [], ceoHasManager: false })
})
