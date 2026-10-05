import type { AddConnectionRequest } from "@agent-corp/protocol"
import { InputRenderable, TextAttributes } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useOffice } from "../context/office"
import { useTheme } from "../context/theme"
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
}

const PROVIDERS: Provider[] = [
  {
    title: "Azure OpenAI",
    id: "azure",
    endpoint: { label: "Endpoint or resource name", placeholder: "my-resource, or https://my-resource.openai.azure.com" },
  },
  { title: "OpenAI", id: "openai" },
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

/** `/connect`: the office's connections, to make default or remove, and the providers to add one with a key. */
export function DialogConnect() {
  const [provider, setProvider] = createSignal<Provider>()
  // In a box: the dialog re-runs a bare Show's parent when it switches, which would start the dialog over.
  return (
    <box>
      <Show when={provider()} keyed fallback={<ConnectList onPick={setProvider} />}>
        {(p) => <ConnectForm provider={p} />}
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
