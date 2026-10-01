import { createEffect, createMemo } from "solid-js"
import { useArgs } from "../../context/args"
import { useRoute } from "../../context/route"
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
  // `null` is the hire row, so it can never collide with a handle.
  const options = createMemo<DialogSelectOption<string | null>[]>(() => [
    ...pickerRows(office.state).map(({ person, group }) => ({
      title: `@${person.handle}`,
      description: `${person.name} · ${person.title}`,
      value: person.handle,
      category: group,
    })),
    { title: "Hire new…", value: null },
  ])
  return (
    <DialogSelect
      title="Who do you want to talk to?"
      placeholder="Search people"
      options={options()}
      current={local.person.current()?.handle}
      onSelect={(option) => {
        if (option.value === null) return dialog.replace(() => <DialogHire />)
        local.person.set(option.value)
        dialog.clear()
      }}
    />
  )
}

/**
 * Opens the picker once, when the office first comes online, if the TUI started on home with no
 * person, session, or prompt chosen and nobody has worked in this folder yet.
 */
export function usePickerOnStart() {
  const office = useOffice()
  const dialog = useDialog()
  const args = useArgs()
  const route = useRoute()
  let decided = false
  createEffect(() => {
    // "online" is set only after the loaded lists reach `state`, so `folderPeople` is current here.
    if (decided || office.status() !== "online") return
    decided = true
    const chosen = args.person || args.sessionID || args.continue || args.prompt
    if (chosen || route.data.type !== "home" || office.state.folderPeople.length || dialog.stack.length) return
    dialog.replace(() => <DialogPeople />)
  })
}
