import type { Debrief as DebriefData, Feedback } from "@opencorp/protocol"
import type { InputRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useTuiConfig } from "../../config"
import { useOffice } from "../../context/office"
import { useRoute, useRouteData } from "../../context/route"
import { useTheme } from "../../context/theme"
import { OPENCORP_BASE_MODE, useBindings } from "../../keymap"
import { OfficeError, OfficeUnavailable } from "@opencorp/client"
import { useDialog } from "../../ui/dialog"
import { DialogSelect } from "../../ui/dialog-select"
import { Toast, useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { personLabel } from "../../util/transcript"
import { aboutTurn, turns, written } from "./debrief"

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
 * cost. Space marks follow-ups and `c` confirms them, which makes a work item for each. Once
 * the session has stopped, `t` starts feedback about one turn and `f` feedback on the whole run.
 */
export function Debrief() {
  const data = useRouteData("debrief")
  const route = useRoute()
  const office = useOffice()
  const renderer = useRenderer()
  const tuiConfig = useTuiConfig()
  const toast = useToast()
  const dialog = useDialog()
  const { theme } = useTheme()
  const id = data.sessionID
  const [debrief, setDebrief] = createSignal<DebriefData>()
  const [missing, setMissing] = createSignal(false)
  // Reading the debrief and loading the transcript fail separately; each clears its own error.
  const [loadError, setLoadError] = createSignal<string>()
  const [syncError, setSyncError] = createSignal<string>()
  const session = () => office.state.sessions.find((s) => s.id === id)
  // Feedback is learned from a finished run, and a session's last run finishes when it stops.
  const learnable = () => ["ended", "failed", "debriefing"].includes(session()?.status ?? "")
  const followUps = () => (debrief()?.state === "ready" ? (debrief()!.follow_ups ?? []) : [])
  const [cursor, setCursor] = createSignal(0)
  const [marked, setMarked] = createSignal<number[]>([])
  // A rewritten debrief may renumber its follow-ups, so marks by index would point at others.
  createEffect(on(() => followUps().map((f) => f.text).join("\n"), () => setMarked([]), { defer: true }))
  createEffect(() => {
    const last = followUps().length - 1
    setCursor((c) => Math.max(0, Math.min(last, c)))
  })

  // Debrief events seen; a read that was in flight when one arrived may be older than it.
  let events = 0
  /** Reads the debrief; for a pending one, the read also makes the office retry it. */
  function load() {
    const at = events
    office.client.debriefs.get(id).then(
      (d) => at === events && (setDebrief(d), setMissing(false), setLoadError(undefined)),
      (e) => {
        if (at !== events) return
        if (e instanceof OfficeError && e.status === 404) return setMissing(true)
        setLoadError(errorMessage(e))
      },
    )
  }
  // The event stream has no replay, so re-read whenever the office comes (back) online.
  createEffect(on(office.status, (status) => status === "online" && load()))
  // The turns to pick from. Loaded once: the office context reloads synced sessions when it
  // comes back, so an office that is down isn't an error here.
  const sync = () =>
    office.syncSession(id).then(
      () => setSyncError(undefined),
      (e) => e instanceof OfficeUnavailable || setSyncError(errorMessage(e)),
    )
  sync()
  /** `r`: reads the debrief again, and the transcript too if loading it failed. */
  const refresh = () => (load(), syncError() && sync())
  const put = (e: { subject_id?: string; data: unknown }) => {
    if (e.subject_id !== id) return
    events++
    setDebrief(e.data as DebriefData)
    setLoadError(undefined)
  }
  onCleanup(office.on("debrief.created", put))
  onCleanup(office.on("debrief.updated", put))

  // Feedback sent from this screen; there is no route to list a session's feedback.
  const [sent, setSent] = createSignal<Feedback[]>([])
  // Feedback moves queued → learning → applied or learning_failed, and back to queued only for a
  // new attempt. So done beats not done, then a later attempt beats an earlier one, then the
  // later status wins; a reply or event that arrives late is older than what is shown.
  const RANK = { queued: 0, learning: 1, applied: 2, learning_failed: 2 }
  const order = (f: Feedback) => (RANK[f.status] === 2 ? 1e6 : 0) + (f.attempts ?? 0) * 10 + RANK[f.status]
  /** Adds or updates a sent feedback item in place, unless the update is older than what is shown. */
  const putFeedback = (f: Feedback) => {
    if (f.session_id !== id) return
    setSent((list) => {
      const i = list.findIndex((x) => x.id === f.id)
      if (i < 0) return [...list, f]
      return order(f) < order(list[i]) ? list : list.with(i, f)
    })
  }
  onCleanup(office.on("feedback.created", (e) => putFeedback(e.data as unknown as Feedback)))
  onCleanup(office.on("feedback.updated", (e) => putFeedback(e.data as unknown as Feedback)))
  const turnList = createMemo(() => turns(office.state.messages[id] ?? []))
  let input: InputRenderable | undefined
  // The turn pre-fill the input starts with; sent alone, it says nothing.
  let prefix = ""
  /**
   * Focuses the feedback input, starting it with `next` in place of the draft's pre-fill and
   * keeping the rest of the draft; a tick later, so a closing dialog's refocus doesn't undo it.
   */
  function write(next: string) {
    setTimeout(() => {
      if (!input || input.isDestroyed) return
      const draft = input.value
      const rest = prefix && draft.startsWith(prefix) ? draft.slice(prefix.length) : draft
      prefix = next
      input.value = next + rest
      input.focus()
    }, 0)
  }
  function pickTurn() {
    if (!turnList().length) return toast.show({ variant: "info", message: "No turns to pick from", duration: 3000 })
    dialog.replace(() => (
      <DialogSelect
        title="About which turn?"
        placeholder="Search turns"
        options={turnList().map((t) => ({ title: `Turn ${t.n}: ${t.text}`, value: t }))}
        onSelect={(option) => {
          dialog.clear()
          write(aboutTurn(option.value))
        }}
      />
    ))
  }
  let sending = false
  /** Sends feedback on the session's latest run (the office's default when `run_id` is left out). */
  async function send(draft: string) {
    const text = written(draft, prefix)
    if (sending || !text) return
    sending = true
    try {
      putFeedback(await office.client.feedback.create({ session_id: id, text }))
      // Keep whatever was typed after the sent text while it was on its way.
      if (input && !input.isDestroyed) {
        prefix = ""
        input.value = input.value.startsWith(draft) ? input.value.slice(draft.length).trimStart() : input.value
        if (!input.value) input.blur()
      }
      toast.show({ variant: "success", message: "Feedback queued" })
    } catch (e) {
      toast.show({ variant: "error", message: errorMessage(e) })
    } finally {
      sending = false
    }
  }

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
    mode: OPENCORP_BASE_MODE,
    enabled: () => renderer.currentFocusedEditor === null,
    bindings: [
      { key: "r", group: "Debrief", cmd: refresh },
      { key: "up", group: "Debrief", cmd: () => move(-1) },
      { key: "down", group: "Debrief", cmd: () => move(1) },
      { key: "space", group: "Debrief", cmd: mark },
      { key: "c", group: "Debrief", cmd: () => void confirm() },
      { key: "t", group: "Debrief", cmd: () => learnable() && pickTurn() },
      { key: "f", group: "Debrief", cmd: () => learnable() && write("") },
      { key: "escape", group: "Debrief", cmd: () => route.navigate({ type: "session", sessionID: id }) },
    ],
  }))
  /** Empties the feedback box and its turn pre-fill; false when the box is already empty. */
  function clearInput() {
    if (!input || input.isDestroyed || !input.value) return false
    input.value = ""
    prefix = ""
    return true
  }
  useBindings(() => ({
    mode: OPENCORP_BASE_MODE,
    enabled: () => !!input && renderer.currentFocusedEditor === input,
    bindings: [
      // Esc only leaves the box: the draft stays for t and f to put a turn in front of. So only the clear keys
      // (Ctrl+C) clear, not clearFirst's Esc; false on an empty box lets Ctrl+C go on to leave.
      { key: "escape", group: "Debrief", cmd: () => input?.blur() },
      ...tuiConfig.keybinds
        .get("prompt.clear")
        .map((b) => ({ ...b, desc: "Clear the box", group: "Debrief", cmd: clearInput })),
    ],
  }))

  // The office answers 404 until the session is debriefing, then a pending debrief until it is
  // written; pending after that means writing it failed and the office retries.
  const writing = () => session()?.status === "ending" || session()?.status === "debriefing"
  const notice = () => {
    if (debrief()?.state === "ready" || !(debrief() || missing())) return
    if (writing()) return "Writing the debrief…"
    return debrief() ? "Debrief pending (r retries now)." : "No debrief yet."
  }

  return (
    <box flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.text}>
          <span style={{ bold: true }}>Debrief · {personLabel(office.state.people, session()?.person ?? "")}</span>
        </text>
        <text fg={theme.textMuted}>r refresh · esc back</text>
      </box>
      <Show when={loadError()}>{(e) => <text fg={theme.error}>{e()}</text>}</Show>
      <Show when={syncError()}>{(e) => <text fg={theme.error}>{e()}</text>}</Show>
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
      <Show when={sent().length}>
        <box flexShrink={0}>
          <text fg={theme.text}>
            <span style={{ bold: true }}>Feedback</span>
          </text>
          <For each={sent()}>
            {(f) => (
              <text fg={f.status === "learning_failed" ? theme.error : theme.textMuted}>
                {f.status.replace("_", " ")} · {f.text}
                {f.failure ? ` — ${f.failure}` : ""}
              </text>
            )}
          </For>
        </box>
      </Show>
      <Show when={learnable()}>
        <box flexDirection="row" flexShrink={0}>
          <text fg={theme.textMuted}>{"> "}</text>
          <input
            flexGrow={1}
            ref={(r) => (input = r)}
            placeholder="Feedback for the profile: t about a turn, f on the whole run"
            placeholderColor={theme.textMuted}
            focusedBackgroundColor={theme.backgroundPanel}
            cursorColor={theme.primary}
            onSubmit={() => void send(input?.value ?? "")}
          />
        </box>
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
