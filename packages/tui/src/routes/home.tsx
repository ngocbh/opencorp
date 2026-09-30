import { Prompt, type PromptRef } from "../component/prompt"
import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js"
import { Logo } from "../component/logo"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRouteData } from "../context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { useEditorContext } from "../context/editor"
import { useTerminalDimensions } from "@opentui/solid"
import { useTuiConfig } from "../config"
import { useOffice } from "../context/office"
import { useTheme } from "../context/theme"
import { useTuiPaths } from "../context/runtime"
import { abbreviateHome } from "../runtime"

let once = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

export function Home() {
  const sync = useSync()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const office = useOffice()
  const paths = useTuiPaths()
  const { theme } = useTheme()
  const promptMaxWidth = createMemo(() => {
    const configured = tuiConfig.prompt?.max_width
    if (configured === "auto") return Math.max(75, Math.floor(dimensions().width * 0.7))
    return configured ?? 75
  })
  let sent = false

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.person.current()) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
      <box flexGrow={1} minHeight={0} />
      <box height={4} minHeight={0} flexShrink={1} />
      <box flexShrink={0}>
        <Logo />
      </box>
      <box height={1} minHeight={0} flexShrink={1} />
      <box width="100%" maxWidth={promptMaxWidth()} zIndex={1000} paddingTop={1} flexShrink={0}>
        <Prompt ref={bind} placeholders={placeholder} />
        <Show when={office.status() === "offline"}>
          <text fg={theme.textMuted} paddingTop={1}>
            Office is not running. Waiting for {abbreviateHome(office.client.socket, paths.home)}
          </text>
        </Show>
      </box>
      <box flexGrow={1} minHeight={0} />
      <Toast />
    </box>
  )
}
