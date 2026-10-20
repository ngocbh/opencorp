import { createOfficeClient } from "@opencorp/client"
import { useNavigate } from "@solidjs/router"
import { createSignal, For, Show } from "solid-js"
import { browserLabel, cleanHandle, isHandle, rememberSession, signInFailure } from "../data/sign-in"

/** `text` with its backticked spans as code. */
const Coded = (props: { text: string }) => (
  <For each={props.text.split("`")}>{(part, i) => (i() % 2 ? <code>{part}</code> : part)}</For>
)

/** The alert's id, which the fields name as their description while it shows. */
const ERROR = "sign-in-error"

const field =
  "mt-1 block w-full rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"

/** Where a browser without a session lands: a handle and password, or `opencorp pair` on the office machine. */
export default function SignIn() {
  const navigate = useNavigate()
  const [failed, setFailed] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  let handle!: HTMLInputElement
  let password!: HTMLInputElement

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (busy()) return
    setFailed(undefined)
    const typed = cleanHandle(handle.value)
    // The office would refuse it with a 422; to the person it's just a wrong handle.
    if (!isHandle(typed)) return fail("Wrong handle or password.")
    setBusy(true)
    try {
      const client = createOfficeClient({ baseUrl: "/api" })
      const session = await client.signIn({
        handle: typed,
        password: password.value,
        label: browserLabel(navigator.userAgent),
      })
      rememberSession(session)
      navigate("/", { replace: true })
    } catch (err) {
      fail(signInFailure(err))
    } finally {
      setBusy(false)
    }
  }

  /** Shows `text` in the alert, and clears the password for the next try. */
  function fail(text: string) {
    password.value = ""
    setFailed(text)
    password.focus()
  }

  return (
    <main class="mx-auto max-w-md p-8">
      <h1 class="text-lg font-semibold">Sign in to OpenCorp HQ</h1>
      {/* method="post": if the form ever submitted itself, the password would go in a body, never in the URL. */}
      <form method="post" class="mt-4 space-y-3" aria-busy={busy()} onSubmit={submit}>
        <div>
          <label for="handle" class="text-sm font-medium">
            Handle
          </label>
          <input
            ref={handle}
            id="handle"
            name="handle"
            autocomplete="username"
            autocapitalize="none"
            spellcheck={false}
            required
            readOnly={busy()}
            aria-describedby={failed() ? ERROR : undefined}
            class={field}
          />
        </div>
        <div>
          <label for="password" class="text-sm font-medium">
            Password
          </label>
          <input
            ref={password}
            id="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
            readOnly={busy()}
            aria-invalid={failed() ? true : undefined}
            aria-describedby={failed() ? ERROR : undefined}
            class={field}
          />
        </div>
        <Show when={failed()}>
          {(text) => (
            <p id={ERROR} role="alert" class="text-sm text-red-700 dark:text-red-400">
              <Coded text={text()} />
            </p>
          )}
        </Show>
        <button
          type="submit"
          disabled={busy()}
          class="rounded bg-neutral-900 px-3 py-1 text-white disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {busy() ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p class="mt-6">
        Or run <code>opencorp pair</code> on the office machine and open the link it prints.
      </p>
      <p class="mt-2 text-sm text-neutral-500">
        Over SSH, <code>opencorp pair</code> prints the <code>ssh -N -L</code> command to run first.
      </p>
    </main>
  )
}
