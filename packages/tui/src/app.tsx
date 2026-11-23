import { render, TimeToFirstDraw, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { registerOpenCorpSpinner } from "./component/register-spinner"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { Deferred, Effect } from "effect"
import { Global } from "./core/global"
import { Flag } from "./core/flag"
import { ClipboardProvider, useClipboard } from "./context/clipboard"
import { ExitProvider, useExit } from "./context/exit"
import { EpilogueProvider } from "./context/epilogue"
import * as Selection from "./util/selection"
import { createCliRenderer, MouseButton } from "@opentui/core"
import { RouteProvider, useRoute } from "./context/route"
import { leaveBindings, pressTwice } from "./routes/chat/leave"
import {
  Switch,
  Match,
  createEffect,
  createMemo,
  ErrorBoundary,
  createSignal,
  onMount,
  onCleanup,
  batch,
  Show,
} from "solid-js"
import { TuiPathsProvider, TuiStartupProvider, TuiTerminalEnvironmentProvider } from "./context/runtime"
import { DialogProvider, useDialog } from "./ui/dialog"
import { ErrorComponent } from "./component/error-component"
import { EditorContextProvider } from "./context/editor"
import { OfficeProvider, useOffice } from "./context/office"
import { PermissionProvider } from "./context/permission"
import { sessionsIn } from "@opencorp/client"
import { personLabel } from "./util/transcript"
import { LocalProvider, useLocal } from "./context/local"
import { DialogDebug } from "./component/dialog-debug"
import { DialogThemeList } from "./component/dialog-theme-list"
import { DialogModel } from "./component/dialog-model"
import { DialogConnect } from "./component/dialog-connect"
import { DialogHelp } from "./ui/dialog-help"
import { DialogSessionList } from "./component/dialog-session-list"
import { DialogPeople, usePickerOnStart } from "./routes/picker/dialog-people"
import { ThemeProvider, useTheme } from "./context/theme"
import { Home } from "./routes/home"
import { Profile, useProfileCommands } from "./routes/profile"
import { SessionFrame } from "./component/session-frame"
import { Reconnecting } from "./component/reconnecting"
import { PanelProvider, usePanel } from "./context/panel"
import { PromptHistoryProvider } from "./component/prompt/history"
import { FrecencyProvider } from "./component/prompt/frecency"
import { PromptStashProvider } from "./component/prompt/stash"
import { ToastProvider, useToast } from "./ui/toast"
import { KVProvider, useKV } from "./context/kv"
import { ArgsProvider, useArgs, type Args } from "./context/args"
import { PromptRefProvider, usePromptRef } from "./context/prompt"
import { TuiConfigProvider, useTuiConfig, resolve as resolveConfig, type TuiConfig } from "./config"
import { CommandPaletteDialog } from "./component/command-palette"
import {
  COMMAND_PALETTE_COMMAND,
  OPENCORP_BASE_MODE,
  OpenCorpKeymapProvider,
  registerOpenCorpKeymap,
  useBindings,
  useOpenCorpKeymap,
} from "./keymap"

import { win32DisableProcessedInput, win32FlushInputBuffer } from "./terminal-win32"
import { destroyRenderer, setTerminalTitle } from "./util/renderer"
import { errorFormat } from "./util/error"

registerOpenCorpSpinner()

const appGlobalBindingCommands = [
  "session.list",
  "session.new",
  "session.quick_switch.1",
  "session.quick_switch.2",
  "session.quick_switch.3",
  "session.quick_switch.4",
  "session.quick_switch.5",
  "session.quick_switch.6",
  "session.quick_switch.7",
  "session.quick_switch.8",
  "session.quick_switch.9",
] as const

const appBindingCommands = [
  "command.palette.show",
  "person.list",
  "model.list",
  "model.last_pick.toggle",
  "provider.connect",
  "agent.cycle",
  "agent.cycle.reverse",
  "opencorp.debug",
  "theme.switch",
  "theme.switch_mode",
  "theme.mode.lock",
  "help.show",
  "app.debug",
  "app.console",
  "app.heap_snapshot",
  "terminal.suspend",
  "terminal.title.toggle",
  "app.toggle.animations",
  "app.toggle.file_context",
  "app.toggle.diffwrap",
  "app.toggle.paste_summary",
  "app.toggle.session_directory_filter",
] as const

export type TuiInput = {
  /** The office's unix socket. */
  socket: string
  /** This device's token, sent with every request; none while the office has no devices. */
  token?: string
  /** Who the office takes this TUI's requests as (its `/whoami`), when known. */
  person?: string
  /** The folder the TUI works in. */
  cwd: string
  args: Args
  /** Keybinds and display settings; the defaults when omitted. */
  config?: TuiConfig.Resolved
  onSnapshot?: () => Promise<string[]>
  /** A local session, on a host with no office in this process: the TUI opens on it as its owner, the only route
   *  there is (no home, no other session), and closes once `until` settles, printing what it resolves to. */
  local?: LocalInput
}

/** A local session the TUI runs on: its id, and what settles once it is over, with the epilogue to print then. */
export type LocalInput = { sessionID: string; until: Promise<string | undefined> }

/** Who every request to a host with no office acts as: its owner. */
const LOCAL_OWNER = "owner"

export const run = Effect.fn("Tui.run")(function* (opts: TuiInput) {
  const input = {
    ...opts,
    // A local session's owner is who every request acts as.
    ...(opts.local && { person: LOCAL_OWNER, args: { ...opts.args, sessionID: opts.local.sessionID } }),
    config: opts.config ?? resolveConfig({}, { terminalSuspend: process.platform !== "win32" }),
  }
  const global = yield* Global.Service
  const exit = { epilogue: undefined as string | undefined, reason: undefined as unknown }
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const renderer = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            createCliRenderer({
              externalOutputMode: "passthrough",
              targetFps: 60,
              gatherStats: false,
              exitOnCtrlC: false,
              useKittyKeyboard: {},
              autoFocus: false,
              openConsoleOnError: false,
              useMouse: !Flag.OPENCORP_DISABLE_MOUSE && input.config.mouse,
              consoleOptions: {
                keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
              },
            }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
        (renderer) =>
          Effect.promise(async () => {
            destroyRenderer(renderer)
            // The terminal is restored only once closed settles; it rejects when the terminal is already gone.
            await renderer.closed.catch(() => {})
          }),
      )
      win32DisableProcessedInput()
      const keymap = createDefaultOpenTuiKeymap(renderer)
      yield* Effect.acquireRelease(
        Effect.sync(() => registerOpenCorpKeymap(keymap, renderer, input.config)),
        (unregister) => Effect.sync(unregister),
      )
      const shutdown = yield* Deferred.make<unknown>()
      const onSighup = () => destroyRenderer(renderer)
      yield* Effect.acquireRelease(
        Effect.sync(() => process.on("SIGHUP", onSighup)),
        () => Effect.sync(() => process.off("SIGHUP", onSighup)),
      )
      renderer.once("destroy", () => Deferred.doneUnsafe(shutdown, Effect.void))
      // A local session's end closes the TUI, with its epilogue in place of the session's own.
      void input.local?.until.then(
        (epilogue) => {
          exit.epilogue = epilogue
          destroyRenderer(renderer)
        },
        () => destroyRenderer(renderer),
      )

      yield* Effect.tryPromise(async () => {
        // Prewarm palette before ThemeProvider mounts so `system` theme avoids a first-paint fallback flash.
        void renderer.getPalette({ size: 16 }).catch(() => undefined)
        const mode = (await renderer.waitForThemeMode(1000)) ?? "dark"
        if (renderer.isDestroyed) return

        await render(() => {
          return (
            <ExitProvider
              exit={(reason) => {
                if (renderer.isDestroyed) return
                exit.reason = reason
                destroyRenderer(renderer)
              }}
            >
              <EpilogueProvider set={(value) => void (input.local === undefined && (exit.epilogue = value))}>
                <ErrorBoundary fallback={(error, reset) => <ErrorComponent error={error} reset={reset} mode={mode} />}>
                  <TuiPathsProvider
                    value={{
                      cwd: process.cwd(),
                      home: global.home,
                      state: global.state,
                      worktree: global.data + "/worktree",
                    }}
                  >
                    <TuiTerminalEnvironmentProvider
                      value={{
                        platform: process.platform,
                        multiplexer: process.env.TMUX ? "tmux" : process.env.STY ? "screen" : undefined,
                        displayServer: process.env.WAYLAND_DISPLAY
                          ? "wayland"
                          : process.env.DISPLAY
                            ? "x11"
                            : undefined,
                      }}
                    >
                      <TuiStartupProvider
                        value={{
                          initialRoute: process.env.OPENCORP_ROUTE ? JSON.parse(process.env.OPENCORP_ROUTE) : undefined,
                          skipInitialLoading: Boolean(process.env.OPENCORP_FAST_BOOT),
                        }}
                      >
                        <ClipboardProvider>
                          <OpenCorpKeymapProvider keymap={keymap}>
                            <ArgsProvider {...input.args}>
                              <KVProvider>
                                <ToastProvider>
                                  <RouteProvider only={input.local?.sessionID}>
                                    <TuiConfigProvider config={input.config}>
                                      <OfficeProvider
                                        socket={input.socket}
                                        token={input.token}
                                        person={input.person}
                                        cwd={input.cwd}
                                        local={input.local !== undefined}
                                      >
                                        <PermissionProvider>
                                          <ThemeProvider mode={mode}>
                                            <LocalProvider>
                                              <PromptStashProvider>
                                                <DialogProvider>
                                                  <FrecencyProvider>
                                                    <PromptHistoryProvider>
                                                      <PromptRefProvider>
                                                        <EditorContextProvider>
                                                          <PanelProvider>
                                                            <App onSnapshot={input.onSnapshot} />
                                                          </PanelProvider>
                                                        </EditorContextProvider>
                                                      </PromptRefProvider>
                                                    </PromptHistoryProvider>
                                                  </FrecencyProvider>
                                                </DialogProvider>
                                              </PromptStashProvider>
                                            </LocalProvider>
                                          </ThemeProvider>
                                        </PermissionProvider>
                                      </OfficeProvider>
                                    </TuiConfigProvider>
                                  </RouteProvider>
                                </ToastProvider>
                              </KVProvider>
                            </ArgsProvider>
                          </OpenCorpKeymapProvider>
                        </ClipboardProvider>
                      </TuiStartupProvider>
                    </TuiTerminalEnvironmentProvider>
                  </TuiPathsProvider>
                </ErrorBoundary>
              </EpilogueProvider>
            </ExitProvider>
          )
        }, renderer)
      })
      yield* Deferred.await(shutdown)
      return { epilogue: exit.epilogue, reason: exit.reason }
    }),
  )
  yield* Effect.sync(() => {
    win32FlushInputBuffer()
    if (result.reason !== undefined) {
      process.stderr.write(errorFormat(result.reason) + "\n")
      process.exitCode = 1
    }
    if (result.epilogue) process.stdout.write(result.epilogue + "\n")
  })
})

