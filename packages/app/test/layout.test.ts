import { expect, test } from "bun:test"
import { CARD, layout, type LayoutNode } from "../src/company/layout"

const n = (id: string, ...children: LayoutNode[]): LayoutNode => ({ id, children })
const slot = CARD.w + CARD.gapX

test("a parent is centred over its children; siblings sit a slot apart; levels a row apart", () => {
  const { boxes } = layout([n("ceo", n("a"), n("b"), n("c"))], () => true)
  const at = Object.fromEntries(boxes.map((b) => [b.id, b]))
  expect([at.a.x, at.b.x, at.c.x]).toEqual([0, slot, 2 * slot])
  expect(at.ceo.x).toBe(at.b.x)
  expect(at.a.y).toBe(CARD.h + CARD.gapY)
})

test("a parent of uneven branches is centred over its first and last child", () => {
  const { boxes } = layout([n("ceo", n("a", n("x"), n("y"), n("z")), n("b"))], () => true)
  const at = Object.fromEntries(boxes.map((b) => [b.id, b]))
  expect(at.a.x).toBe(at.y.x)
  expect(at.b.x).toBe(3 * slot)
  expect(at.ceo.x).toBe((at.a.x + at.b.x) / 2)
})

test("a closed branch takes one slot and draws no children", () => {
  const { boxes, edges } = layout([n("ceo", n("a", n("x"), n("y")), n("b"))], (id) => id !== "a")
  expect(boxes.map((b) => b.id).sort()).toEqual(["a", "b", "ceo"])
  expect(edges.map((e) => e.to).sort()).toEqual(["a", "b"])
  expect(boxes.find((b) => b.id === "b")!.x).toBe(slot)
})

test("boxes come in tree order: a parent before its children", () => {
  const { boxes } = layout([n("ceo", n("a", n("x")), n("b")), n("solo")], () => true)
  expect(boxes.map((b) => b.id)).toEqual(["ceo", "a", "x", "b", "solo"])
})

test("an edge is an elbow: down from the parent, across, down to the child's top", () => {
  const { boxes, edges } = layout([n("p", n("c"))], () => true)
  const p = boxes.find((b) => b.id === "p")!
  const e = edges[0]
  expect(e).toMatchObject({ from: "p", to: "c" })
  expect(e.points[0]).toEqual([p.x + CARD.w / 2, p.y + CARD.h])
  expect(e.points[1][1]).toBe(CARD.h + CARD.gapY / 2)
  expect(e.points.at(-1)![1]).toBe(CARD.h + CARD.gapY)
})

test("several roots sit side by side; width and height bound everything", () => {
  const r = layout([n("a"), n("b", n("c"))], () => true)
  expect(r.width).toBe(2 * slot - CARD.gapX)
  expect(r.height).toBe(2 * CARD.h + CARD.gapY)
})

test("nothing to draw is an empty chart", () => {
  expect(layout([], () => true)).toEqual({ boxes: [], edges: [], width: 0, height: 0 })
})

test("a few hundred people lay out in one pass", () => {
  const big = n("ceo", ...Array.from({ length: 20 }, (_, i) => n(`m${i}`, ...Array.from({ length: 20 }, (_, j) => n(`a${i}.${j}`)))))
  const r = layout([big], () => true)
  expect(r.boxes).toHaveLength(421)
  expect(r.edges).toHaveLength(420)
  expect(r.width).toBe(400 * slot - CARD.gapX)
})
