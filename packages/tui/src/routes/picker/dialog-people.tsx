import { createEffect, createMemo } from "solid-js"
import { isDeepEqual } from "remeda"
import { useArgs } from "../../context/args"
import { useRoute } from "../../context/route"
import { useOffice } from "../../context/office"
import { useLocal } from "../../context/local"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useDialog } from "../../ui/dialog"
import { DialogHire } from "./dialog-hire"
import { harnessesOf, pickerRows, type Harness } from "./people"

/** A picker row's value: a person and the harness a chat with them runs on. */
type PickerRow = { handle: string; harness: Harness }

/** Picks the person to talk to, and the harness when they use more than one; the last row opens the hire form. */
export function DialogPeople() {
  const office = useOffice()
  const local = useLocal()
  const dialog = useDialog()
  // `null` is the hire row, so it can never collide with a person.
  const options = createMemo<DialogSelectOption<PickerRow | null>[]>(() => [
    ...pickerRows(office.state).flatMap(({ person, group }) =>
      harnessesOf(person).map((harness) => ({
        title: harness === "codex" ? `@${person.handle} · Codex` : `@${person.handle}`,
        description: `${person.name} · ${person.title}`,
        value: { handle: person.handle, harness },
        category: group,
      })),
    ),
    { title: "Hire new…", value: null },
  ])
  // DialogSelect finds the current row by deep equality, so this is a value like the rows'. An equal value
  // keeps its identity, so an office refresh that rebuilds the people list doesn't move the highlight back.
  const current = createMemo(
    () => {
      const person = local.person.current()
      return person ? { handle: person.handle, harness: local.harness.current() } : undefined
    },
    undefined,
    { equals: isDeepEqual },
  )
  return (
    <DialogSelect
      title="Who do you want to talk to?"
      placeholder="Search people"
      options={options()}
      current={current()}
      onSelect={(option) => {
        if (option.value === null) return dialog.replace(() => <DialogHire />)
        local.person.set(option.value.handle)
        local.harness.set(option.value.handle, option.value.harness)
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
