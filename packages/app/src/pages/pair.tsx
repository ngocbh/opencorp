import { OfficeError, createOfficeClient } from "@opencorp/client"
import { useNavigate } from "@solidjs/router"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { store } from "../data/storage"

const EXPIRED = "This link has expired or was already used."

/** "Safari on Mac", from the user agent, to name this browser in `opencorp devices list`. */
export function browserLabel(ua: string) {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "A browser"
  const os = /iPhone|iPad/.test(ua)
    ? "iPhone"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "Mac"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "this device"
  return `${browser} on ${os}`
}

/** `/pair#<code>`: spends the code and signs this browser in. */
export default function Pair() {
  const navigate = useNavigate()
  /** Why this link didn't sign in; the page then says to run `opencorp pair` again. */
  const [failed, setFailed] = createSignal<string>()
  async function spend() {
    const code = location.hash.slice(1)
    // The code leaves the URL (and the history entry) before anything else runs.
    history.replaceState(history.state, "", "/pair")
    setFailed(undefined)
    if (!code) return setFailed(EXPIRED)
    try {
      const client = createOfficeClient({ baseUrl: "/api" })
      const session = await client.pair({ code, label: browserLabel(navigator.userAgent) })
      // Not a secret (the cookie is HttpOnly): only who paired this browser, for the sidebar.
      const { id, name, issued_by } = session
      store("localStorage", "hq.session", JSON.stringify({ id, name, issued_by }))
      navigate("/", { replace: true })
    } catch (e) {
      if (e instanceof OfficeError && e.code === "pair_code_invalid") return setFailed(EXPIRED)
      // The code has left the URL, so this tab can't try it again.
      setFailed(`Couldn't sign in: ${e instanceof Error ? e.message : e}.`)
    }
  }
  // A new link opened in this tab changes only the fragment, so the page stays mounted.
  const onHash = () => void (location.hash.length > 1 && spend())
  onMount(() => {
    window.addEventListener("hashchange", onHash)
    void spend()
  })
  onCleanup(() => window.removeEventListener("hashchange", onHash))
  return (
    <main class="mx-auto max-w-md p-8">
      <h1 class="text-lg font-semibold">Sign in to OpenCorp HQ</h1>
      <Show
        when={failed()}
        fallback={
          <p role="status" class="mt-4">
            Signing in…
          </p>
        }
      >
        <p role="alert" class="mt-4">
          {failed()} Run <code>opencorp pair</code> again.
        </p>
      </Show>
    </main>
  )
}
