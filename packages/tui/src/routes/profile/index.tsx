import type { Profile as ProfileData } from "@agent-corp/protocol"
import type { InputRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useLocal } from "../../context/local"
import { useOffice } from "../../context/office"
import { useRoute, useRouteData } from "../../context/route"
import { useTheme } from "../../context/theme"
import { openEditor } from "../../editor"
import { OPENCODE_BASE_MODE, useBindings } from "../../keymap"
import { VersionConflictError } from "../../office/errors"
import { Toast, useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { conflictText, managerSession, shortVersion, transcript, withoutConflict } from "./profile"

/** Registers `/profile`: opens the profile of the session's person, or of the selected person. */
export function useProfileCommands() {
  const route = useRoute()
  const office = useOffice()
  const local = useLocal()
  const toast = useToast()
  useBindings(() => ({
    commands: [
      {
        namespace: "palette",
        name: "profile.show",
        title: "Open profile",
        category: "Person",
        slashName: "profile",
        run: () => {
          const data = route.data
          if (data.type === "profile") return
          const from = data.type === "session" ? data.sessionID : undefined
          const person = from ? office.state.sessions.find((s) => s.id === from)?.person : local.person.current()?.id
          if (!person) return toast.show({ variant: "warning", message: "Pick a person first", duration: 3000 })
          route.navigate({ type: "profile", person, from })
        },
      },
    ],
  }))
}

/**
 * A person's profile: the rendered `profile.md`, its version, and whether it is over budget; `e`
 * edits it, and `m` asks the profile manager for a change.
 */
export function Profile() {
  const data = useRouteData("profile")
  const route = useRoute()
  const office = useOffice()
  const toast = useToast()
  const renderer = useRenderer()
  const { theme, syntax } = useTheme()
  const person = data.person
  const [profile, setProfile] = createSignal<ProfileData>()
  const [error, setError] = createSignal<string>()
  const handle = () => office.state.people.find((p) => p.id === person)?.handle ?? person

  // The event stream has no replay, so re-read whenever the office comes (back) online.
  createEffect(
    on(office.status, (status) => {
      if (status !== "online") return
      office.client.profiles.get(person).then(
        (p) => (setProfile(p), setError(undefined)),
        (e) => setError(errorMessage(e)),
      )
    }),
  )
  onCleanup(
    office.on("profile.updated", (e) => {
      if (e.subject_id === person) setProfile(e.data as unknown as ProfileData)
    }),
  )

  // The manager chat: the one this view started, else the person's newest live one.
  const [started, setStarted] = createSignal<string>()
  const chat = createMemo(() => started() ?? managerSession(office.state.sessions, person)?.id)
  const chatSession = () => office.state.sessions.find((s) => s.id === chat())
  const lines = createMemo(() => transcript(office.state.messages[chat() ?? ""] ?? []))
  createEffect(
    on([chat, office.status], ([id, status]) => {
      if (id && status === "online") office.syncSession(id).catch((e) => setError(errorMessage(e)))
    }),
  )
  let input: InputRenderable | undefined
  let sending = false
  /** Sends `text` to the manager chat, starting one on the first message. */
  async function send(text: string) {
    if (sending || !text.trim()) return
    sending = true
    try {
      const id = chat()
      if (id) await office.client.sessions.prompt(id, { text })
      else setStarted((await office.client.profiles.manager(person, { text })).id)
      if (input) input.value = ""
    } catch (e) {
      toast.show({ variant: "error", message: errorMessage(e) })
    } finally {
      sending = false
    }
  }

  let editing = false
  /**
   * Edits the profile in $EDITOR and saves it against the version the edit started from. When
   * the profile changed meanwhile, re-opens the editor on the new text with the rejected edit
   * below a marker, so nothing typed is lost.
   */
  async function edit() {
    const start = profile()
    if (editing || !start) return
    if (!process.env.VISUAL && !process.env.EDITOR)
      return toast.show({ variant: "warning", message: "Set $EDITOR (or $VISUAL) to edit the profile" })
    editing = true
    try {
      let base = start
      let text = base.text
      for (;;) {
        const out = await openEditor({ value: text, renderer })
        if (out === undefined) return
        const next = withoutConflict(out)
        if (next === base.text) return toast.show({ variant: "info", message: "No changes" })
        try {
          setProfile(await office.client.profiles.put(person, { text: next, base_version: base.version }))
          return toast.show({ variant: "success", message: "Profile saved" })
        } catch (e) {
          if (!(e instanceof VersionConflictError)) throw e
          base = await office.client.profiles.get(person)
          setProfile(base)
          text = conflictText(base.text, next)
        }
      }
    } catch (e) {
      toast.show({ variant: "error", message: errorMessage(e) })
    } finally {
      editing = false
    }
  }

  const back = () => route.navigate(data.from ? { type: "session", sessionID: data.from } : { type: "home" })

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: () => renderer.currentFocusedEditor === null,
    bindings: [
      { key: "e", group: "Profile", cmd: () => void edit() },
      { key: "m", group: "Profile", cmd: () => input?.focus() },
      { key: "escape", group: "Profile", cmd: back },
    ],
  }))
  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: () => !!input && renderer.currentFocusedEditor === input,
    bindings: [{ key: "escape", group: "Profile", cmd: () => input?.blur() }],
  }))

  return (
    <box flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.text}>
          <span style={{ bold: true }}>@{handle()} · profile</span>
          <Show when={profile()}>
            {(p) => <span style={{ fg: theme.textMuted }}> {shortVersion(p().version)}</span>}
          </Show>
        </text>
        <text fg={theme.textMuted}>e edit · m message the manager · esc back</text>
      </box>
      <Show when={profile()?.over_budget}>
        <text fg={theme.warning} flexShrink={0}>
          Over budget: feedback can't be learned into this profile until it is shorter.
        </text>
      </Show>
      <Show when={error()}>{(e) => <text fg={theme.error}>{e()}</text>}</Show>
      <scrollbox flexGrow={1} minHeight={0}>
        <Show when={profile()}>
          {(p) => <markdown syntaxStyle={syntax()} content={p().text} conceal={true} fg={theme.text} />}
        </Show>
      </scrollbox>
      <Show when={lines().length}>
        <box flexShrink={0}>
          <For each={lines().slice(-4)}>
            {(l) => (
              <text fg={l.role === "user" ? theme.text : theme.textMuted}>
                {l.role === "user" ? "you: " : "manager: "}
                {l.text}
              </text>
            )}
          </For>
        </box>
      </Show>
      <Show when={chatSession()?.status === "busy" || chatSession()?.status === "starting"}>
        <text fg={theme.textMuted} flexShrink={0}>
          The profile manager is thinking…
        </text>
      </Show>
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme.textMuted}>{"> "}</text>
        <input
          flexGrow={1}
          ref={(r) => (input = r)}
          placeholder="Ask the profile manager for a change (m)"
          placeholderColor={theme.textMuted}
          focusedBackgroundColor={theme.backgroundPanel}
          cursorColor={theme.primary}
          onSubmit={() => void send(input?.value ?? "")}
        />
      </box>
      <Toast />
    </box>
  )
}
