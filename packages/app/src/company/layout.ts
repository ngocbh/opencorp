// The org chart's geometry: where each card and line goes. Pure, so it's tested without a browser.

/** A node to lay out: a person, or a team header in "By team". */
export type LayoutNode = { id: string; children: LayoutNode[] }
/** A card's top-left corner, in canvas pixels. */
export type Box = { id: string; x: number; y: number }
/** A line from a manager's card to a report's: four points, down, across, down. */
export type Edge = { from: string; to: string; points: [number, number][] }

/** A card's size and the gaps between cards; the chart's card classes match `w` and `h`. */
export const CARD = { w: 208, h: 96, gapX: 24, gapY: 48 }

/**
 * A top-down tree: a leaf or a closed branch is one card wide, a branch as wide as its children together, and each
 * parent is centred over its first and last child. Simpler than Reingold-Tilford, and enough for a company's tree.
 * Boxes come in tree order (a parent before its children), the order the cards take focus in.
 */
export function layout(roots: LayoutNode[], open: (id: string) => boolean) {
  const slot = CARD.w + CARD.gapX
  const row = CARD.h + CARD.gapY
  const drawn = (node: LayoutNode) => node.children.length > 0 && open(node.id)
  const widths = new Map<string, number>()
  const width = (node: LayoutNode): number => {
    let w = widths.get(node.id)
    if (w === undefined) {
      w = drawn(node) ? node.children.reduce((sum, c) => sum + width(c), 0) : 1
      widths.set(node.id, w)
    }
    return w
  }
  const boxes: Box[] = []
  const edges: Edge[] = []
  let depthMax = 0
  /** Places `node` and what's drawn under it from `left`; returns the centre of its card. */
  const place = (node: LayoutNode, left: number, depth: number): number => {
    depthMax = Math.max(depthMax, depth)
    const y = depth * row
    const box: Box = { id: node.id, x: 0, y }
    boxes.push(box)
    let cx = left + CARD.w / 2
    if (drawn(node)) {
      const centers: number[] = []
      let at = left
      for (const child of node.children) {
        centers.push(place(child, at, depth + 1))
        at += width(child) * slot
      }
      cx = (centers[0] + centers[centers.length - 1]) / 2
      const mid = y + CARD.h + CARD.gapY / 2
      node.children.forEach((child, i) =>
        edges.push({ from: node.id, to: child.id, points: [[cx, y + CARD.h], [cx, mid], [centers[i], mid], [centers[i], y + row]] }),
      )
    }
    box.x = cx - CARD.w / 2
    return cx
  }
  let left = 0
  for (const root of roots) {
    place(root, left, 0)
    left += width(root) * slot
  }
  return { boxes, edges, width: Math.max(0, left - CARD.gapX), height: roots.length ? depthMax * row + CARD.h : 0 }
}

/** How the canvas is shown: scaled by `k`, then moved by `x`, `y` (view pixels). */
export type Transform = { k: number; x: number; y: number }
export type Size = { width: number; height: number }
export const ZOOM = { min: 0.2, max: 2 }

/**
 * The transform that shows all of `size` in `view`, `margin` pixels in from each side, centred, never above 1. No
 * floor, so every card of a very wide company fits.
 */
export function fit(size: Size, view: Size, margin = 0): Transform {
  const room = (v: number) => Math.max(v - 2 * margin, 1)
  const k = Math.min(1, room(view.width) / Math.max(size.width, 1), room(view.height) / Math.max(size.height, 1))
  return { k, x: (view.width - size.width * k) / 2, y: (view.height - size.height * k) / 2 }
}

/** The smallest zoom a card reads at: the first view and keyboard focus don't go below it. */
export const FLOOR = 0.6

/**
 * The view a chart opens on: the fit when it's readable (`k` at FLOOR or above), else FLOOR with the first root
 * centred across the view and `margin` from the top. Fit (the button) still shows everything.
 */
