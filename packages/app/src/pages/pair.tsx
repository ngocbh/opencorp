import { OfficeError, createOfficeClient } from "@opencorp/client"
import { useNavigate } from "@solidjs/router"
import { createSignal, onMount, Show } from "solid-js"

const EXPIRED = "This link has expired or was already used. Run `opencorp pair` again."

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
  const [failed, setFailed] = createSignal<string>()
  onMount(async () => {
    const code = location.hash.slice(1)
    // The code leaves the URL (and the history entry) before anything else runs.
    history.replaceState(null, "", "/pair")
    if (!code) return setFailed(EXPIRED)
    try {
      const client = createOfficeClient({ baseUrl: "/api" })
      const session = await client.pair({ code, label: browserLabel(navigator.userAgent) })
      // Not a secret (the cookie is HttpOnly): only who paired this browser, for the sidebar.
      const { id, name, issued_by } = session
      localStorage.setItem("hq.session", JSON.stringify({ id, name, issued_by }))
      navigate("/", { replace: true })
    } catch (e) {
      setFailed(
        e instanceof OfficeError && e.code === "pair_code_invalid"
          ? EXPIRED
          : `Couldn't sign in: ${e instanceof Error ? e.message : e}`,
      )
    }
  })
  return (
    <main class="mx-auto max-w-md p-8">
      <Show when={failed()} fallback={<p>Signing in…</p>}>
        <p role="alert">{failed()}</p>
      </Show>
    </main>
  )
}
