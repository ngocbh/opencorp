import { A } from "@solidjs/router"
import { ErrorBoundary, onMount, Show, type ParentProps } from "solid-js"
import { useOffice } from "./data/office"

/** What the shell shows in place of the app when the built app can't run against this office. */
const BLOCKED = {
  out_of_date: () => (
    <>
      The web app doesn't match the office. Run <code>bun run build</code>, or <code>opencorp restart</code>.
    </>
  ),
  not_built: () => (
    <>
      The web app isn't built: run <code>bun run build</code> in the checkout.
    </>
  ),
}

/**
 * What a page that failed to load shows. It checks the version itself too: Vite may not wrap a chunk that has no
 * dependencies of its own in the helper that fires vite:preloadError.
 */
function LoadFailed() {
  const office = useOffice()
  onMount(() => void office.checkVersion())
  return (
    <div role="alert" class="p-6">
      This screen didn't load.{" "}
      <button type="button" class="underline" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  )
}

/** The sidebar (company, screens, who is signed in, the connection) and the main area. */
export function Shell(props: ParentProps) {
  const office = useOffice()
  const connection = () => (office.status() === "online" ? "live" : office.ready() ? "reconnecting…" : "connecting…")
  return (
    <Show
      when={!office.blocked()}
      fallback={
        <main class="mx-auto max-w-lg p-8">
          <p role="alert">{BLOCKED[office.blocked()!]()}</p>
        </main>
      }
    >
      <div class="flex min-h-screen">
        <nav aria-label="HQ" class="flex w-56 shrink-0 flex-col border-r border-neutral-200 p-4 dark:border-neutral-800">
          <h1 class="text-lg font-semibold">{office.state.company?.name ?? "OpenCorp HQ"}</h1>
          <A
            href="/"
            end
            class="mt-4 block rounded px-2 py-1 aria-[current=page]:bg-neutral-100 dark:aria-[current=page]:bg-neutral-900"
          >
            Company
          </A>
          <div class="mt-auto space-y-1 pt-6 text-sm">
            <Show when={office.me()}>{(me) => <p>@{me()}</p>}</Show>
            <Show when={office.pairedBy()}>{(by) => <p class="text-neutral-500">paired by @{by()}</p>}</Show>
            <p role="status" aria-label="Connection">
              {connection()}
            </p>
          </div>
        </nav>
        <main class="min-w-0 flex-1">
          <Show when={!office.ready() && office.error()}>
            {(error) => (
              <p role="alert" class="bg-amber-100 px-4 py-2 text-sm dark:bg-amber-950">
                Couldn't read the office: {error()}. Retrying…
              </p>
            )}
          </Show>
          <Show when={office.ready() && office.status() !== "online"}>
            <p class="bg-amber-100 px-4 py-2 text-sm dark:bg-amber-950">Reconnecting to the office…</p>
          </Show>
          <ErrorBoundary fallback={<LoadFailed />}>{props.children}</ErrorBoundary>
        </main>
      </div>
    </Show>
  )
}
