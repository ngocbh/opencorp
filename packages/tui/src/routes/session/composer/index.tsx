import type { Instrument } from "@opencorp/protocol"
import { createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../../../context/theme"
import { SplitBorder } from "../../../ui/border"
import { useBindings, useOpenCorpModeStack } from "../../../keymap"
import { SessionsTab } from "./sessions-tab"
import { ShellTab } from "./shell-tab"
import { ComposerContext } from "./context"
import { createComposerTabs } from "./tabs"

export type ComposerProps = {
  sessionID: string
  open: boolean
  defaultTab?: string
  onClose?: () => void
  /** The chat's shells, as the session view lists them. */
  shells: readonly Instrument[]
  /** Opens shell `id` in the session view's instrument view. */
  onOpenShell: (id: string) => void
}

/**
 * The picker in the prompt's place: one tab per kind of thing the chat has going, Sessions (its Codex and Claude Code
 * sessions) and Shell (its shells); ←/→ switch tabs, and Esc or Ctrl-C close it. The upstream TUI's composer picker.
 */
export function Composer(props: ComposerProps) {
  const { theme } = useTheme()

  const tabs = createComposerTabs({ open: () => props.open, defaultTab: () => props.defaultTab })
  const tabList = tabs.list
  const activeTab = createMemo(() => tabList().find((t) => t.id === tabs.active()))
  const footerHints = createMemo(() => activeTab()?.hints?.() ?? [])

  function close() {
    props.onClose?.()
  }

  const ctx = {
    register: tabs.register,
    active(id: string) {
      return props.open && tabs.active() === id
    },
    close,
  }

  const modes = useOpenCorpModeStack()
  createEffect(() => {
    if (!props.open) return
    const popMode = modes.push("composer")
    onCleanup(popMode)
  })

  const switchTab = (dir: number) => {
    const list = tabList()
    if (list.length <= 1) return
    const idx = list.findIndex((t) => t.id === tabs.active())
    tabs.setActive(list[(idx + dir + list.length) % list.length].id)
  }

  useBindings(() => ({
    mode: "composer",
    enabled: props.open,
    priority: 1,
    bindings: [
      { key: "left", desc: "Previous tab", group: "Composer", cmd: () => switchTab(-1) },
      { key: "right", desc: "Next tab", group: "Composer", cmd: () => switchTab(1) },
      { key: "escape", desc: "Close the picker", group: "Composer", cmd: close },
      { key: "ctrl+c", desc: "Close the picker", group: "Composer", cmd: close },
    ],
  }))

  return (
    <ComposerContext.Provider value={ctx}>
      <box flexShrink={0} visible={props.open}>
        <box
          {...SplitBorder}
          border={["left"]}
          borderColor={theme.border}
          backgroundColor={theme.backgroundPanel}
          paddingLeft={1}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
        >
          <box gap={1}>
            <box flexDirection="row" justifyContent="space-between" paddingLeft={1}>
              <Show
                when={tabList().length > 1}
                fallback={
                  <text fg={theme.text} attributes={TextAttributes.BOLD}>
                    {tabList()[0]?.label ?? ""}
                  </text>
                }
              >
                <box flexDirection="row" gap={2}>
                  <For each={tabList()}>
                    {(t) => {
                      const isActive = createMemo(() => tabs.active() === t.id)
                      return (
                        <text
                          fg={isActive() ? theme.text : theme.textMuted}
                          attributes={isActive() ? TextAttributes.BOLD : undefined}
                          onMouseUp={() => tabs.setActive(t.id)}
                        >
                          {t.label}
                        </text>
                      )
                    }}
                  </For>
                </box>
              </Show>
              <text fg={theme.textMuted} onMouseUp={close}>
                esc
              </text>
            </box>
            <SessionsTab sessionID={props.sessionID} />
            <ShellTab sessionID={props.sessionID} shells={props.shells} onOpen={props.onOpenShell} />
            <box flexDirection="row" gap={2} paddingLeft={1} flexShrink={0}>
              <For each={footerHints()}>
                {(hint) => (
                  <text>
                    <span style={{ fg: theme.text }}>
                      <b>{hint.label}</b>{" "}
                    </span>
                    <span style={{ fg: theme.textMuted }}>{hint.shortcut}</span>
                  </text>
                )}
              </For>
              <Show when={tabList().length > 1}>
                <text>
                  <span style={{ fg: theme.text }}>
                    <b>tabs</b>{" "}
                  </span>
                  <span style={{ fg: theme.textMuted }}>←/→</span>
                </text>
              </Show>
            </box>
          </box>
        </box>
      </box>
    </ComposerContext.Provider>
  )
}
