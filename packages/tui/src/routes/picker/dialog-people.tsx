import { createMemo } from "solid-js"
import { useOffice } from "../../context/office"
import { useLocal } from "../../context/local"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useDialog } from "../../ui/dialog"
import { DialogHire } from "./dialog-hire"
import { pickerRows } from "./people"

/** Picks the person to talk to; the last row opens the hire form. */
export function DialogPeople() {
  const office = useOffice()
  const local = useLocal()
  const dialog = useDialog()
  // `null` is the hire row, so it can never collide with a person id.
  const options = createMemo<DialogSelectOption<string | null>[]>(() => [
    ...pickerRows(office.state).map(({ person, group }) => ({
      title: `@${person.handle}`,
      description: `${person.name} · ${person.title}`,
      value: person.id,
      category: group,
    })),
    { title: "Hire new…", value: null },
  ])
  return (
    <DialogSelect
      title="Who do you want to talk to?"
      placeholder="Search people"
      options={options()}
      current={local.person.current()?.id}
      onSelect={(option) => {
        if (option.value === null) return dialog.replace(() => <DialogHire />)
        local.person.set(option.value)
        dialog.clear()
      }}
    />
  )
}
