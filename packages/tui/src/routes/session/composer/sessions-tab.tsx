import { createMemo, For, Show, createEffect, onMount, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { TextAttributes, ScrollBoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { useOffice } from "../../../context/office"
import { selectedForeground, useTheme } from "../../../context/theme"
import { useBindings, useCommandShortcut } from "../../../keymap"
import { useTuiConfig } from "../../../config"
import { useToast } from "../../../ui/toast"
import { errorMessage } from "../../../util/error"
import { display } from "../../../util/printable"
import { useComposerTab } from "./context"
import { filterMemory, harnessFamily, type ChildState, type FamilyEntry } from "./tabs"

interface SessionEntry extends FamilyEntry {
  current: boolean
}

const AGENT: Record<FamilyEntry["harness"], string> = { codex: "Codex", claude: "Claude Code" }
const STATUS: Record<ChildState, string> = { running: "Running", idle: "Idle", ended: "Ended" }

const useFilter = filterMemory()

/** The picker's Sessions tab: the chat's Codex and Claude Code sessions, each its child session. Enter or a click
 *  opens one in the right pane and closes the picker, as the upstream TUI's Terminals tab opens a terminal. */
export function SessionsTab(props: { sessionID: string; visibleID?: string; onOpen: (id: string) => void }) {
  const renderer = useRenderer()
  const office = useOffice()
  const { theme } = useTheme()
  const composer = useComposerTab()
  const tuiConfig = useTuiConfig()
  const toast = useToast()
  const interruptKey = useCommandShortcut("composer.subagent.interrupt")
  const toggleKey = useCommandShortcut("composer.subagent.toggle-activity")

  const [store, setStore] = createStore({ selected: 0 })
  const [filter, setFilter] = useFilter(renderer)

  const entries = createMemo<SessionEntry[]>(() =>
    harnessFamily(office.state, props.sessionID)
      .map((entry) => ({
        ...entry,
        current: entry.sessionID === props.sessionID || entry.sessionID === props.visibleID,
      }))
      // The session you're in, or the one the pane shows, always shows, so a child's picker has its own row.
      .filter((entry) => entry.current || filter().active === (entry.state === "running")),
  )

  /** Opens `entry` in the right pane, closing the picker first; the session you're in is open already. */
  function open(entry: SessionEntry | undefined) {
    if (!entry || entry.sessionID === props.sessionID) return
    composer.close()
    props.onOpen(entry.sessionID)
  }

  let selectedSessionID = ""
  let wasActive = false
  let scroll: ScrollBoxRenderable | undefined

  const selectedEntry = createMemo(() => entries()[store.selected])

  createEffect(() => {
    const active = composer.active("subagents")
    if (!active) {
      if (wasActive) {
        selectedSessionID = ""
        setStore("selected", 0)
      }
      wasActive = false
      return
    }
    const list = entries()
    if (selectedSessionID !== props.sessionID && list.length > 0) {
      const currentIdx = list.findIndex((e) => e.current)
      const next = currentIdx >= 0 ? currentIdx : 0
      selectedSessionID = props.sessionID
      setStore("selected", next)
      const scrollCurrentIntoView = () => scrollToIndex(next, true)
      scrollCurrentIntoView()
      // The remounted scrollbox finishes layout on the next frame and resets its scroll position.
      renderer.requestAnimationFrame(() => renderer.requestAnimationFrame(scrollCurrentIntoView))
    }
    wasActive = true
    if (store.selected >= list.length) moveTo(Math.max(0, list.length - 1))
  })

  function moveTo(next: number, center = false) {
    setStore("selected", next)
    scrollToIndex(next, center)
  }

  function scrollToIndex(index: number, center: boolean) {
    if (!scroll) return
    if (center) {
      scroll.scrollTo(Math.max(0, index - Math.floor(scroll.viewport.height / 2)))
      return
    }
    if (index >= scroll.scrollTop + scroll.viewport.height) {
      scroll.scrollTo(index - scroll.viewport.height + 1)
    }
    if (index < scroll.scrollTop) {
      scroll.scrollTo(index)
      if (index === 0) scroll.scrollTo(0)
    }
  }

  onMount(() => {
    const cleanup = composer.register({
      id: "subagents",
      label: "Sessions",
      hints: () => {
        const entry = selectedEntry()
        return [
          ...(entry?.state === "running" ? [{ label: "interrupt", shortcut: interruptKey() }] : []),
          { label: `show ${filter().active ? "inactive" : "active"}`, shortcut: toggleKey() },
        ]
      },
    })
    onCleanup(cleanup)
  })

  useBindings(() => ({
    mode: "composer",
    enabled: composer.active("subagents"),
    priority: 1,
    commands: [
      {
        name: "composer.subagent.up",
        title: "Previous session",
        category: "Composer",
        run() {
          if (store.selected === 0) {
            composer.close()
            return
          }
          moveTo(store.selected - 1, true)
        },
      },
      {
        name: "composer.subagent.down",
        title: "Next session",
        category: "Composer",
        run() {
          const list = entries()
          if (list.length === 0) return
          moveTo((store.selected + 1) % list.length, true)
        },
      },
      {
        name: "composer.subagent.select",
        title: "Open the session",
        category: "Composer",
        run() {
          open(entries()[store.selected])
        },
      },
      {
        name: "composer.subagent.toggle-activity",
        title: "Show the sessions that run, or the rest",
        category: "Composer",
        run() {
          setFilter((value) => ({ active: !value.active }))
          setStore("selected", 0)
          scroll?.scrollTo(0)
        },
      },
      {
        name: "composer.subagent.interrupt",
        title: "Interrupt the session",
        category: "Composer",
        run() {
          const entry = selectedEntry()
          if (entry?.state !== "running") return
          office.client.sessions
            .interrupt(entry.sessionID)
            .catch((error) => toast.show({ message: errorMessage(error), variant: "error" }))
        },
      },
    ],
    bindings: [
      ...tuiConfig.keybinds.gather("composer.subagent", [
        "composer.subagent.up",
        "composer.subagent.down",
        "composer.subagent.select",
        "composer.subagent.interrupt",
      ]),
      { key: "ctrl+a", cmd: "composer.subagent.toggle-activity" },
    ],
  }))

  return (
    <Show when={composer.active("subagents")}>
      {/* Five rows at most, as upstream's; OpenTUI 0.8's scrollbox takes all of its maxHeight, so it is the rows'. */}
      <scrollbox
        scrollbarOptions={{ visible: false }}
        maxHeight={Math.min(5, Math.max(1, entries().length))}
        ref={(r: ScrollBoxRenderable) => (scroll = r)}
      >
        <Show
          when={entries().length > 0}
          fallback={<text fg={theme.textMuted}> No {filter().active ? "active" : "inactive"} sessions</text>}
        >
          <For each={entries()}>
            {(entry, index) => {
              const active = createMemo(() => index() === store.selected)
              return (
                <box
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active() ? theme.primary : entry.current ? theme.backgroundElement : undefined}
                  onMouseMove={() => setStore("selected", index())}
                  onMouseUp={() => {
                    setStore("selected", index())
                    open(entry)
                  }}
                >
                  <box flexGrow={1} minWidth={0} flexDirection="row">
                    <text
                      fg={active() ? selectedForeground(theme) : theme.text}
                      attributes={active() ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                    >
                      {entry.prefix}
                      {AGENT[entry.harness]}: {display(entry.name)}
                    </text>
                  </box>
                  <text fg={active() ? selectedForeground(theme) : theme.textMuted} wrapMode="none">
                    {STATUS[entry.state]}
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </scrollbox>
    </Show>
  )
}