export function firstView(drawn: Size & { boxes: Box[] }, view: Size, margin = 0): Transform {
  const all = fit(drawn, view, margin)
  const root = drawn.boxes[0]
  if (all.k >= FLOOR || !root) return all
  return { k: FLOOR, x: view.width / 2 - (root.x + CARD.w / 2) * FLOOR, y: margin }
}

/**
 * `t` zoomed by `factor` about the view point `[px, py]`, which stays still. `k` stays within ZOOM, except that a fit
 * below the floor can only zoom in from there.
 */
export function zoomAt(t: Transform, factor: number, [px, py]: [number, number]): Transform {
  const k = Math.min(ZOOM.max, Math.max(Math.min(ZOOM.min, t.k), t.k * factor))
  const r = k / t.k
  return { k, x: px - (px - t.x) * r, y: py - (py - t.y) * r }
}

type Point = [number, number]

/** `t` moved by the pointer's travel. */
export const pan = (t: Transform, dx: number, dy: number): Transform => ({ ...t, x: t.x + dx, y: t.y + dy })

const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1])

/**
 * Two pointers moving from `before` to `after`: zoom about their midpoint by how much farther apart they are, and
 * pan with the midpoint. Pointers that started on one spot only pan.
 */
export function pinch(t: Transform, before: [Point, Point], after: [Point, Point]): Transform {
  const [m0, m1] = [mid(...before), mid(...after)]
  const d0 = dist(...before)
  const zoomed = d0 < 1 ? t : zoomAt(t, dist(...after) / d0, m0)
  return pan(zoomed, m1[0] - m0[0], m1[1] - m0[1])
}

/**
 * Where an arrow key goes from card `at`: up to its manager, down to its first drawn report, left and right to the
 * nearest card on its row (across branches too); Home and End to the first and last card. Undefined when there's
 * nowhere to go, or for another key.
 */
export function arrow(drawn: { boxes: Box[]; edges: Edge[] }, at: string, key: string): string | undefined {
  const box = drawn.boxes.find((b) => b.id === at)
  if (!box) return drawn.boxes[0]?.id
  const across = (dir: 1 | -1) => {
    let best: Box | undefined
    for (const b of drawn.boxes)
      if (b.y === box.y && (b.x - box.x) * dir > 0 && (!best || Math.abs(b.x - box.x) < Math.abs(best.x - box.x))) best = b
    return best?.id
  }
  switch (key) {
    case "ArrowUp":
      return drawn.edges.find((e) => e.to === at)?.from
    case "ArrowDown":
      return drawn.edges.find((e) => e.from === at)?.to
    case "ArrowLeft":
      return across(-1)
    case "ArrowRight":
      return across(1)
    case "Home":
      return drawn.boxes[0].id
    case "End":
      return drawn.boxes[drawn.boxes.length - 1].id
  }
  return undefined
}

/** `t` panned just enough to show `box` in `view`, `margin` pixels in from the edges; `t` itself when it's in view. */
export function reveal(t: Transform, box: Box, view: Size, margin = 0): Transform {
  const shift = (start: number, size: number, room: number) => {
    if (start < margin) return margin - start
    if (start + size > room - margin) return Math.max(room - margin - start - size, margin - start)
    return 0
  }
  const dx = shift(t.x + box.x * t.k, CARD.w * t.k, view.width)
  const dy = shift(t.y + box.y * t.k, CARD.h * t.k, view.height)
  return dx || dy ? pan(t, dx, dy) : t
}

/** `t` zoomed up to FLOOR about `box` if it's below, then panned to show `box`: a card that takes focus can be read. */
export function readable(t: Transform, box: Box, view: Size, margin = 0): Transform {
  const zoomed = t.k < FLOOR ? zoomAt(t, FLOOR / t.k, [t.x + (box.x + CARD.w / 2) * t.k, t.y + (box.y + CARD.h / 2) * t.k]) : t
  return reveal(zoomed, box, view, margin)
}