function App(props: { onSnapshot?: () => Promise<string[]> }) {
  const tuiConfig = useTuiConfig()
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const dialog = useDialog()
  const local = useLocal()
  const kv = useKV()
  const keymap = useOpenCorpKeymap()
  const toast = useToast()
  const themeState = useTheme()
  const { theme, mode, setMode, locked, lock, unlock } = themeState
  const office = useOffice()
  const leave = pressTwice(5000)
  const exit = useExit()
  const promptRef = usePromptRef()
  const clipboard = useClipboard()
  const panels = usePanel()
  useProfileCommands()
  usePickerOnStart()

  // Let selection copy/dismiss win ahead of normal bindings when explicit copy is required.
  const offSelectionKeys = keymap.intercept(
    "key",
    ({ event }) => {
      if (!Flag.OPENCORP_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
      Selection.handleSelectionKey(renderer, toast, event, clipboard)
    },
    { priority: 1 },
  )
  onCleanup(() => {
    offSelectionKeys()
  })

  // Wire up console copy-to-clipboard via opentui's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return

    await clipboard
      .write?.(text)
      .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
      .catch(toast.error)

    renderer.clearSelection()
  }
  const [terminalTitleEnabled, setTerminalTitleEnabled] = createSignal(kv.get("terminal_title_enabled", true))
  const [pasteSummaryEnabled, setPasteSummaryEnabled] = createSignal(kv.get("paste_summary_enabled", true))
  const [startOnLastPick, setStartOnLastPick] = kv.signal("start_on_last_pick", false)

  // Measure the prospective split layout, and close the pane once its session is left.
  createEffect(() => panels.setWidth(dimensions().width))
  createEffect(() => {
    const current = panels.current()
    if (!current || (route.data.type === "session" && route.data.sessionID === current.sessionID)) return
    panels.close()
  })

  // Update terminal window title based on current route and session
  createEffect(() => {
    if (!terminalTitleEnabled() || Flag.OPENCORP_DISABLE_TERMINAL_TITLE) return

    if (route.data.type === "session") {
      const sessionID = route.data.sessionID
      const session = office.state.sessions.find((s) => s.id === sessionID)
      if (session) return setTerminalTitle(renderer, `opencorp | ${personLabel(office.state.people, session.person)}`)
    }
    setTerminalTitle(renderer, "opencorp")
  })

  const args = useArgs()
  onMount(() => {
    batch(() => {
      if (args.sessionID) {
        route.navigate({
          type: "session",
          sessionID: args.sessionID,
        })
      }
    })
  })

  // `--continue` opens the newest main session in cwd once the office has listed its sessions.
  let continued = false
  createEffect(() => {
    if (continued || !args.continue || office.status() !== "online") return
    continued = true
    const match = sessionsIn(office.state, office.cwd)[0]
    if (match) route.navigate({ type: "session", sessionID: match.id })
  })

  const appCommands = createMemo(() =>
    [
      {
        name: COMMAND_PALETTE_COMMAND,
        title: "Show command palette",
        category: "System",
        hidden: true,
        run: () => {
          dialog.replace(() => <CommandPaletteDialog />)
        },
      },
      {
        name: "session.list",
        title: "Switch session",
        category: "Session",
        // A local session is the only one there is.
        hidden: office.local,
        enabled: !office.local,
        suggested: sessionsIn(office.state, office.cwd).length > 0,
        slashName: "sessions",
        slashAliases: ["resume", "continue"],
        run: () => {
          dialog.replace(() => <DialogSessionList />)
        },
      },
      {
        name: "session.new",
        title: "New session",
        hidden: office.local,
        enabled: !office.local,
        suggested: route.data.type === "session",
        category: "Session",
        slashName: "new",
        slashAliases: ["clear"],
        run: () => {
          route.navigate({
            type: "home",
          })
          dialog.clear()
        },
      },
      ...Array.from({ length: 9 }, (_, i) => ({
        name: `session.quick_switch.${i + 1}`,
        title: `Switch to session in quick slot ${i + 1}`,
        category: "Session",
        hidden: true,
        enabled: !office.local,
        run: () => {
          local.session.quickSwitch(i + 1)
        },
      })),
      {
        name: "person.list",
        title: "Switch person",
        category: "Person",
        slashName: "people",
        run: () => {
          dialog.replace(() => <DialogPeople />)
        },
      },
      {
        name: "model.list",
        title: "Switch model",
        category: "Session",
        slashName: "model",
        slashAliases: ["models"],
        run: () => {
          dialog.replace(() => <DialogModel />)
        },
      },
      {
        name: "model.last_pick.toggle",
        title: startOnLastPick() ? "Stop starting new chats on my last pick" : "Start new chats on my last pick",
        category: "Session",
        run: () => {
          setStartOnLastPick((prev) => !prev)
          dialog.clear()
        },
      },
      {
        name: "provider.connect",
        title: "Connect a provider",
        category: "Provider",
        slashName: "connect",
        // Adding, removing and the default are the office owner's, or a grant's.
        hidden: !office.canManage(),
        run: () => {
          if (office.canManage()) dialog.replace(() => <DialogConnect />)
        },
      },
      {
        name: "agent.cycle",
        title: "Next person",
        category: "Person",
        hidden: true,
        run: () => {
          local.person.cycle(1)
        },
      },
      {
        name: "agent.cycle.reverse",
        title: "Previous person",
        category: "Person",
        hidden: true,
        run: () => {
          local.person.cycle(-1)
        },
      },
      {
        name: "opencorp.debug",
        title: "View debug info",
        slashName: "debug",
        run: () => {
          dialog.replace(() => <DialogDebug />)
        },
        category: "System",
      },
      {
        name: "theme.switch",
        title: "Switch theme",
        slashName: "themes",
        run: () => {
          dialog.replace(() => <DialogThemeList />)
        },
        category: "System",
      },
      {
        name: "theme.switch_mode",
        title: mode() === "dark" ? "Switch to light mode" : "Switch to dark mode",
        run: () => {
          setMode(mode() === "dark" ? "light" : "dark")
          dialog.clear()
        },
        category: "System",
      },
      {
        name: "theme.mode.lock",
        title: locked() ? "Unlock theme mode" : "Lock theme mode",
        run: () => {
          if (locked()) unlock()
          else lock()
          dialog.clear()
        },
        category: "System",
      },
      {
        name: "help.show",
        title: "Help",
        slashName: "help",
        run: () => {
          dialog.replace(() => <DialogHelp />)
        },
        category: "System",
      },
      {
        name: "app.exit",
        title: "Exit the app",
        slashName: "exit",
        slashAliases: ["quit", "q"],
        run: () => exit(),
        category: "System",
      },
      {
        name: "app.leave",
        title: "Leave the app",
        hidden: true,
        run: () => {
          // Leaving a chat only detaches; it takes a second press so a stray Ctrl+C doesn't.
          if (route.data.type !== "session" || leave()) return exit()
          const sessionID = route.data.sessionID
          const status = office.state.sessions.find((s) => s.id === sessionID)?.status
          // An interrupted session has no live run either, until something resumes it.
          const over = status === "ended" || status === "failed" || status === "interrupted"
          toast.show({
            // A local session ends with the TUI: leaving it isn't a pause.
            message: over
              ? "Press again to leave."
              : office.local
                ? "Press again to leave; this ends the session."
                : "Press again to leave; the session is saved.",
            variant: "info",
          })
        },
        category: "System",
      },
      {
        name: "app.debug",
        title: "Toggle debug panel",
        category: "System",
        run: () => {
          renderer.toggleDebugOverlay()
          dialog.clear()
        },
      },
      {
        name: "app.console",
        title: "Toggle console",
        category: "System",
        run: () => {
          renderer.console.toggle()
          dialog.clear()
        },
      },
      {
        name: "app.heap_snapshot",
        title: "Write heap snapshot",
        category: "System",
        run: async () => {
          const files = await props.onSnapshot?.()
          toast.show({
            variant: "info",
            message: `Heap snapshot written to ${files?.join(", ")}`,
            duration: 5000,
          })
          dialog.clear()
        },
      },
      {
        name: "terminal.suspend",
        title: "Suspend terminal",
        category: "System",
        hidden: true,
        enabled: process.platform !== "win32",
        run: async () => {
          await renderer.suspend()
          process.once("SIGCONT", () => renderer.resume())
          process.kill(0, "SIGTSTP")
        },
      },
      {
        name: "terminal.title.toggle",
        title: terminalTitleEnabled() ? "Disable terminal title" : "Enable terminal title",
        category: "System",
        run: () => {
          setTerminalTitleEnabled((prev) => {
            const next = !prev
            kv.set("terminal_title_enabled", next)
            if (!next) setTerminalTitle(renderer, "")
            return next
          })
          dialog.clear()
        },
      },
      {
        name: "app.toggle.animations",
        title: kv.get("animations_enabled", true) ? "Disable animations" : "Enable animations",
        category: "System",
        run: () => {
          kv.set("animations_enabled", !kv.get("animations_enabled", true))
          dialog.clear()
        },
      },
      {
        name: "app.toggle.file_context",
        title: kv.get("file_context_enabled", true) ? "Disable file context" : "Enable file context",
        category: "System",
        run: () => {
          kv.set("file_context_enabled", !kv.get("file_context_enabled", true))
          dialog.clear()
        },
      },
      {
        name: "app.toggle.diffwrap",
        title: kv.get("diff_wrap_mode", "word") === "word" ? "Disable diff wrapping" : "Enable diff wrapping",
        category: "System",
        run: () => {
          const current = kv.get("diff_wrap_mode", "word")
          kv.set("diff_wrap_mode", current === "word" ? "none" : "word")
          dialog.clear()
        },
      },
      {
        name: "app.toggle.paste_summary",
        title: pasteSummaryEnabled() ? "Disable paste summary" : "Enable paste summary",
        category: "System",
        run: () => {
          setPasteSummaryEnabled((prev) => {
            const next = !prev
            kv.set("paste_summary_enabled", next)
            return next
          })
          dialog.clear()
        },
      },
      {
        name: "app.toggle.session_directory_filter",
        title: kv.get("session_directory_filter_enabled", true)
          ? "Disable session directory filtering"
          : "Enable session directory filtering",
        category: "System",
        run: () => {
          kv.set("session_directory_filter_enabled", !kv.get("session_directory_filter_enabled", true))
          dialog.clear()
        },
      },
    ].map((command) => ({
      namespace: "palette",
      ...command,
    })),
  )

  useBindings(() => ({
    commands: appCommands(),
  }))

  useBindings(() => ({
    mode: OPENCORP_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("app", appBindingCommands),
  }))

  useBindings(() => ({
    bindings: tuiConfig.keybinds.gather("app.global", appGlobalBindingCommands),
  }))

  useBindings(() => ({
    mode: OPENCORP_BASE_MODE,
    enabled: () => {
      const current = promptRef.current
      if (!current?.focused) return true
      return current.current.input === ""
    },
    bindings: leaveBindings(tuiConfig.keybinds.gather("app_exit", ["app.exit"])),
  }))

  // Suppress the full-screen overlay for transient startup and event-stream retry states: the first connection gets
  // a longer grace, and home none, since its own notes say why the TUI waits; a drop surfaces more quickly.
  const [showReconnecting, setShowReconnecting] = createSignal(false)
  const onHome = createMemo(() => route.data.type === "home")
  let wasOnline = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
    const status = office.status()
    if (status === "online") {
      wasOnline = true
      setShowReconnecting(false)
      return
    }
    if (!wasOnline && onHome()) {
      setShowReconnecting(false)
      return
    }
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = undefined
        setShowReconnecting(true)
      },
      wasOnline ? 1000 : 5000,
    ).unref()
  })
  onCleanup(() => {
    if (reconnectTimer) clearTimeout(reconnectTimer)
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background}
      onMouseDown={(evt) => {
        if (!Flag.OPENCORP_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
        if (evt.button !== MouseButton.RIGHT) return

        if (!Selection.copy(renderer, toast, clipboard)) return
        evt.preventDefault()
        evt.stopPropagation()
      }}
      onMouseUp={
        !Flag.OPENCORP_EXPERIMENTAL_DISABLE_COPY_ON_SELECT
          ? () => Selection.copy(renderer, toast, clipboard)
          : undefined
      }
    >
      <Show when={Flag.OPENCORP_SHOW_TTFD}>
        <TimeToFirstDraw />
      </Show>
      <box flexGrow={1} minHeight={0} flexDirection="column">
        <Switch>
          <Match when={route.data.type === "home"}>
            <Home />
          </Match>
          <Match when={route.data.type === "profile"}>
            <Show when={route.data.type === "profile" ? route.data.person : undefined} keyed>
              {(_) => <Profile />}
            </Show>
          </Match>
          <Match when={route.data.type === "session"}>
            <Show when={route.data.type === "session" ? route.data.sessionID : undefined} keyed>
              {(sessionID) => <SessionFrame sessionID={sessionID} />}
            </Show>
          </Match>
        </Switch>
      </box>
      <Show when={showReconnecting()}>
        <Reconnecting error={office.status() === "error" ? office.error() : undefined} />
      </Show>
    </box>
  )
}
