import { expect, test } from "bun:test"
import { arrow, CARD, fit, layout, pan, pinch, reveal, zoomAt, type LayoutNode } from "../src/company/layout"

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

test("fit scales the whole chart into the view, never above 1, and centres it", () => {
  expect(fit({ width: 2000, height: 500 }, { width: 1000, height: 1000 })).toEqual({ k: 0.5, x: 0, y: 375 })
  expect(fit({ width: 100, height: 100 }, { width: 1000, height: 1000 })).toEqual({ k: 1, x: 450, y: 450 })
  // No floor: a very wide company still fits entirely.
  expect(fit({ width: 14000, height: 200 }, { width: 1000, height: 600 }).k).toBeCloseTo(1000 / 14000)
})

test("fit leaves a margin around the chart when asked", () => {
  expect(fit({ width: 960, height: 100 }, { width: 1000, height: 1000 }, 20)).toEqual({ k: 1, x: 20, y: 450 })
  expect(fit({ width: 1920, height: 100 }, { width: 1000, height: 1000 }, 20).k).toBe(0.5)
})

test("an empty view or chart fits without dividing by zero", () => {
  expect(fit({ width: 0, height: 0 }, { width: 1000, height: 500 })).toEqual({ k: 1, x: 500, y: 250 })
  expect(fit({ width: 500, height: 500 }, { width: 0, height: 0 }).k).toBeGreaterThan(0)
})

test("zooming keeps the point under the cursor still, within 0.2 and 2", () => {
  expect(zoomAt({ k: 1, x: 0, y: 0 }, 2, [100, 100])).toEqual({ k: 2, x: -100, y: -100 })
  expect(zoomAt({ k: 2, x: 0, y: 0 }, 4, [0, 0]).k).toBe(2)
  expect(zoomAt({ k: 1, x: 0, y: 0 }, 0.01, [0, 0]).k).toBe(0.2)
  // Below the floor after a fit: zooming out goes no further, zooming in works.
  expect(zoomAt({ k: 0.1, x: 0, y: 0 }, 0.5, [0, 0]).k).toBe(0.1)
  expect(zoomAt({ k: 0.1, x: 0, y: 0 }, 1.5, [0, 0]).k).toBeCloseTo(0.15)
})

test("pan moves by the pointer's travel", () => {
  expect(pan({ k: 2, x: 1, y: 1 }, 10, -5)).toEqual({ k: 2, x: 11, y: -4 })
})

test("two pointers moving apart zoom about their midpoint; moving together pans", () => {
  expect(pinch({ k: 1, x: 0, y: 0 }, [[0, 0], [100, 0]], [[-50, 0], [150, 0]])).toEqual({ k: 2, x: -50, y: 0 })
  expect(pinch({ k: 1, x: 0, y: 0 }, [[0, 0], [100, 0]], [[10, 10], [110, 10]])).toEqual({ k: 1, x: 10, y: 10 })
})

test("two pointers on one spot don't zoom by a division by zero", () => {
  expect(pinch({ k: 1, x: 0, y: 0 }, [[5, 5], [5, 5]], [[5, 5], [5, 5]])).toEqual({ k: 1, x: 0, y: 0 })
})

test("arrow keys go up to the manager, down to the first report, and across the row", () => {
  const drawn = layout([n("ceo", n("a", n("x"), n("y")), n("b", n("z"))), n("solo")], () => true)
  const go = (at: string, key: string) => arrow(drawn, at, key)
  expect(go("ceo", "ArrowDown")).toBe("a")
  expect(go("a", "ArrowDown")).toBe("x")
  expect(go("y", "ArrowUp")).toBe("a")
  expect(go("ceo", "ArrowUp")).toBeUndefined()
  expect(go("x", "ArrowDown")).toBeUndefined()
  expect(go("a", "ArrowRight")).toBe("b")
  // Across the row, past a branch's edge: y and z have different managers.
  expect(go("y", "ArrowRight")).toBe("z")
  expect(go("z", "ArrowLeft")).toBe("y")
  expect(go("ceo", "ArrowRight")).toBe("solo")
  expect(go("x", "ArrowLeft")).toBeUndefined()
  expect(go("b", "Home")).toBe("ceo")
  expect(go("ceo", "End")).toBe("solo")
  expect(go("ceo", "Enter")).toBeUndefined()
})

test("a closed branch has no report to go down to", () => {
  const drawn = layout([n("ceo", n("a", n("x")))], (id) => id !== "a")
  expect(arrow(drawn, "a", "ArrowDown")).toBeUndefined()
})

test("reveal pans a card just into view, and leaves a card in view alone", () => {
  const view = { width: 1000, height: 600 }
  const t = { k: 1, x: 0, y: 0 }
  expect(reveal(t, { id: "a", x: 100, y: 100 }, view, 10)).toBe(t)
  // Off the right edge: moved left just enough, with the margin.
  expect(reveal(t, { id: "a", x: 900, y: 100 }, view, 10)).toEqual({ k: 1, x: 1000 - 10 - 900 - CARD.w, y: 0 })
  // Above the top: moved down.
  expect(reveal(t, { id: "a", x: 100, y: -300 }, view, 10)).toEqual({ k: 1, x: 0, y: 310 })
  // Scaled: the card's view position is k * x + t.x.
  expect(reveal({ k: 2, x: 0, y: 0 }, { id: "a", x: -100, y: 50 }, view, 10)).toEqual({ k: 2, x: 210, y: 0 })
})
