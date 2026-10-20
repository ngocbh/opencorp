import { A } from "@solidjs/router"
import { Show, type ParentProps } from "solid-js"
import { useOffice } from "./data/office"

/** The sidebar (company, screens, who is signed in, the connection) and the main area. */
export function Shell(props: ParentProps) {
  const office = useOffice()
  const connection = () => (office.status() === "online" ? "live" : office.ready() ? "reconnecting…" : "connecting…")
  return (
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
      <main class="min-w-0 flex-1">{props.children}</main>
    </div>
  )
}
