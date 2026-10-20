import { A } from "@solidjs/router"
import {
  createContext,
  createSignal,
  createUniqueId,
  ErrorBoundary,
  For,
  onMount,
  Show,
  useContext,
  type ParentProps,
} from "solid-js"
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

/** What a page can ask of the shell. */
type ShellApi = {
  /** Whether a full-screen sheet covers the sidebar, which then can't take focus. */
  setCovered: (covered: boolean) => void
}
const ShellContext = createContext<ShellApi>()

/** The shell around the page, if there is one. */
export const useShell = () => useContext(ShellContext)

/** A page HQ doesn't have yet: its name, and what it will be (with its issue, when there is one). */
type Soon = { label: string; about: string }

const INBOX: Soon = { label: "Inbox", about: "What needs you. Not built yet." }
const WORK: Soon[] = [
  { label: "Issues", about: "Work items and their status. Not built yet: #238." },
  { label: "Goals", about: "Company, team and personal goals. Not built yet: #239." },
  { label: "Routines", about: "Scheduled SOPs. Not built yet." },
]
const COMPANY: Soon[] = [
  { label: "SOPs", about: "The company's Yian flows. Not built yet." },
  { label: "Connections", about: "Model providers. Not built yet." },
  { label: "Activity", about: "The audit feed. Not built yet." },
]

// One row shape for every item, so a soon item lines up with the links around it.
const ROW = "mx-2 flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] font-medium"

/** A sidebar section: a heading that labels its group of items. */
function Section(props: ParentProps<{ label: string }>) {
  const id = createUniqueId()
  return (
    <div role="group" aria-labelledby={id}>
      <h2 id={id} class="px-3 py-1.5 font-mono text-[10px] font-medium tracking-widest text-neutral-500 uppercase">
        {props.label}
      </h2>
      <ul class="mt-0.5 flex flex-col gap-0.5">{props.children}</ul>
    </div>
  )
}

/** A page HQ has: a link, highlighted while it's the current page. */
function Item(props: { href: string; label: string; onClick?: () => void }) {
  return (
    <li>
      <A
        href={props.href}
        onClick={() => props.onClick?.()}
        class={`${ROW} text-neutral-700 outline-none hover:bg-neutral-100 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-neutral-900 aria-[current=page]:bg-neutral-200/70 aria-[current=page]:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-900 dark:hover:text-neutral-50 dark:focus-visible:ring-neutral-100 dark:aria-[current=page]:bg-neutral-800 dark:aria-[current=page]:text-neutral-50`}
      >
        <span class="min-w-0 flex-1 truncate">{props.label}</span>
      </A>
    </li>
  )
}

/**
 * A page HQ doesn't have yet: greyed out with a "soon" badge, announced as an unavailable link (no address, no tab
 * stop), and described by what it will be.
 */
function SoonItem(props: { soon: Soon }) {
  const id = createUniqueId()
  return (
    <li>
      <span
        role="link"
        aria-disabled="true"
        aria-describedby={id}
        title={props.soon.about}
        class={`${ROW} cursor-default text-neutral-400 dark:text-neutral-600`}
      >
        <span class="min-w-0 flex-1 truncate">{props.soon.label}</span>
        <span class="ml-auto rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] leading-none text-neutral-500 dark:bg-neutral-900">
          soon
        </span>
      </span>
      {/* Outside the link, so it describes the item without becoming part of its name. */}
      <span id={id} class="sr-only">
        {props.soon.about}
      </span>
    </li>
  )
}

/**
 * The sidebar (the company and its connection, the pages by section, who is signed in and Sign out) and the main
 * area.
 */
export function Shell(props: ParentProps) {
  const office = useOffice()
  const [covered, setCovered] = createSignal(false)
  const live = () => office.status() === "online"
  const connection = () => (live() ? "live" : office.ready() ? "reconnecting…" : "connecting…")
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
        <nav
          aria-label="HQ"
          inert={covered()}
          class="flex w-56 shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-800"
        >
          <div class="flex flex-col gap-1 px-5 pt-4 pb-2">
            <h1 class="truncate text-base font-semibold">{office.state.company?.name ?? "OpenCorp HQ"}</h1>
            <p role="status" aria-label="Connection" class="flex items-center gap-1.5 text-xs text-neutral-500">
              <span
                aria-hidden="true"
                class="size-2 rounded-full"
                classList={{ "bg-emerald-500": live(), "bg-amber-500": !live() }}
              />
              {connection()}
            </p>
          </div>
          <div class="flex flex-1 flex-col gap-4 overflow-y-auto px-1 py-2">
            <ul class="flex flex-col gap-0.5">
              <SoonItem soon={INBOX} />
            </ul>
            <Section label="Work">
              <For each={WORK}>{(soon) => <SoonItem soon={soon} />}</For>
            </Section>
            <Section label="Company">
              <Item href="/org" label="Org" />
              <For each={COMPANY}>{(soon) => <SoonItem soon={soon} />}</For>
            </Section>
          </div>
          <div class="space-y-1 border-t border-neutral-200 px-5 py-3 text-sm dark:border-neutral-800">
            <Show when={office.me()}>{(me) => <p>@{me()}</p>}</Show>
            <Show when={office.pairedBy()}>{(by) => <p class="text-neutral-500">paired by @{by()}</p>}</Show>
            <button
              type="button"
              disabled={office.signingOut()}
              onClick={() => void office.signOut()}
              class="-mx-2 block rounded px-2 py-1 text-left outline-none hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-neutral-900 disabled:opacity-60 dark:hover:bg-neutral-900 dark:focus-visible:ring-neutral-100"
            >
              {office.signingOut() ? "Signing out…" : "Sign out"}
            </button>
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
          <ShellContext.Provider value={{ setCovered }}>
            <ErrorBoundary fallback={<LoadFailed />}>{props.children}</ErrorBoundary>
          </ShellContext.Provider>
        </main>
      </div>
    </Show>
  )
}
