import type { AddConnectionRequest, ConnectionLogin } from "@agent-corp/protocol"
import { InputRenderable, TextAttributes } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useClipboard } from "../context/clipboard"
import { useOffice } from "../context/office"
import { useTheme } from "../context/theme"
import { openUrl } from "../core/open"
import { useBindings } from "../keymap"
import { OFFICE } from "../office/models"
import { SecretInput } from "../setup/secret"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { DialogModel } from "./dialog-model"
import { Spinner } from "./spinner"

/** A provider to connect: the office's `provider` id and what to ask before the key. */
type Provider = {
  title: string
  id: string
  /** The endpoint question and its placeholder, for a provider reached at an endpoint of the owner's. */
  endpoint?: { label: string; placeholder: string }
  /** The model name's placeholder, for a provider with no default model. */
  model?: string
  /** Signed in to with a subscription in the browser, rather than with a key. */
  subscription?: boolean
}

/** How often the sign-in screen asks the office whether the human has signed in. */
const LOGIN_POLL_MS = 2_000

const PROVIDERS: Provider[] = [
  {
    title: "Azure OpenAI",
    id: "azure",
    endpoint: { label: "Endpoint or resource name", placeholder: "my-resource, or https://my-resource.openai.azure.com" },
  },
  { title: "OpenAI", id: "openai" },
  { title: "ChatGPT subscription", id: "openai", subscription: true },
  { title: "Anthropic", id: "anthropic" },
  { title: "Google", id: "google", model: "e.g. gemini-2.5-pro" },
  { title: "OpenRouter", id: "openrouter", model: "e.g. anthropic/claude-sonnet-4.5" },
  { title: "xAI", id: "xai", model: "e.g. grok-4" },
  { title: "DeepSeek", id: "deepseek", model: "e.g. deepseek-chat" },
  {
    title: "Other (OpenAI-compatible)",
    // The office takes another OpenAI-compatible endpoint as provider openai with a base URL.
    id: "openai",
    endpoint: { label: "Base URL", placeholder: "https://llm.example.com/v1" },
    model: "the model's id at that endpoint",
  },
]

/** A row: one of the office's connections, or a provider to add. */
type Row = { connection: string } | { provider: number }

/**
 * `/connect`: the office's connections, to make default or remove, and the providers to add one with a key or, for
 * a subscription, by signing in.
 */
export function DialogConnect() {
  const [provider, setProvider] = createSignal<Provider>()
  // In a box: the dialog re-runs a bare Show's parent when it switches, which would start the dialog over.
  return (
    <box>
      <Show when={provider()} keyed fallback={<ConnectList onPick={setProvider} />}>
        {(p) => (p.subscription ? <SubscriptionMethod provider={p} /> : <ConnectForm provider={p} />)}
      </Show>
    </box>
  )
}

function ConnectList(props: { onPick: (provider: Provider) => void }) {
  const dialog = useDialog()
  const office = useOffice()
  const toast = useToast()
  const [select, setSelect] = createSignal<DialogSelectRef<Row>>()

  onMount(() => {
    office.refreshConnections().catch((e) => {
      toast.show({ variant: "error", message: `Couldn't list connections: ${errorMessage(e)}` })
    })
  })

  const connections = () => office.connections()?.connections ?? []
  const options = createMemo(() => [
    ...connections().map((c) => ({
      title: c.name,
      description: c.model ? `${c.provider} · ${c.model}` : c.provider,
      footer: c.default ? "default" : undefined,
      value: { connection: c.name } as Row,
      category: "Connected",
    })),
    ...PROVIDERS.map((p, i) => ({ title: p.title, value: { provider: i } as Row, category: "Add a provider" })),
  ])

  const highlighted = createMemo(() => {
    const row = select()?.selected?.value
    return row && "connection" in row ? connections().find((c) => c.name === row.connection) : undefined
  })
  const canDefault = createMemo(() => office.canManage() && highlighted()?.default === false)
  // `office` is office/provider.json, which only `ac onboard` changes.
  const canRemove = createMemo(() => office.canManage() && !!highlighted() && highlighted()?.name !== OFFICE)

  async function makeDefault(name: string) {
    try {
      await office.client.connections.setDefault({ connection: name })
      toast.show({ variant: "success", message: `New chats start on ${name}` })
    } catch (e) {
      toast.error(e)
    }
    await office.refreshConnections().catch(() => {})
  }

  async function remove(name: string) {
    const sure = await DialogConfirm.show(
      dialog,
      `Remove ${name}?`,
      "Chats on it move to the default on their next message.",
    )
    // Back to the list now: the user may open something else before the office answers.
    dialog.replace(() => <DialogConnect />)
    if (!sure) return
    try {
      await office.client.connections.remove(name)
      toast.show({ variant: "success", message: `Removed ${name}` })
    } catch (e) {
      toast.error(e)
    }
    await office.refreshConnections().catch(() => {})
  }

  return (
    <DialogSelect<Row>
      title="Connect a provider"
      placeholder="Search"
      options={options()}
      ref={setSelect}
      // The list is re-read after each change; keep the highlight on its row.
      preserveSelection={true}
      onSelect={(option) => {
        const row = option.value
        if ("provider" in row) return props.onPick(PROVIDERS[row.provider])
        dialog.replace(() => <DialogModel connection={row.connection} />)
      }}
      actions={[
        {
          command: "connect.dialog.default",
          title: "make default",
          hidden: !canDefault(),
          onTrigger: (option) => {
            if ("connection" in option.value) void makeDefault(option.value.connection)
          },
        },
        {
          command: "connect.dialog.remove",
          title: "remove",
          hidden: !canRemove(),
          onTrigger: (option) => {
            if ("connection" in option.value) void remove(option.value.connection)
          },
        },
      ]}
    />
  )
}

