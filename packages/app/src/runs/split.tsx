// The splitter between the Timeline and node detail on a desktop: node detail's width, dragged or keyed, remembered
// by this browser and clamped to the page.
import { forget, readStored, store } from "../data/storage"

/** Node detail's narrowest width, in pixels. */
export const DETAIL_MIN = 320
/** The Timeline's narrowest width beside node detail, in pixels. */
export const TIMELINE_MIN = 280
/** The splitter's width, in pixels: its `w-3`, a target wider than the line it draws. */
export const SPLITTER_PX = 12
/** How far one arrow key moves the splitter, in pixels. */
const STEP = 16
const KEY = "hq.runs.detailWidth"

/** Node detail's narrowest and widest widths in `room` pixels; on a page too narrow for both mins, the Timeline's wins. */
export function detailBounds(room: number) {
  const max = Math.max(0, room - TIMELINE_MIN)
  return { min: Math.min(DETAIL_MIN, max), max }
}

/** Node detail's width in `room` pixels: the chosen one (null for none: half the room), clamped to its bounds. */
export function detailWidth(chosen: number | null, room: number) {
  const { min, max } = detailBounds(room)
  return Math.round(Math.min(max, Math.max(min, chosen ?? room / 2)))
}

/** The width this browser chose for node detail, or null for none (or one it can't read). */
export function readDetailWidth(): number | null {
  const n = Number(readStored("localStorage", KEY) ?? NaN)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Remembers `width` as this browser's choice; null forgets it. A browser that refuses storage forgets it anyway. */
export function saveDetailWidth(width: number | null) {
  if (width === null) forget("localStorage", KEY)
  else store("localStorage", KEY, String(Math.round(width)))
}

/**
 * The splitter: the WAI-ARIA window splitter pattern, its value node detail's width. A pointer drag, the arrows (Left
 * widens node detail), Home and End (its min and max), and Enter or a double-click (back to the default).
 */
export function Splitter(props: {
  /** The id of node detail. */
  controls: string
  value: number
  min: number
  max: number
  /** A new width, which the caller clamps to the bounds. */
  onResize: (width: number) => void
  /** The drag or key that resized it is done: the width can be remembered. */
  onCommit: () => void
  onReset: () => void
}) {
  // The drag's start: where the pointer went down and the width then.
  let start: { x: number; width: number } | undefined
  function down(e: PointerEvent) {
    if (e.button !== 0) return
    e.preventDefault() // no text selection while dragging
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId) // the drag goes on outside the splitter
    el.focus()
    start = { x: e.clientX, width: props.value }
  }
  function move(e: PointerEvent) {
    if (start) props.onResize(start.width - (e.clientX - start.x))
  }
  function up() {
    if (!start) return
    start = undefined
    props.onCommit()
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowLeft") props.onResize(props.value + STEP)
    else if (e.key === "ArrowRight") props.onResize(props.value - STEP)
    else if (e.key === "Home") props.onResize(props.min)
    else if (e.key === "End") props.onResize(props.max)
    else if (e.key === "Enter") return void (e.preventDefault(), props.onReset())
    else return
    e.preventDefault()
    props.onCommit()
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize node detail"
      aria-controls={props.controls}
      aria-valuenow={props.value}
      aria-valuetext={`${props.value} pixels`}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabindex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onDblClick={() => props.onReset()}
      onKeyDown={onKey}
      class="group flex w-3 shrink-0 cursor-col-resize touch-none justify-center outline-none select-none"
    >
      {/* The border: wider and darker while hovered, focused or dragged. */}
      <span
        aria-hidden="true"
        class="w-px bg-neutral-200 group-hover:w-1 group-hover:bg-neutral-400 group-focus-visible:w-1 group-focus-visible:bg-neutral-900 group-active:w-1 group-active:bg-neutral-500 dark:bg-neutral-800 dark:group-hover:bg-neutral-600 dark:group-focus-visible:bg-neutral-100 dark:group-active:bg-neutral-400"
      />
    </div>
  )
}
