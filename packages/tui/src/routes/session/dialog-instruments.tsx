import type { Instrument } from "@opencorp/protocol"
import { DialogSelect } from "../../ui/dialog-select"
import { useDialog } from "../../ui/dialog"
import { display } from "../../util/printable"

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
