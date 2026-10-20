import { OfficeError, createOfficeClient } from "@opencorp/client"
import { useNavigate } from "@solidjs/router"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { browserLabel, rememberSession } from "../data/sign-in"

const EXPIRED = "This link has expired or was already used."

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
      rememberSession(session)
      navigate("/org", { replace: true })
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
