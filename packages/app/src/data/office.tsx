// The office as the app sees it: one client for HQ's /api, who is signed in, and the live state createOfficeSync
// keeps with HQ's snapshot. Follows the TUI's office context (packages/tui/src/context/office.tsx).
import { createOfficeClient, UnknownDevice } from "@opencorp/client"
import { useNavigate } from "@solidjs/router"
import { createContext, createSignal, onMount, useContext, type ParentProps } from "solid-js"

function createOffice(toSignIn: () => void) {
  const client = createOfficeClient({ baseUrl: "/api" })
  const [me, setMe] = createSignal<string>()
  let signedOut = false

  function signOut() {
    if (signedOut) return
    signedOut = true
    toSignIn()
  }

  /** Reads who this browser is; a 401 (no session, expired, revoked, a password change, offboarded) is sign-in. */
  async function checkSignedIn() {
    try {
      setMe((await client.whoami()).person)
      return true
    } catch (e) {
      if (e instanceof UnknownDevice) signOut() // the client maps every 401 to UnknownDevice
      return false
    }
  }

  onMount(() => void checkSignedIn())
  return { client, me }
}

export type Office = ReturnType<typeof createOffice>
const OfficeContext = createContext<Office>()

/** Gives the shell and the pages the office; rendered inside the router, so it can send a browser to sign-in. */
export function OfficeProvider(props: ParentProps) {
  const navigate = useNavigate()
  const office = createOffice(() => navigate("/sign-in", { replace: true }))
  return <OfficeContext.Provider value={office}>{props.children}</OfficeContext.Provider>
}

/** The office, inside an OfficeProvider. */
export function useOffice() {
  const office = useContext(OfficeContext)
  if (!office) throw new Error("useOffice needs an OfficeProvider")
  return office
}