/** The questions for `provider`, one at a time, then its key, which goes straight to the office. */
function ConnectForm(props: { provider: Provider }) {
  const dialog = useDialog()
  const office = useOffice()
  const toast = useToast()
  const { theme } = useTheme()
  const fields = [
    ...(props.provider.endpoint ? [{ key: "endpoint" as const, ...props.provider.endpoint }] : []),
    ...(props.provider.model ? [{ key: "model" as const, label: "Model name", placeholder: props.provider.model }] : []),
  ]
  const [answers, setAnswers] = createStore<{ endpoint?: string; model?: string }>({})
  const [step, setStep] = createSignal(0)
  const [error, setError] = createSignal<string>()
  const [checking, setChecking] = createSignal(false)
  const field = () => fields[step()]
  // Esc can close the dialog while the key is checked; its answer must not touch whatever is open then.
  let closed = false
  onCleanup(() => (closed = true))

  function answer(value: string) {
    const f = field()
    if (!f) return
    const text = value.trim()
    if (!text) return setError(f.key === "model" ? "Type the model's name" : `Type the ${f.label.toLowerCase()}`)
    setError(undefined)
    setAnswers(f.key, text)
    setStep(step() + 1)
  }

  // The key goes from the box to the request; nothing here keeps it.
  async function connect(apiKey: string) {
    if (checking()) return
    if (!apiKey.trim()) return setError("Paste or type the key")
    const req: AddConnectionRequest = { provider: props.provider.id, api_key: apiKey.trim() }
    if (answers.endpoint) req.endpoint = answers.endpoint
    if (answers.model) req.model = answers.model
    setError(undefined)
    setChecking(true)
    let name: string
    try {
      name = (await office.client.connections.add(req)).name
    } catch (e) {
      // Closed while the key was checked: the box is gone, so say it where it will be seen.
      if (closed) {
        return toast.show({ variant: "error", message: `Couldn't connect ${props.provider.title}: ${errorMessage(e)}` })
      }
      setChecking(false)
      return setError(errorMessage(e))
    }
    await office.refreshConnections().catch(() => {})
    toast.show({ variant: "success", message: `Connected ${name}` })
    if (closed) return
    dialog.replace(() => <DialogModel connection={name} />)
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {`Connect ${props.provider.title}`}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={step() > 0}>
        <box>
          <For each={fields.slice(0, step())}>
            {(f) => (
              <text fg={theme.textMuted}>
                {f.label}: <span style={{ fg: theme.text }}>{answers[f.key]}</span>
              </text>
            )}
          </For>
        </box>
      </Show>
      <Show when={field()} keyed fallback={<KeyBox checking={checking()} onSubmit={(value) => void connect(value)} />}>
        {(f) => <TextField label={f.label} placeholder={f.placeholder} onSubmit={answer} />}
      </Show>
      <Show when={error()}>
        <text fg={theme.error} wrapMode="word">
          {error()}
        </text>
      </Show>
      <box paddingBottom={1} />
    </box>
  )
}

/**
 * A subscription sign-in: the office starts it, this shows the link and the code to enter there, then reads it
 * every 2 s until it ends. Each read is a short call, as office reads time out at 15 s.
 */
