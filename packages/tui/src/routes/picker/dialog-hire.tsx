import { InputRenderable, TextAttributes } from "@opentui/core"
import type { HireRequest, HireResponse, Person } from "@agent-corp/protocol"
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useOffice } from "../../context/office"
import { useLocal } from "../../context/local"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../keymap"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { blocks, confirmRequest, hireRequest, type HireForm } from "./people"

/** The color of a unified diff line: added, removed, or neither. */
export const diffColor = (theme: ReturnType<typeof useTheme>["theme"], line: string) =>
  line.startsWith("+") ? theme.diffAdded : line.startsWith("-") ? theme.diffRemoved : theme.textMuted

const FIELDS = [
  { key: "name", label: "Name", placeholder: "Full name" },
  { key: "handle", label: "Handle", placeholder: "lowercase, e.g. lan" },
  { key: "title", label: "Title", placeholder: "Role, e.g. QA engineer" },
  { key: "manager", label: "Manager", placeholder: "@handle of their manager" },
] as const

/**
 * The hire form. Enter previews the hire (the office writes nothing and returns the diff and lint
 * issues); Enter again, with nothing edited since and no lint errors, hires and selects the person.
 */
export function DialogHire() {
  const office = useOffice()
  const local = useLocal()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [form, setForm] = createStore<HireForm>({ name: "", handle: "", title: "", manager: "" })
  let managerTyped = false
  // The manager defaults to the first human (the CEO), as soon as people are loaded.
  createEffect(() => {
    const human = office.state.people.find((p) => p.kind === "human")
    if (human && !managerTyped && !form.manager) setForm("manager", `@${human.handle}`)
  })
  const [focused, setFocused] = createSignal(0)
  const [preview, setPreview] = createSignal<{ request: HireRequest; response: HireResponse }>()
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const inputs: InputRenderable[] = []
  // Counts edits, so a preview answered after an edit is dropped instead of shown for the old fields.
  let edits = 0
  // Esc can close the form while a request is out; its answer must not touch whatever is open now.
  let closed = false
  onCleanup(() => (closed = true))

  const focus = (i: number) => {
    const n = (i + FIELDS.length) % FIELDS.length
    setFocused(n)
    inputs[n]?.focus()
  }
  onMount(() => setTimeout(() => focus(0), 1))

  async function submit() {
    if (busy()) return
    const shown = preview()
    if (shown && blocks(shown.response.issues)) return setError("Fix the errors above, then press Enter")
    const built = shown ? { request: confirmRequest(shown.request) } : hireRequest(form, office.state.people)
    if ("error" in built) return setError(built.error)
    setBusy(true)
    setError(undefined)
    const at = edits
    let response: HireResponse
    try {
      response = await office.client.people.hire(built.request)
    } catch (e) {
      if (closed) return
      setBusy(false)
      if (!shown && edits !== at) return
      // A refused confirm means the office's view changed since the preview; preview again.
      if (shown) setPreview(undefined)
      return setError(e instanceof Error ? e.message : String(e))
    }
    if (!shown) {
      if (closed) return
      setBusy(false)
      if (edits === at) setPreview({ request: built.request, response })
      return
    }
    await hired(response.person)
  }

  /**
   * The office has hired `person`, so nothing here can fail the hire. Re-reads people and says so;
   * if the form is still open, also selects the person and closes it.
   */
  async function hired(person: Person) {
    // There are no person events, so re-read the lists; if that fails the hire still stands.
    await office.refreshPeople().catch(() => {})
    toast.show({ variant: "success", message: `Hired @${person.handle}` })
    if (closed) return
    if (office.state.people.some((p) => p.handle === person.handle)) local.person.set(person.handle)
    dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      { key: "tab", group: "Hire", cmd: () => focus(focused() + 1) },
      { key: "down", group: "Hire", cmd: () => focus(focused() + 1) },
      { key: "shift+tab", group: "Hire", cmd: () => focus(focused() - 1) },
      { key: "up", group: "Hire", cmd: () => focus(focused() - 1) },
      { key: "return", group: "Hire", cmd: () => void submit() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Hire a new person
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box>
        <For each={FIELDS}>
          {(field, i) => (
            <box flexDirection="row" gap={1}>
              <text fg={focused() === i() ? theme.text : theme.textMuted} width={8}>
                {field.label}
              </text>
              <input
                flexGrow={1}
                ref={(r) => (inputs[i()] = r)}
                value={form[field.key]}
                placeholder={field.placeholder}
                placeholderColor={theme.textMuted}
                focusedBackgroundColor={theme.backgroundPanel}
                cursorColor={theme.primary}
                onInput={(value) => {
                  setForm(field.key, value)
                  if (field.key === "manager") managerTyped = true
                  edits++
                  // An edit makes the preview stale; the next Enter previews again.
                  setPreview(undefined)
                }}
              />
            </box>
          )}
        </For>
      </box>
      <Show when={preview()}>
        {(shown) => (
          <box>
            <scrollbox maxHeight={8}>
              <For each={shown().response.diff.split("\n").filter(Boolean)}>
                {(line) => <text fg={diffColor(theme, line)}>{line}</text>}
              </For>
            </scrollbox>
            <For each={shown().response.issues}>
              {(issue) => (
                <text fg={(issue.severity ?? "error") === "error" ? theme.error : theme.warning}>
                  {issue.severity ?? "error"}: {issue.path}: {issue.message}
                </text>
              )}
            </For>
          </box>
        )}
      </Show>
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
      <text fg={theme.textMuted} paddingBottom={1}>
        {busy()
          ? "Asking the office…"
          : !preview()
            ? "enter preview · tab next field"
            : blocks(preview()!.response.issues)
              ? "edit to fix, then enter to preview again"
              : "enter hire · edit to change"}
      </text>
    </box>
  )
}
