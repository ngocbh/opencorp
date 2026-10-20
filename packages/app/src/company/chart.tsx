import {
  createComputed,
  createEffect,
  createMemo,
  createSelector,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { describe, personCost } from "./format"
import { arrow, firstView, fit, layout, pan, pinch, readable, reveal, zoomAt, type Box, type Transform } from "./layout"
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
  // Lines too: keyed by "from>to", so a new layout moves the ones still drawn instead of making them again.
  const edges = createMemo(() => new Map(drawn().edges.map((e) => [`${e.from}>${e.to}`, e])))
  const edgeKeys = createMemo(() => [...edges().keys()])
  const isSelected = createSelector(() => props.selected)
  const uid = createUniqueId()
  let viewport!: HTMLDivElement
  const [t, setT] = createSignal<Transform>({ k: 1, x: 0, y: 0 })
  const view = () => ({ width: viewport.clientWidth, height: viewport.clientHeight })
  // Until the viewer pans or zooms, the chart shows its first view (readable) or, after Fit, all of it, and shows it
  // again whenever the view or the chart changes size.
  let fitting: "first" | "all" | null = "first"
  /** Shows the first view (`"first"`) or the whole chart (`"all"`). */
  const fitNow = (how: "first" | "all") => {
    fitting = how
    setT(how === "all" ? fit(drawn(), view(), MARGIN) : firstView(drawn(), view(), MARGIN))
  }
  /** Moves the canvas for the viewer: from then on, it keeps where they put it. */
  const moveTo = (next: Transform) => {
    fitting = null
    setT(next)
  }
  // Pointers down on the chart, in viewport coordinates: one pans, two pinch.
  const pointers = new Map<number, [number, number]>()
  /** Whether the press so far is a drag, not a click. */
  let dragging = false
  /** Whether a drag is going on now: the cursor grabs. */
  const [grabbing, setGrabbing] = createSignal(false)
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = viewport.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  function down(e: PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return // the right button opens a menu; it doesn't pan
    pointers.set(e.pointerId, local(e))
    dragging = false
  }
  function move(e: PointerEvent) {
    const prev = pointers.get(e.pointerId)
    if (!prev) return
    // A release we never heard of (outside the window, say): the mouse is only hovering now.
    if (e.pointerType === "mouse" && e.buttons === 0) return up(e)
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
      setGrabbing(true)
      try {
        viewport.setPointerCapture(e.pointerId) // the drag keeps going outside the chart
      } catch {} // a synthetic pointer can't be captured
    }
    moveTo(pan(t(), next[0] - prev[0], next[1] - prev[1]))
    pointers.set(e.pointerId, next)
  }
  function up(e: PointerEvent) {
    pointers.delete(e.pointerId)
    if (!pointers.size) setGrabbing(false)
  }
  // A drag that ends on a card isn't that card's click. A keyboard's click (Enter or Space on a card, detail 0) is.
  const swallowDragClick = (e: MouseEvent) => {
    if (dragging && e.detail > 0) e.stopPropagation()
  }
  const center = (): [number, number] => [viewport.clientWidth / 2, viewport.clientHeight / 2]
  function onWheel(e: WheelEvent) {
    e.preventDefault() // the page doesn't scroll under the chart
    // Deltas in pixels; some mice report lines or pages.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewport.clientHeight : 1
    // A trackpad pinch arrives as the wheel with ctrlKey and small deltas, so it zooms harder; sideways pans.
    const zoomed = zoomAt(t(), Math.exp((-e.deltaY * unit) / (e.ctrlKey ? 100 : 500)), local(e))
    moveTo(pan(zoomed, -e.deltaX * unit, 0))
  }
  // Keyboard access: the cards are one tab stop (a roving tabindex, as in the list), and arrow keys move between them.
  const [focused, setFocused] = createSignal<string>()
  /** The card with tabindex 0: the focused one while it's drawn, else the first. */
  const current = () => (boxes().has(focused() ?? "") ? focused() : ids()[0])
  const isCurrent = createSelector(current)
  const elements = new Map<string, HTMLElement>()
  // Focus scrolls the viewport to show a card (overflow: hidden still scrolls). The canvas's transform does that job,
  // so a scroll becomes a pan, and the transform stays the whole story of where the canvas is.
  function unscroll() {
    const { scrollLeft: x, scrollTop: y } = viewport
    if (!x && !y) return
    viewport.scrollLeft = viewport.scrollTop = 0
    moveTo(pan(t(), -x, -y))
  }
  /**
   * Card `id` became the current one: pan it into view if it isn't. Keyboard focus also zooms in to where a card
   * reads; a click leaves the zoom alone.
   */
  function onCardFocus(id: string, keyboard: boolean) {
    setFocused(id)
    unscroll()
    // A press focuses the card under it: moving the card then could take it from under the pointer before the click.
    if (pointers.size) return
    const box = boxes().get(id)
    const next = box && (keyboard ? readable : reveal)(t(), box, view(), MARGIN)
    if (next && next !== t()) moveTo(next)
  }
  function focusCard(id: string) {
    onCardFocus(id, true)
    elements.get(id)?.focus({ preventScroll: true })
  }
  function onCardKey(e: KeyboardEvent, id: string) {
    const to = arrow(drawn(), id, e.key)
    if (to === undefined) return
    e.preventDefault()
    focusCard(to)
  }
  // Each card's manager as last seen, kept for cards that have gone: every ancestor of a card was drawn with it.
  const parents = new Map<string, string | null>()
  createComputed(() => rows().forEach((r) => parents.set(r.item.id, r.parent)))
  /** A card that had focus when it went away (its branch closed, filtered out, moved in the company). */
  let lost: string | undefined
  createEffect(() => {
    const drawnNow = boxes()
    if (lost === undefined) return
    // Parents as last seen can loop after a reorg (two people swapped), so each is visited once.
    const seen = new Set([lost])
    let to: string | null | undefined = parents.get(lost)
    while (to && !drawnNow.has(to) && !seen.has(to)) {
      seen.add(to)
      to = parents.get(to)
    }
    lost = undefined
    const target = to && drawnNow.has(to) ? to : ids()[0]
    if (target) focusCard(target)
  })
  /** Keeps card `id`'s focusable element, and notes when it leaves the page while it holds focus. */
  const register = (id: string, el: HTMLElement) => {
    elements.set(id, el)
    // Runs before the card leaves the page, while it can still hold focus.
    onCleanup(() => {
      elements.delete(id)
      if (document.activeElement === el) lost = id
    })
  }
  /** The card to keep in view when the view changes size: the panel's person's, else the focused one. */
  function kept() {
    const handle = props.selected
    if (handle !== undefined)
      for (const id of ids()) {
        const item = byId().get(id)?.item
        if (item && personOf(item)?.handle === handle && !isMuted(item)) return id
      }
    return ids().find((id) => elements.get(id) === document.activeElement)
  }
  /** The view changed size: fit again if the chart still shows its fit, and keep the kept card in view. */
  function resized() {
    if (fitting) fitNow(fitting)
    const id = kept()
    const box = id === undefined ? undefined : boxes().get(id)
    // Not moveTo: this follows the view, it isn't the viewer moving the chart.
    if (box) setT(reveal(t(), box, view(), MARGIN))
  }
  const size = createMemo(() => `${drawn().width}x${drawn().height}`)
  createEffect(on(size, () => fitting && fitNow(fitting), { defer: true }))
  onMount(() => {
    viewport.addEventListener("scroll", unscroll)
    onCleanup(() => viewport.removeEventListener("scroll", unscroll))
    // Not Solid's onWheel: preventDefault needs a listener that isn't passive.
    viewport.addEventListener("wheel", onWheel, { passive: false })
    onCleanup(() => viewport.removeEventListener("wheel", onWheel))
    viewport.addEventListener("click", swallowDragClick, { capture: true })
    onCleanup(() => viewport.removeEventListener("click", swallowDragClick, { capture: true }))
    fitNow("first")
    const observer = new ResizeObserver(resized)
    observer.observe(viewport)
    onCleanup(() => observer.disconnect())
  })
  return (
    <figure aria-label={`${props.label} org chart`} class="relative m-0 h-[calc(100vh-8rem)] min-h-80">
      <div
        ref={viewport}
        data-testid="chart-viewport"
        data-dragging={grabbing() ? "true" : undefined}
        class="relative h-full w-full cursor-grab touch-none select-none overflow-hidden data-[dragging=true]:cursor-grabbing"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onLostPointerCapture={up}
      >
        <div
          data-testid="chart-canvas"
          data-transform={written(t())}
          class="absolute left-0 top-0 origin-top-left"
          // Computed, so Solid sets it with style.setProperty, which the CSP allows.
          style={{ transform: `translate(${t().x}px, ${t().y}px) scale(${t().k})` }}
        >
          <svg aria-hidden="true" class="absolute left-0 top-0 overflow-visible" width={drawn().width} height={drawn().height}>
            <For each={edgeKeys()}>
              {(key) => (
                <Show when={edges().get(key)}>
                  {(e) => <path data-edge={key} d={elbow(e().points)} class="fill-none stroke-neutral-300 dark:stroke-neutral-700" />}
                </Show>
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
                    current={isCurrent(id)}
                    chart={props}
                    focusable={(el) => register(id, el)}
                    onFocus={(keyboard) => onCardFocus(id, keyboard)}
                    onKey={(e) => onCardKey(e, id)}
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
        <button type="button" class={CONTROL} onClick={() => fitNow("all")}>
          Fit
        </button>
      </div>
    </figure>
  )
}

/** One card: a person's (a button that opens the side panel), or a team's header in "By team". */
function Card(props: {
  item: Item
  open: boolean
  box: Box
  selected: boolean
  descId: string
  /** Whether this card is the chart's tab stop. */
  current: boolean
  chart: ListProps
  /** Takes the card's focusable element. */
  focusable: (el: HTMLElement) => void
  /** The card took focus (`true`: not from a click). */
  onFocus: (keyboard: boolean) => void
  onKey: (e: KeyboardEvent) => void
}) {
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
          <div
            ref={props.focusable}
            role="group"
            aria-label={teamName(props.item)}
            tabindex={props.current ? 0 : -1}
            class="grid h-full place-items-center rounded-lg border-2 border-neutral-400 bg-white font-semibold outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:border-neutral-600 dark:bg-neutral-950 dark:focus-visible:ring-neutral-100"
            onFocus={() => props.onFocus(true)}
            onKeyDown={(e) => props.onKey(e)}
          >
            {teamName(props.item)}
          </div>
        }
      >
        {(p) => (
          <button
            ref={props.focusable}
            type="button"
            tabindex={props.current ? 0 : -1}
            aria-label={label(props.item)}
            aria-describedby={props.descId}
            // "By team" shows someone once in full and muted elsewhere: only the full card is the selected one.
            aria-current={props.selected && !isMuted(props.item) ? "true" : undefined}
            class="flex h-full w-full flex-col justify-center gap-1 overflow-hidden rounded-lg border border-neutral-300 bg-white px-2 pb-3 pt-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 aria-[current=true]:border-neutral-900 aria-[current=true]:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-950 dark:focus-visible:ring-neutral-100 dark:aria-[current=true]:border-neutral-100 dark:aria-[current=true]:bg-neutral-900"
            onFocus={() => props.onFocus(true)}
            onKeyDown={(e) => props.onKey(e)}
            onClick={() => {
              props.onFocus(false) // a click doesn't focus a button in every browser; the panel gives focus back here
              props.chart.onSelect(p().handle)
            }}
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
          aria-label={`${personOf(props.item)?.name ?? teamName(props.item)}'s branch`}
          aria-expanded={props.open}
          // After its card in the tab order, for the current card only: the chart stays a short stop on the way past.
          tabindex={props.current ? 0 : -1}
          class="absolute -bottom-3 left-1/2 h-6 min-w-6 -translate-x-1/2 rounded-full border border-neutral-300 bg-white px-1.5 text-xs leading-none text-neutral-600 outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:focus-visible:ring-neutral-100"
          onClick={() => props.chart.setOpen(props.item.id, !props.open)}
        >
          {props.open ? "−" : `+${props.item.children.length}`}
        </button>
      </Show>
    </div>
  )
}
