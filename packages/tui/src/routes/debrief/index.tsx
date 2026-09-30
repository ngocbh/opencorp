import type { Debrief as DebriefData } from "@agent-corp/protocol"
import { useRenderer } from "@opentui/solid"
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useOffice } from "../../context/office"
import { useRoute, useRouteData } from "../../context/route"
import { useTheme } from "../../context/theme"
import { OPENCODE_BASE_MODE, useBindings } from "../../keymap"
import { OfficeError } from "../../office/errors"
import { Toast, useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { personLabel } from "../../util/transcript"

/** Registers `/debrief`: opens the current session's debrief. */
export function useDebriefCommands() {
  const route = useRoute()
  const toast = useToast()
  useBindings(() => ({
    commands: [
      {
        namespace: "palette",
        name: "debrief.show",
        title: "Open debrief",
        category: "Session",
        slashName: "debrief",
        run: () => {
          if (route.data.type === "session") route.navigate({ type: "debrief", sessionID: route.data.sessionID })
          else if (route.data.type !== "debrief")
            toast.show({ variant: "warning", message: "Open a session first", duration: 3000 })
        },
      },
    ],
  }))
}

/**
 * A session's debrief: summary, status, artifacts, decisions, follow-ups, open questions and
 * cost. Space marks follow-ups and `c` confirms them, which makes a work item for each.
 */
export function Debrief() {
  const data = useRouteData("debrief")
  const route = useRoute()
  const office = useOffice()
  const renderer = useRenderer()
  const toast = useToast()
  const { theme } = useTheme()
  const id = data.sessionID
  const [debrief, setDebrief] = createSignal<DebriefData>()
  const [missing, setMissing] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const session = () => office.state.sessions.find((s) => s.id === id)
  const followUps = () => (debrief()?.state === "ready" ? (debrief()!.follow_ups ?? []) : [])
  const [cursor, setCursor] = createSignal(0)
  const [marked, setMarked] = createSignal<number[]>([])

  /** Reads the debrief; for a pending one, the read also makes the office retry it. */
  function load() {
    office.client.debriefs.get(id).then(
      (d) => (setDebrief(d), setMissing(false), setError(undefined)),
      (e) => {
        if (e instanceof OfficeError && e.status === 404) return setMissing(true)
        setError(errorMessage(e))
      },
    )
  }
  // The event stream has no replay, so re-read whenever the office comes (back) online.
  createEffect(on(office.status, (status) => status === "online" && load()))
  const put = (e: { subject_id?: string; data: unknown }) => {
    if (e.subject_id === id) setDebrief(e.data as DebriefData)
  }
  onCleanup(office.on("debrief.created", put))
  onCleanup(office.on("debrief.updated", put))

  const move = (by: number) => setCursor((c) => Math.max(0, Math.min(followUps().length - 1, c + by)))
  function mark() {
    const i = cursor()
    if (!followUps()[i] || followUps()[i].confirmed) return
    setMarked((m) => (m.includes(i) ? m.filter((x) => x !== i) : [...m, i].sort((a, b) => a - b)))
  }
  let confirming = false
  /** Confirms the marked follow-ups, or the one under the cursor when none are marked. */
  async function confirm() {
    const indices = marked().length ? marked() : [cursor()]
    const fresh = indices.filter((i) => followUps()[i] && !followUps()[i].confirmed)
    if (confirming || !fresh.length) return
    confirming = true
    try {
      setDebrief(await office.client.debriefs.confirm(id, { indices: fresh }))
      setMarked([])
      toast.show({ variant: "success", message: `Made ${fresh.length} work item${fresh.length === 1 ? "" : "s"}` })
    } catch (e) {
      toast.show({ variant: "error", message: errorMessage(e) })
    } finally {
      confirming = false
    }
  }

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: () => renderer.currentFocusedEditor === null,
    bindings: [
      { key: "r", group: "Debrief", cmd: load },
      { key: "up", group: "Debrief", cmd: () => move(-1) },
      { key: "down", group: "Debrief", cmd: () => move(1) },
      { key: "space", group: "Debrief", cmd: mark },
      { key: "c", group: "Debrief", cmd: () => void confirm() },
      { key: "escape", group: "Debrief", cmd: () => route.navigate({ type: "session", sessionID: id }) },
    ],
  }))

  // The office answers 404 until the session is debriefing, then a pending debrief until it is
  // written; pending after that means writing it failed and the office retries.
  const writing = () => session()?.status === "ending" || session()?.status === "debriefing"
  const notice = () => {
    if (debrief()?.state === "ready" || !(debrief() || missing())) return
    if (writing()) return "Writing the debrief…"
    return debrief() ? "Debrief pending: the office will retry it (r retries now)." : "No debrief yet."
  }

  return (
    <box flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.text}>
          <span style={{ bold: true }}>Debrief · {personLabel(office.state.people, session()?.person ?? "")}</span>
        </text>
        <text fg={theme.textMuted}>r refresh · esc back</text>
      </box>
      <Show when={error()}>{(e) => <text fg={theme.error}>{e()}</text>}</Show>
      <Show when={notice()}>
        {(n) => <text fg={debrief() && !writing() ? theme.warning : theme.textMuted}>{n()}</text>}
      </Show>
      <Show when={debrief()?.state === "ready" ? debrief() : undefined}>
        {(d) => (
          <scrollbox flexGrow={1} minHeight={0}>
            <Show when={d().summary}>{(s) => <text fg={theme.text}>{s()}</text>}</Show>
            <text fg={theme.textMuted}>
              Status: {d().status ?? "—"} · Cost: ${(d().cost ?? 0).toFixed(2)}
            </text>
            <Section title="Artifacts" items={d().artifacts ?? []} />
            <Section title="Decisions" items={d().decisions ?? []} />
            <Show when={followUps().length}>
              <box marginTop={1}>
                <text fg={theme.text}>
                  <span style={{ bold: true }}>Follow-ups</span>
                  <span style={{ fg: theme.textMuted }}> · space mark · c confirm as work items</span>
                </text>
                <For each={followUps()}>
                  {(f, i) => (
                    <text fg={f.confirmed ? theme.textMuted : theme.text}>
                      {i() === cursor() ? "› " : "  "}
                      {f.confirmed ? "[x]" : marked().includes(i()) ? "[+]" : "[ ]"} {f.text}
                      {f.work_item_id ? ` (work item ${f.work_item_id.slice(-6)})` : ""}
                    </text>
                  )}
                </For>
              </box>
            </Show>
            <Section title="Open questions" items={d().open_questions ?? []} />
          </scrollbox>
        )}
      </Show>
      <Toast />
    </box>
  )
}

function Section(props: { title: string; items: string[] }) {
  const { theme } = useTheme()
  return (
    <Show when={props.items.length}>
      <box marginTop={1}>
        <text fg={theme.text}>
          <span style={{ bold: true }}>{props.title}</span>
        </text>
        <For each={props.items}>{(item) => <text fg={theme.text}>- {item}</text>}</For>
      </box>
    </Show>
  )
}