function SubscriptionMethod(props: { provider: Provider }) {
  const dialog = useDialog()
  const office = useOffice()
  const toast = useToast()
  const clipboard = useClipboard()
  const renderer = useRenderer()
  const { theme } = useTheme()
  const [login, setLogin] = createSignal<ConnectionLogin>()
  const [error, setError] = createSignal<string>()
  const waiting = () => login()?.state === "waiting" && !error()
  // The office can answer before the provider has given a code; a later read brings it.
  const code = () => (waiting() ? login()?.user_code : undefined)
  // Closing or replacing the dialog stops the reads; a late answer must not touch whatever is open then.
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = (id: string) => office.client.connections.cancelLogin(id).catch(() => {})
  onCleanup(() => {
    closed = true
    clearTimeout(timer)
    const current = login()
    // So the office stops waiting on a sign-in no one will finish.
    if (current?.state === "waiting") void cancel(current.id)
  })

  onMount(async () => {
    // The search box of the list before this keeps focus once removed; it must not take the `c`.
    renderer.currentFocusedRenderable?.blur()
    let started: ConnectionLogin
    try {
      started = await office.client.connections.startLogin({ provider: "openai" })
    } catch (e) {
      if (!closed) setError(`Couldn't start the sign-in: ${errorMessage(e)}. Try /connect again.`)
      return
    }
    if (closed) return void cancel(started.id)
    show(started)
  })

  function show(next: ConnectionLogin) {
    setLogin(next)
    if (next.state === "waiting") timer = setTimeout(() => void poll(next.id), LOGIN_POLL_MS)
    else if (next.state === "signed_in") void finish(next.connection)
  }

  async function poll(id: string) {
    let next: ConnectionLogin
    try {
      next = await office.client.connections.login(id)
    } catch (e) {
      // A finished sign-in is forgotten after a while, and then reads as not found; either way it can't be waited on.
      if (!closed) setError(`Couldn't check the sign-in: ${errorMessage(e)}. Try /connect again.`)
      return
    }
    if (!closed) show(next)
  }

  async function finish(name?: string | null) {
    await office.refreshConnections().catch(() => {})
    toast.show({ variant: "success", message: name ? `Connected ${name}` : "Signed in" })
    if (closed) return
    dialog.replace(() => <DialogModel connection={name ?? undefined} />)
  }

  useBindings(() => ({
    enabled: () => !!code() && renderer.currentFocusedEditor === null,
    bindings: [
      {
        key: "c",
        desc: "Copy the sign-in code",
        group: "Dialog",
        cmd: () => {
          clipboard
            .write?.(code() ?? "")
            .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
            .catch(toast.error)
        },
      },
    ],
  }))

  const ended = () => {
    const current = login()
    if (current?.state === "failed")
      return `Sign-in failed${current.message ? ` (${current.message})` : ""}. Try /connect again.`
    if (current?.state === "cancelled") return "The sign-in was cancelled. Try /connect again."
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {`Connect ${props.provider.title}`}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={(!login() && !error()) || (waiting() && !code())}>
        <Spinner color={theme.textMuted}>Getting a sign-in code…</Spinner>
      </Show>
      <Show when={code() && login()}>
        {(current) => (
          <>
            <box>
              <text fg={theme.textMuted}>Open this link and enter the code:</text>
              <text fg={theme.primary} wrapMode="char" onMouseUp={() => openUrl(current().url ?? "").catch(() => {})}>
                {current().url}
              </text>
            </box>
            <text attributes={TextAttributes.BOLD} fg={theme.text}>
              {current().user_code}
            </text>
            <Spinner color={theme.textMuted}>Waiting for you to sign in…</Spinner>
            <text fg={theme.text}>
              c <span style={{ fg: theme.textMuted }}>copy</span>
            </text>
          </>
        )}
      </Show>
      <Show when={error() ?? ended()}>
        {(message) => (
          <text fg={theme.error} wrapMode="word">
            {message()}
          </text>
        )}
      </Show>
      <box paddingBottom={1} />
    </box>
  )
}

/** The masked key box, or "Checking the key…" while the office checks it. */
function KeyBox(props: { checking: boolean; onSubmit: (value: string) => void }) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  // The key box reads every key itself. An input removed from the screen keeps focus, and would take the
  // key's keys too, so nothing may have focus beside it.
  onMount(() => renderer.currentFocusedRenderable?.blur())
  return (
    <box>
      <text fg={theme.text}>API key</text>
      <Show when={!props.checking} fallback={<Spinner color={theme.textMuted}>Checking the key…</Spinner>}>
        <SecretInput
          placeholder="Paste or type it here; it isn't shown"
          fg={theme.text}
          placeholderFg={theme.textMuted}
          onSubmit={props.onSubmit}
        />
      </Show>
    </box>
  )
}

/** A labelled plain input that takes focus once mounted; Enter hands over its text. */
function TextField(props: { label: string; placeholder: string; onSubmit: (value: string) => void }) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  let input: InputRenderable | undefined
  onMount(() => {
    // The input before this one keeps focus once removed; it must not take what is typed here.
    renderer.currentFocusedRenderable?.blur()
    setTimeout(() => {
      if (input && !input.isDestroyed) input.focus()
    }, 1)
  })
  return (
    <box>
      <text fg={theme.text}>{props.label}</text>
      <input
        ref={(r) => (input = r)}
        placeholder={props.placeholder}
        placeholderColor={theme.textMuted}
        focusedBackgroundColor={theme.backgroundPanel}
        cursorColor={theme.primary}
        onSubmit={() => props.onSubmit(input?.value ?? "")}
      />
    </box>
  )
}
