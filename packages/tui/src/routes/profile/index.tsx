import type { Profile as ProfileData } from "@agent-corp/protocol"
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js"
import { useLocal } from "../../context/local"
import { useOffice } from "../../context/office"
import { useRoute, useRouteData } from "../../context/route"
import { useTheme } from "../../context/theme"
import { OPENCODE_BASE_MODE, useBindings } from "../../keymap"
import { Toast, useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { shortVersion } from "./profile"

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

/** A person's profile: the rendered `profile.md`, its version, and whether it is over budget. */
export function Profile() {
  const data = useRouteData("profile")
  const route = useRoute()
  const office = useOffice()
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

  const back = () => route.navigate(data.from ? { type: "session", sessionID: data.from } : { type: "home" })

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    bindings: [{ key: "escape", group: "Profile", cmd: back }],
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
        <text fg={theme.textMuted}>esc back</text>
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
      <Toast />
    </box>
  )
}
