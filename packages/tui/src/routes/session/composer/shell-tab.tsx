import type { Instrument } from "@opencorp/protocol"
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
import { LIVE } from "../terminal-pane"
import { useComposerTab } from "./context"
import { filterMemory, shellRunning } from "./tabs"

const STATUS: Record<Instrument["status"], string> = {
  starting: "Running",
  running: "Running",
  waiting: "Running",
  idle: "Idle",
  ended: "Ended",
  failed: "Failed",
}

const useFilter = filterMemory()

/**
 * The picker's Shell tab: the chat's shells, each by its name and the command it runs. Enter opens one in the right
 * pane, whose row is then marked; ctrl+d sends it Ctrl-C, the office's one way to stop its command.
 */
export function ShellTab(props: {
  sessionID: string
  shells: readonly Instrument[]
  visibleID?: string
  onOpen: (id: string) => void
}) {
  const office = useOffice()
  const { theme } = useTheme()
  const composer = useComposerTab()
  const tuiConfig = useTuiConfig()
  const toast = useToast()
  const selectKey = useCommandShortcut("composer.shell.select")
  const killKey = useCommandShortcut("composer.shell.kill")
  const toggleKey = useCommandShortcut("composer.shell.toggle-activity")
  const [filter, setFilter] = useFilter(useRenderer())

  const entries = createMemo(() => props.shells.filter((shell) => filter().active === shellRunning(shell)))

  const [store, setStore] = createStore({ selected: 0 })
  let scroll: ScrollBoxRenderable | undefined

  const selectedEntry = createMemo(() => entries()[store.selected])

  const open = () => {
    const entry = selectedEntry()
    if (!entry) return
    composer.close()
    props.onOpen(entry.id)
  }

  createEffect(() => {
    if (store.selected >= entries().length) setStore("selected", Math.max(0, entries().length - 1))
  })

  createEffect(() => {
    if (!scroll) return
    const target = scroll.getChildren()[store.selected]
    if (!target) return
    const y = target.y - scroll.y
    if (y >= scroll.height || y < 0) {
      const center = Math.floor(scroll.height / 2)
      scroll.scrollBy(y - center)
    }
  })

  onMount(() => {
    const cleanup = composer.register({
      id: "shell",
      label: "Shell",
      hints: () => [
        ...(selectedEntry() ? [{ label: "open", shortcut: selectKey() }] : []),
        ...(selectedEntry() && LIVE.includes(selectedEntry()!.status)
          ? [{ label: "interrupt", shortcut: killKey() }]
          : []),
        { label: `show ${filter().active ? "inactive" : "active"}`, shortcut: toggleKey() },
      ],
    })
    onCleanup(cleanup)
  })

  useBindings(() => ({
    mode: "composer",
    enabled: composer.active("shell"),
    priority: 1,
    commands: [
      {
        name: "composer.shell.up",
        title: "Previous shell",
        category: "Composer",
        run() {
          if (store.selected === 0) {
            composer.close()
            return
          }
          setStore("selected", (prev) => prev - 1)
        },
      },
      {
        name: "composer.shell.down",
        title: "Next shell",
        category: "Composer",
        run() {
          const list = entries()
          if (list.length === 0) return
          setStore("selected", (prev) => (prev + 1) % list.length)
        },
      },
      {
        name: "composer.shell.select",
        title: "Open the shell",
        category: "Composer",
        run: open,
      },
      {
        name: "composer.shell.toggle-activity",
        title: "Show the shells that run, or the rest",
        category: "Composer",
        run() {
          setFilter((value) => ({ active: !value.active }))
          setStore("selected", 0)
          scroll?.scrollTo(0)
        },
      },
      {
        name: "composer.shell.kill",
        title: "Send the shell Ctrl-C",
        category: "Composer",
        run() {
          const entry = selectedEntry()
          if (!entry || !LIVE.includes(entry.status)) return
          office.client.sessions
            .keys(props.sessionID, entry.id, { data: "\x03" })
            .catch((error) => toast.show({ message: errorMessage(error), variant: "error" }))
        },
      },
    ],
    bindings: [
      ...tuiConfig.keybinds.gather("composer.shell", [
        "composer.shell.up",
        "composer.shell.down",
        "composer.shell.select",
        "composer.shell.kill",
      ]),
      { key: "ctrl+a", cmd: "composer.shell.toggle-activity" },
    ],
  }))

  return (
    <Show when={composer.active("shell")}>
      {/* Five rows at most, as upstream's; OpenTUI's scrollbox, 0.9's too, fills its maxHeight, so it is the rows'. */}
      <scrollbox
        scrollbarOptions={{ visible: false }}
        maxHeight={Math.min(5, Math.max(1, entries().length))}
        ref={(r: ScrollBoxRenderable) => (scroll = r)}
      >
        <Show
          when={entries().length > 0}
          fallback={<text fg={theme.textMuted}> No {filter().active ? "active" : "inactive"} shells</text>}
        >
          <For each={entries()}>
            {(shell, index) => {
              const active = createMemo(() => index() === store.selected)
              const command = () => display(shell.command ?? "").split("\n", 1)[0]
              return (
                <box
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    active() ? theme.primary : shell.id === props.visibleID ? theme.backgroundElement : undefined
                  }
                  onMouseMove={() => setStore("selected", index())}
                  onMouseUp={() => {
                    setStore("selected", index())
                    open()
                  }}
                >
                  <box flexGrow={1} minWidth={0} flexDirection="row">
                    <text
                      fg={active() ? selectedForeground(theme) : theme.text}
                      attributes={active() ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                    >
                      {display(shell.name)}
                      {command() ? ` · ${command()}` : ""}
                    </text>
                  </box>
                  <text fg={active() ? selectedForeground(theme) : theme.textMuted} wrapMode="none">
                    {STATUS[shell.status]}
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
