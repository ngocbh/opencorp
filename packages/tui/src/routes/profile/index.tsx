import type { Profile as ProfileData, ProfileProposal } from "@agent-corp/protocol"
import type { InputRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useLocal } from "../../context/local"
import { useOffice } from "../../context/office"
import { useRoute, useRouteData } from "../../context/route"
import { useTheme } from "../../context/theme"
import { openEditor } from "../../editor"
import { OPENCODE_BASE_MODE, useBindings } from "../../keymap"
import { OfficeError, OfficeUnavailable, VersionConflictError } from "../../office/errors"
import { Toast, useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { diffColor } from "../picker/dialog-hire"
import {
  conflictText,
  diffLines,
  LIVE,
  managerSession,
  openProposal,
  shortVersion,
  transcript,
  withoutConflict,
} from "./profile"

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
 * edits it, `m` asks the profile manager for a change, and `a` applies the change it proposes.
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
  const [proposals, setProposals] = createSignal<ProfileProposal[]>([])
  // Each read clears only its own error, so one succeeding doesn't hide another failing.
  const [profileError, setProfileError] = createSignal<string>()
  const [proposalsError, setProposalsError] = createSignal<string>()
  const [chatError, setChatError] = createSignal<string>()
  const proposal = createMemo(() => openProposal(proposals(), person))

  // A re-read can answer after newer events: the profile read is dropped if a newer version
  // arrived meanwhile, and proposals seen from events while a read is out win over its list.
  let profileEvents = 0
  let reading = 0
  const seen = new Map<string, ProfileProposal>()
  async function loadProposals() {
    reading++
    try {
      const list = await office.client.profiles.proposals(person)
      const merged = new Map(list.map((p) => [p.id, p]))
      for (const p of seen.values()) merged.set(p.id, p)
      setProposals([...merged.values()])
      setProposalsError(undefined)
    } catch (e) {
      // An office without the proposals route yet has none (a missing person is a real error).
      if (e instanceof OfficeError && [404, 405, 501].includes(e.status) && e.code !== "not_found") {
        setProposals([])
        setProposalsError(undefined)
      } else setProposalsError(errorMessage(e))
    } finally {
      if (--reading === 0) seen.clear()
    }
  }
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
      void loadProposals()
    }),
  )
  onCleanup(
    office.on("profile.updated", (e) => {
      if (e.subject_id !== person) return
      profileEvents++
      setProfile(e.data as unknown as ProfileData)
    }),
  )
  const putProposal = (e: { data: unknown }) => {
    const p = e.data as ProfileProposal
    if (p.person !== person) return
    if (reading) seen.set(p.id, p)
    setProposals((list) => [...list.filter((x) => x.id !== p.id), p])
  }
  onCleanup(office.on("profile_proposal.created", putProposal))
  onCleanup(office.on("profile_proposal.updated", putProposal))

  let applying = false
  /** Applies the open proposal; the office refuses it (409) if the profile changed since it was made. */
  async function apply() {
    const p = proposal()
    if (applying || !p) return
    applying = true
    try {
      setProfile(await office.client.proposals.apply(p.id))
      toast.show({ variant: "success", message: "Proposal applied" })
    } catch (e) {
      if (e instanceof VersionConflictError)
        toast.show({ variant: "warning", message: "The profile changed after this proposal; ask the manager again" })
      else toast.show({ variant: "error", message: errorMessage(e) })
    } finally {
      applying = false
      // The office marks the proposal applied or stale; don't wait for the event to hide it.
      await loadProposals()
    }
  }

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
    mode: OPENCODE_BASE_MODE,
    enabled: () => renderer.currentFocusedEditor === null,
    bindings: [
      { key: "e", group: "Profile", cmd: () => void edit() },
      { key: "m", group: "Profile", cmd: () => input?.focus() },
      { key: "a", group: "Profile", cmd: () => void apply() },
      { key: "escape", group: "Profile", cmd: back },
    ],
  }))
  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: () => !!input && renderer.currentFocusedEditor === input,
    bindings: [{ key: "escape", group: "Profile", cmd: () => input?.blur() }],
  }))

  // The diff gets eight rows: all of it if it fits, else seven lines and a count of the rest.
  const shown = (p: ProfileProposal) => {
    const lines = diffLines(p.diff)
    return lines.length > 8 ? lines.slice(0, 7) : lines
  }

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
          Over budget: feedback can't be learned into this profile until it is shorter.
        </text>
      </Show>
      <Show when={profileError() ?? proposalsError() ?? chatError()}>
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
      <Show when={proposal()}>
        {(p) => (
          <box flexShrink={0}>
            <text fg={theme.text}>
              <span style={{ bold: true }}>Proposed change</span>
              <Show
                when={!profile() || p().base_version === profile()?.version}
                fallback={<span style={{ fg: theme.warning }}> · out of date; ask the manager again</span>}
              >
                <span style={{ fg: theme.textMuted }}> · a apply</span>
              </Show>
            </text>
            <For each={shown(p())}>{(line) => <text fg={diffColor(theme, line)}>{line}</text>}</For>
            <Show when={diffLines(p().diff).length - shown(p()).length}>
              {(more) => <text fg={theme.textMuted}>… {more()} more lines</text>}
            </Show>
          </box>
        )}
      </Show>
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
