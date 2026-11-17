import type { Instrument } from "@opencorp/protocol"
import { onMount } from "solid-js"
import { DialogSelect } from "../../ui/dialog-select"
import { useDialog } from "../../ui/dialog"
import { display } from "../../util/printable"
import { PLACEMENTS, type InstrumentPlacement } from "./instrument-view"

/** Each view an instrument can open in, and what it looks like. */
const VIEWS: Record<InstrumentPlacement, { title: string; description: string }> = {
  floating: { title: "Floating", description: "Over the chat, in the middle of the screen" },
  split: { title: "In a split", description: "Beside the chat, its width dragged with its edge" },
  full: { title: "Full screen", description: "In the chat's place, above the line under the prompt" },
}

/** Picks the view an instrument opens in, on this device, the current one marked. */
export function DialogInstrumentView(props: {
  current: InstrumentPlacement
  onPick: (view: InstrumentPlacement) => void
}) {
  const dialog = useDialog()
  // Wide enough for each view's line on a 100-column terminal.
  onMount(() => dialog.setSize("large"))
  return (
    <DialogSelect<InstrumentPlacement>
      title="Open instruments"
      options={PLACEMENTS.map((view) => ({ value: view, ...VIEWS[view] }))}
      current={props.current}
      onSelect={(option) => {
        props.onPick(option.value)
        dialog.clear()
      }}
    />
  )
}

/** Lists the chat's shells, each with its status and command; the one picked opens. */
export function DialogInstruments(props: {
  instruments: readonly Instrument[]
  current?: string
  onOpen: (id: string) => void
}) {
  const dialog = useDialog()
  return (
    <DialogSelect<string>
      title="Open an instrument"
      placeholder="Search instruments"
      options={props.instruments.map((instrument) => ({
        title: display(instrument.name),
        value: instrument.id,
        description: [instrument.status, instrument.command && display(instrument.command).replace(/\s+/g, " ").trim()]
          .filter(Boolean)
          .join(" · "),
      }))}
      current={props.current}
      onSelect={(option) => {
        dialog.clear()
        props.onOpen(option.value)
      }}
    />
  )
}
