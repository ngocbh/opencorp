import type { Profile as ProfileData } from "@opencorp/protocol"
import type { InputRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useTuiConfig } from "../../config"
import { useLocal } from "../../context/local"
import { useOffice } from "../../context/office"
import { useRoute, useRouteData } from "../../context/route"
import { useTheme } from "../../context/theme"
import { openEditor } from "../../editor"
import { OPENCORP_BASE_MODE, clearFirst, useBindings } from "../../keymap"
import { OfficeUnavailable, VersionConflictError } from "@opencorp/client"
import { Toast, useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { conflictText, LIVE, managerSession, shortVersion, transcript, withoutConflict } from "./profile"

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
          const person = from ? office.state.sessions.find((s) => s.id === from)?.person : local.person.current()?.handle
          if (!person) return toast.show({ variant: "warning", message: "Pick a person first", duration: 3000 })
          route.navigate({ type: "profile", person, from })
        },
      },
    ],
  }))
}

/**
 * A person's profile: the rendered `profile.md`, its version, and whether it is over budget; `e`
 * edits it and `m` asks the profile manager for a change.
 */
export function Profile() {
  const data = useRouteData("profile")
  const route = useRoute()
  const office = useOffice()
  const toast = useToast()
  const renderer = useRenderer()
  const tuiConfig = useTuiConfig()
  const { theme, syntax } = useTheme()
  const person = data.person
  const [profile, setProfile] = createSignal<ProfileData>()
  // Each read clears only its own error, so one succeeding doesn't hide another failing.
  const [profileError, setProfileError] = createSignal<string>()
  const [chatError, setChatError] = createSignal<string>()

  // A re-read can answer after newer events: the profile read is dropped if a newer version
  // arrived meanwhile.
  let profileEvents = 0
  // The event stream has no replay, so re-read whenever the office comes (back) online.
  createEffect(
    on(office.status, (status) => {
      if (status !== "online") return
      const at = profileEvents
      office.client.profiles.get(person).then(
        (p) => {
          if (profileEvents === at) setProfile(p)
          setProfileError(undefined)
        },
        (e) => setProfileError(errorMessage(e)),
      )
    }),
  )
  onCleanup(
    office.on("profile.updated", (e) => {
      if (e.subject_id !== person) return
      profileEvents++
      setProfile(e.data as unknown as ProfileData)
    }),
  )
  // The manager chat: the one this view started while it is live (or not listed yet), else
  // the person's newest live one.
  const [started, setStarted] = createSignal<string>()
  const chat = createMemo(() => {
    const id = started()
    const s = id && office.state.sessions.find((x) => x.id === id)
    if (id && (!s || LIVE.has(s.status))) return id
    return managerSession(office.state.sessions, person)?.id
  })
  const chatSession = () => office.state.sessions.find((s) => s.id === chat())
  const lines = createMemo(() => transcript(office.state.messages[chat() ?? ""] ?? []))
  // Once per chat: the office keeps a synced session live and re-reads it on reconnect.
  createEffect(
    on(chat, (id) => {
      if (!id) return
      office.syncSession(id).then(
        () => setChatError(undefined),
        (e) => {
          // An office that is down loads the chat when it comes back.
          if (!(e instanceof OfficeUnavailable)) setChatError(errorMessage(e))
        },
      )
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
      let conflicted = false
      for (;;) {
        const out = await openEditor({ value: text, renderer })
        const next = out === undefined ? undefined : withoutConflict(out)
        // After a lost race, an unchanged save drops the rejected edit below the marker.
        if (conflicted && (next === undefined || next === base.text))
          return toast.show({ variant: "warning", message: "Your edit was not saved" })
        if (next === undefined) return
        if (next === base.text) return toast.show({ variant: "info", message: "No changes" })
        try {
          setProfile(await office.client.profiles.put(person, { text: next, base_version: base.version }))
          return toast.show({ variant: "success", message: "Profile saved" })
        } catch (e) {
          if (!(e instanceof VersionConflictError)) throw e
          base = await office.client.profiles.get(person)
          setProfile(base)
          text = conflictText(base.text, next)
          conflicted = true
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
    mode: OPENCORP_BASE_MODE,
    enabled: () => renderer.currentFocusedEditor === null,
    bindings: [
      { key: "e", group: "Profile", cmd: () => void edit() },
      { key: "m", group: "Profile", cmd: () => input?.focus() },
      { key: "escape", group: "Profile", cmd: back },
    ],
  }))
  /** Empties the message box; false when it is already empty. */
  function clearInput() {
    if (!input || input.isDestroyed || !input.value) return false
    input.value = ""
    return true
  }
  useBindings(() => ({
    mode: OPENCORP_BASE_MODE,
    enabled: () => !!input && renderer.currentFocusedEditor === input,
    bindings: [
      // With text, Ctrl+C and Esc only clear it; on an empty box, Esc blurs and Ctrl+C goes on to leave.
      ...clearFirst(tuiConfig.keybinds.get("prompt.clear"), clearInput),
      { key: "escape", group: "Profile", cmd: () => input?.blur() },
    ],
  }))

  return (
    <box flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.text}>
          <span style={{ bold: true }}>@{person} · profile</span>
          <Show when={profile()}>
            {(p) => <span style={{ fg: theme.textMuted }}> {shortVersion(p().version)}</span>}
          </Show>
        </text>
        <text fg={theme.textMuted}>e edit · m message the manager · esc back</text>
      </box>
      <Show when={profile()?.over_budget}>
        <text fg={theme.warning} flexShrink={0}>
          Over budget: this profile is longer than its budget.
        </text>
      </Show>
      <Show when={profileError() ?? chatError()}>
        {(e) => <text fg={theme.error}>{e()}</text>}
      </Show>
      <scrollbox flexGrow={1} minHeight={0}>
        <Show when={profile()}>
          {(p) => (
            // Streaming mode in a non-shrinking box, as in the session transcript: without it the
            // markdown blanks for a few frames each time the layout under it changes.
            <box flexShrink={0}>
              <markdown
                syntaxStyle={syntax()}
                streaming={true}
                internalBlockMode="top-level"
                content={p().text}
                conceal={true}
                fg={theme.markdownText}
                bg={theme.background}
              />
            </box>
          )}
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
