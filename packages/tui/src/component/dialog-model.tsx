import type { Connection, ModelList } from "@agent-corp/protocol"
import { TextAttributes } from "@opentui/core"
import * as fuzzysort from "fuzzysort"
import { createMemo, createSignal, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal, type ModelPick } from "../context/local"
import { useOffice } from "../context/office"
import { useRoute } from "../context/route"
import { useTheme } from "../context/theme"
import { sessionModel } from "../office/models"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useToast } from "../ui/toast"

/** A row's value: a model on a connection, or `model: null` for typing a model name there. */
type Choice = { connection: string; model: string | null }

/** What a pick on the home screen does today: nothing for new chats, which start as the office decides. */
export const HOME_PICK_NOTE =
  "New chats start on the agent's model or the office default. Turn on 'Start new chats on my last pick' to use this."

const TYPED = "Type a model name…"

/** `/model`: switches the open chat's model, or on the home screen records the pick. */
export function DialogModel() {
  const dialog = useDialog()
  const office = useOffice()
  const local = useLocal()
  const route = useRoute()
  const toast = useToast()
  const { theme } = useTheme()
  const [query, setQuery] = createSignal("")
  const [lists, setLists] = createStore<Record<string, ModelList>>({})
  const sessionID = () => (route.data.type === "session" ? route.data.sessionID : undefined)
  const session = createMemo(() => office.state.sessions.find((s) => s.id === sessionID()))
  let switching = false

  onMount(async () => {
    dialog.setSize("large")
    const list = await office.refreshConnections()
    for (const c of list?.connections ?? [])
      office.client.connections.models(c.name).then(
        (m) => setLists(c.name, m),
        (e) =>
          setLists(c.name, {
            connection: c.name,
            models: [],
            listed: false,
            error: e instanceof Error ? e.message : String(e),
          }),
      )
  })

  // DialogSelect moves the selection to `current` whenever it changes, so a session update that
  // keeps the model must not hand it a new object.
  const current = createMemo(
    () => {
      const s = session()
      if (!s) return undefined
      const { connection, model } = sessionModel(s, office.connections())
      return model ? { connection, model } : undefined
    },
    undefined,
    { equals: (a, b) => a?.connection === b?.connection && a?.model === b?.model },
  )

  /** A connection's models: its own first when the host doesn't list it, as the office does. */
  const modelsOf = (c: Connection) => {
    const ids = lists[c.name]?.models.map((m) => m.id) ?? []
    return c.model && !ids.includes(c.model) ? [c.model, ...ids] : ids
  }

  const connectionRows = createMemo(() =>
    (office.connections()?.connections ?? []).flatMap((c): DialogSelectOption<Choice>[] => {
      const list = lists[c.name]
      const category = `${c.name} (${c.provider})`
      const note = !list ? "listing…" : list.error ? `couldn't list: ${list.error}` : undefined
      const categoryView = note ? (
        <text>
          <span style={{ fg: theme.accent, attributes: TextAttributes.BOLD }}>{category}</span>
          <span style={{ fg: theme.textMuted }}> {note}</span>
        </text>
      ) : undefined
      const row = (title: string, model: string | null) => ({
        title,
        value: { connection: c.name, model },
        category,
        categoryView,
      })
      return [...modelsOf(c).map((m) => row(m, m)), ...(list && !list.listed ? [row(TYPED, null)] : [])]
    }),
  )

  const options = createMemo(() => {
    const rows = connectionRows()
    const needle = query()
    // Title matches count double, as in DialogSelect's own filter.
    if (needle)
      return fuzzysort
        .go(needle, rows, { keys: ["title", "category"], scoreFn: (r) => r[0].score * 2 + r[1].score })
        .map((x) => x.obj)
    const favorite = local.model.favorite()
    const recent = local.model.recent().filter((p) => !local.model.isFavorite(p))
    const same = (a: ModelPick) => (b: Choice) => a.connection === b.connection && a.model === b.model
    const shown = [...favorite, ...recent]
    const pickRow = (p: ModelPick, category: string) => ({
      title: p.model,
      description: p.connection,
      value: p as Choice,
      category,
    })
    // A pick shows once, in Favorites or Recent, so one row is marked as the session's model.
    return [
      ...favorite.map((p) => pickRow(p, "Favorites")),
      ...recent.map((p) => pickRow(p, "Recent")),
      ...rows.filter((r) => r.value.model === null || !shown.some((p) => same(p)(r.value))),
    ]
  })

  async function choose(choice: Choice) {
    if (choice.model !== null) return apply({ connection: choice.connection, model: choice.model })
    const typed = await DialogPrompt.show(dialog, `Model on ${choice.connection}`, { placeholder: TYPED })
    const model = typed?.trim()
    if (!model) return dialog.clear()
    await apply({ connection: choice.connection, model })
  }

  async function apply(pick: ModelPick) {
    const id = sessionID()
    if (!id) {
      local.model.pick(pick)
      dialog.clear()
      toast.show({ variant: "info", message: HOME_PICK_NOTE, duration: 8000 })
      return
    }
    if (switching) return
    switching = true
    try {
      await office.client.sessions.setModel(id, pick)
    } catch (e) {
      toast.error(e)
      return
    } finally {
      switching = false
    }
    local.model.pick(pick)
    dialog.clear()
    toast.show({ variant: "success", message: `Next reply uses ${pick.connection}/${pick.model}` })
  }

  return (
    <DialogSelect<Choice>
      title="Select model"
      placeholder="Search models"
      options={options()}
      current={current()}
      flat={true}
      skipFilter={true}
      onFilter={setQuery}
      onSelect={(option) => void choose(option.value)}
      actions={[
        {
          command: "model.dialog.favorite",
          title: "favorite",
          disabled: (option) => option?.value.model == null,
          onTrigger: (option) => {
            const { connection, model } = option.value
            if (model !== null) local.model.toggleFavorite({ connection, model })
          },
        },
      ]}
    />
  )
}
