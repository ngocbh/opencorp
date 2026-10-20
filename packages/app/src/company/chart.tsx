import { createMemo, createSelector, createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js"
import { describe, personCost } from "./format"
import { fit, layout, pan, pinch, zoomAt, type Box, type Transform } from "./layout"
import type { ListProps } from "./list"
import { PersonBody } from "./person"
import { isMuted, label, personOf, teamName, visibleRows, type Item } from "./rows"

/** An elbow edge as an SVG path: down from the parent, across, down to the child's top. */
const elbow = (p: [number, number][]) => `M ${p[0][0]} ${p[0][1]} V ${p[1][1]} H ${p[2][0]} V ${p[3][1]}`
/** The transform as "k,x,y", for the tests to read. */
const written = (t: Transform) => `${t.k.toFixed(3)},${t.x.toFixed(1)},${t.y.toFixed(1)}`
const CONTROL =
  "min-w-8 rounded border border-neutral-300 bg-white px-2 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-visible:ring-neutral-100"
/** Room left around the chart when it fits the view, in view pixels. */
const MARGIN = 24

/**
 * The company as an org chart: top-down cards joined by elbow lines, on one canvas the viewer pans and zooms. It
 * shows what the list shows (the same items, open branches, status, cards, cost, totals, dimming and selection).
 */
export default function Chart(props: ListProps) {
  // The rows the list would show, in tree order: the same open branches, and the order the cards take focus in.
  const rows = createMemo(() => visibleRows(props.items, props.isOpen))
  const byId = createMemo(() => new Map(rows().map((r) => [r.item.id, r])))
  const drawn = createMemo(() => layout(props.items, (id) => byId().get(id)?.open ?? false))
  const boxes = createMemo(() => new Map(drawn().boxes.map((b) => [b.id, b])))
  // Cards are keyed by id, not by box, so a new layout (a branch opened, a live update) keeps every card's element.
  const ids = createMemo(() => drawn().boxes.map((b) => b.id))
  const isSelected = createSelector(() => props.selected)
  const uid = createUniqueId()
  let viewport!: HTMLDivElement
  const [t, setT] = createSignal<Transform>({ k: 1, x: 0, y: 0 })
  // Until the viewer touches the chart, it fits the view again whenever the view changes size.
  let fitted = true
  const fitNow = () => {
    fitted = true
    setT(fit(drawn(), { width: viewport.clientWidth, height: viewport.clientHeight }, MARGIN))
  }
  /** Moves the canvas for the viewer: from then on, it keeps where they put it. */
  const moveTo = (next: Transform) => {
    fitted = false
    setT(next)
  }
  // Pointers down on the chart, in viewport coordinates: one pans, two pinch.
  const pointers = new Map<number, [number, number]>()
  /** Whether the press so far is a drag, not a click. */
  let dragging = false
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = viewport.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  function down(e: PointerEvent) {
    fitted = false
    pointers.set(e.pointerId, local(e))
    dragging = false
  }
  function move(e: PointerEvent) {
    const prev = pointers.get(e.pointerId)
    if (!prev) return
    const next = local(e)
    if (pointers.size === 2) {
      const other = [...pointers].find(([id]) => id !== e.pointerId)![1]
      dragging = true // a pinch isn't a click either
      moveTo(pinch(t(), [prev, other], [next, other]))
      pointers.set(e.pointerId, next)
      return
    }
    // A press on a card stays a click until the pointer has moved a few pixels; the travel so far still counts.
    if (!dragging && Math.hypot(next[0] - prev[0], next[1] - prev[1]) < 4) return
    if (!dragging) {
      dragging = true
      try {
        viewport.setPointerCapture(e.pointerId) // the drag keeps going outside the chart
      } catch {} // a synthetic pointer can't be captured
    }
    moveTo(pan(t(), next[0] - prev[0], next[1] - prev[1]))
    pointers.set(e.pointerId, next)
  }
  const up = (e: PointerEvent) => void pointers.delete(e.pointerId)
  // A drag that ends on a card isn't that card's click. A keyboard's click (Enter or Space on a card, detail 0) is.
  const swallowDragClick = (e: MouseEvent) => {
    if (dragging && e.detail > 0) e.stopPropagation()
  }
  const center = (): [number, number] => [viewport.clientWidth / 2, viewport.clientHeight / 2]
  function onWheel(e: WheelEvent) {
    e.preventDefault() // the page doesn't scroll under the chart
    moveTo(zoomAt(t(), Math.exp(-e.deltaY / 500), local(e)))
  }
  onMount(() => {
    // Not Solid's onWheel: preventDefault needs a listener that isn't passive.
    viewport.addEventListener("wheel", onWheel, { passive: false })
    onCleanup(() => viewport.removeEventListener("wheel", onWheel))
    viewport.addEventListener("click", swallowDragClick, { capture: true })
    onCleanup(() => viewport.removeEventListener("click", swallowDragClick, { capture: true }))
    fitNow()
    const resized = new ResizeObserver(() => fitted && fitNow())
    resized.observe(viewport)
    onCleanup(() => resized.disconnect())
  })
  return (
    <figure aria-label={`${props.label} org chart`} class="relative m-0 h-[calc(100vh-8rem)] min-h-80">
      <div
        ref={viewport}
        data-testid="chart-viewport"
        class="relative h-full w-full cursor-grab touch-none select-none overflow-hidden"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <div
          data-testid="chart-canvas"
          data-transform={written(t())}
          class="absolute left-0 top-0 origin-top-left"
          // Computed, so Solid sets it with style.setProperty, which the CSP allows.
          style={{ transform: `translate(${t().x}px, ${t().y}px) scale(${t().k})` }}
        >
          <svg aria-hidden="true" class="absolute left-0 top-0 overflow-visible" width={drawn().width} height={drawn().height}>
            <For each={drawn().edges}>
              {(e) => (
                <path data-edge={`${e.from}>${e.to}`} d={elbow(e.points)} class="fill-none stroke-neutral-300 dark:stroke-neutral-700" />
              )}
            </For>
          </svg>
          <For each={ids()}>
            {(id) => (
              <Show when={byId().get(id)}>
                {(row) => (
                  <Card
                    item={row().item}
                    open={row().open}
                    box={boxes().get(id)!}
                    selected={!!personOf(row().item) && isSelected(personOf(row().item)!.handle)}
                    descId={`${uid}-${id}`}
                    chart={props}
                  />
                )}
              </Show>
            )}
          </For>
        </div>
      </div>
      <div class="absolute bottom-3 right-3 flex gap-1">
        <button type="button" aria-label="Zoom in" class={CONTROL} onClick={() => moveTo(zoomAt(t(), 1.25, center()))}>
          +
        </button>
        <button type="button" aria-label="Zoom out" class={CONTROL} onClick={() => moveTo(zoomAt(t(), 0.8, center()))}>
          −
        </button>
        <button type="button" class={CONTROL} onClick={fitNow}>
          Fit
        </button>
      </div>
    </figure>
  )
}

/** One card: a person's (a button that opens the side panel), or a team's header in "By team". */
function Card(props: { item: Item; open: boolean; box: Box; selected: boolean; descId: string; chart: ListProps }) {
  const person = () => personOf(props.item)
  const closed = () => props.item.children.length > 0 && !props.open
  const branchStatus = () => (closed() ? props.chart.branchStatus(props.item) : undefined)
  const totals = () => (closed() ? props.chart.totals(props.item) : undefined)
  // The card's name is only "Name, title" (an aria-label replaces its content), so the rest is here, as in the list.
  const description = (handle: string) => {
    const branch = branchStatus()
    return describe({
      status: branch ?? props.chart.status(handle),
      branch: branch !== undefined,
      needs: props.chart.needs(handle),
      cost: personCost(props.chart.cost(handle)),
      totals: totals(),
    })
  }
  return (
    // The size classes match CARD in layout.ts.
    <div
      data-card={props.item.id}
      class="absolute h-[96px] w-[208px] data-[dimmed=true]:opacity-40 data-[muted=true]:opacity-60"
      data-dimmed={String(props.chart.dimmed(props.item))}
      data-muted={isMuted(props.item) ? "true" : undefined}
      // Computed, so Solid sets it with style.setProperty, which the CSP allows.
      style={{ left: `${props.box.x}px`, top: `${props.box.y}px` }}
    >
      <Show
        when={person()}
        fallback={
          <div class="grid h-full place-items-center rounded-lg border-2 border-neutral-400 bg-white font-semibold dark:border-neutral-600 dark:bg-neutral-950">
            {teamName(props.item)}
          </div>
        }
      >
        {(p) => (
          <button
            type="button"
            aria-label={label(props.item)}
            aria-describedby={props.descId}
            // "By team" shows someone once in full and muted elsewhere: only the full card is the selected one.
            aria-current={props.selected && !isMuted(props.item) ? "true" : undefined}
            class="flex h-full w-full flex-col justify-center gap-1 overflow-hidden rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 aria-[current=true]:border-neutral-900 aria-[current=true]:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-950 dark:focus-visible:ring-neutral-100 dark:aria-[current=true]:border-neutral-100 dark:aria-[current=true]:bg-neutral-900"
            onClick={() => props.chart.onSelect(p().handle)}
          >
            <PersonBody
              card
              person={p()}
              status={branchStatus() ?? props.chart.status(p().handle)}
              branch={branchStatus() !== undefined}
              needs={props.chart.needs(p().handle)}
              cost={props.chart.cost(p().handle)}
            />
            <Show when={totals()}>
              {(text) => <span data-testid="totals" class="block truncate text-xs text-neutral-500 dark:text-neutral-400">{text()}</span>}
            </Show>
            <span id={props.descId} class="sr-only">
              {description(p().handle)}
            </span>
          </button>
        )}
      </Show>
      <Show when={props.item.children.length}>
        <button
          type="button"
          aria-label={`${props.open ? "Close" : "Open"} ${personOf(props.item)?.name ?? teamName(props.item)}'s branch`}
          class="absolute -bottom-3 left-1/2 h-6 min-w-6 -translate-x-1/2 rounded-full border border-neutral-300 bg-white px-1.5 text-xs leading-none text-neutral-600 outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:focus-visible:ring-neutral-100"
          onClick={() => props.chart.setOpen(props.item.id, !props.open)}
        >
          {props.open ? "−" : `+${props.item.children.length}`}
        </button>
      </Show>
    </div>
  )
}
