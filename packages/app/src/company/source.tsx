import { isBadPath, isNoFile, isStaleCommit } from "@opencorp/client"
import type { CompanyFile, CompanyTree } from "@opencorp/protocol"
import { useNavigate } from "@solidjs/router"
import Check from "lucide-solid/icons/check"
import ChevronRight from "lucide-solid/icons/chevron-right"
import Copy from "lucide-solid/icons/copy"
import FileIcon from "lucide-solid/icons/file"
import FileSymlink from "lucide-solid/icons/file-symlink"
import Folder from "lucide-solid/icons/folder"
import FolderGit from "lucide-solid/icons/folder-git"
import {
  batch,
  createEffect,
  createMemo,
  createSelector,
  createSignal,
  For,
  Index,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { useOffice } from "../data/office"
import { sourceHref } from "./address"
import { ancestors, buildFiles, crumbs, lines, nearestFolder, noteOf, typeOf, type Entry, type EntryType } from "./files"
import { ago } from "./format"
import { moveFocus, visibleRows } from "./rows"

const MUTED = "text-neutral-500 dark:text-neutral-400"
const RING = "outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:focus-visible:ring-neutral-100"
const ICONS: Record<EntryType, typeof FileIcon> = { folder: Folder, file: FileIcon, symlink: FileSymlink, submodule: FolderGit }

/** An error's message, for a pane that says what failed. */
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** An entry's icon; Lucide marks it aria-hidden. */
function EntryIcon(props: { type: EntryType }) {
  const Icon = () => ICONS[props.type]
  return (
    <span class={`shrink-0 ${MUTED}`}>
      {Icon()({ size: 16, class: "h-4 w-4" })}
    </span>
  )
}

/**
 * The folder tree: the WAI-ARIA tree pattern with flat treeitems and a roving tabindex, as the company list has. Arrow
 * keys, Home and End move focus and open or close folders; a click or Enter opens an entry.
 */
function FileTree(props: {
  roots: Entry[]
  path: string
  isOpen: (e: Entry) => boolean
  setOpen: (id: string, open: boolean) => void
  onOpen: (path: string) => void
}) {
  const rows = createMemo(() => visibleRows(props.roots, props.isOpen))
  const ids = createMemo(() => rows().map((r) => r.item.id))
  const byId = createMemo(() => new Map(rows().map((r) => [r.item.id, r])))
  const [focused, setFocused] = createSignal<string>()
  /** The row with tabindex 0: the focused one while it's visible, else the open entry's, else the first. */
  const current = () => [focused(), props.path].find((id) => id !== undefined && byId().has(id)) ?? ids()[0]
  const isCurrent = createSelector(current)
  const isSelected = createSelector(() => props.path)
  const elements = new Map<string, HTMLElement>()
  function onKey(e: KeyboardEvent, id: string) {
    if (e.key === "Enter") {
      e.preventDefault()
      return props.onOpen(id)
    }
    const move = moveFocus(rows(), id, e.key)
    if (!move) return
    e.preventDefault()
    if ("open" in move) return props.setOpen(move.open, move.to)
    setFocused(move.focus)
    elements.get(move.focus)?.focus()
  }
  return (
    <ul role="tree" aria-label="Files" class="p-2 text-sm">
      <For each={ids()}>
        {(id) => (
          <Show when={byId().get(id)}>
            {(row) => {
              const branch = () => row().item.children.length > 0
              return (
                <li
                  role="treeitem"
                  aria-label={row().item.name}
                  aria-level={row().level}
                  aria-setsize={row().setsize}
                  aria-posinset={row().posinset}
                  aria-expanded={branch() ? row().open : undefined}
                  aria-selected={isSelected(id)}
                  tabindex={isCurrent(id) ? 0 : -1}
                  class="flex cursor-default items-center gap-1.5 rounded py-1 pr-2 pl-1 outline-none hover:bg-neutral-50 focus-visible:ring-2 aria-selected:bg-neutral-100 dark:hover:bg-neutral-900/60 dark:aria-selected:bg-neutral-900"
                  ref={(el) => {
                    elements.set(id, el)
                    onCleanup(() => elements.delete(id))
                  }}
                  onFocus={() => setFocused(id)}
                  onKeyDown={(e) => onKey(e, id)}
                  onClick={() => props.onOpen(id)}
                >
                  {/* Indentation as spacers: the CSP allows no inline styles. */}
                  <Index each={Array.from({ length: row().level - 1 })}>
                    {() => <span aria-hidden="true" class="w-3 shrink-0" />}
                  </Index>
                  <Show when={branch()} fallback={<span aria-hidden="true" class="w-5 shrink-0" />}>
                    <span
                      aria-hidden="true"
                      data-testid="toggle"
                      class={`-my-1 grid h-6 w-5 shrink-0 cursor-pointer place-items-center ${MUTED}`}
                      onClick={(e) => {
                        e.stopPropagation() // toggling isn't opening
                        props.setOpen(id, !row().open)
                      }}
                    >
                      <ChevronRight size={14} class="h-3.5 w-3.5 transition-transform" classList={{ "rotate-90": row().open }} />
                    </span>
                  </Show>
                  <EntryIcon type={row().item.type} />
                  <span class="min-w-0 truncate">{row().item.name}</span>
                </li>
              )
            }}
          </Show>
        )}
      </For>
    </ul>
  )
}

/** Copies `text` and says so for a moment. */
function CopyButton(props: { text: string }) {
  const [state, setState] = createSignal<"idle" | "copied" | "failed">("idle")
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  async function copy() {
    try {
      await navigator.clipboard.writeText(props.text)
      setState("copied")
    } catch {
      setState("failed")
    }
    clearTimeout(timer)
    timer = setTimeout(() => setState("idle"), 2_000)
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      class={`flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800 ${RING}`}
    >
      <Show when={state() === "copied"} fallback={<Copy size={14} class="h-3.5 w-3.5" />}>
        <Check size={14} class="h-3.5 w-3.5" />
      </Show>
      {state() === "copied" ? "Copied" : state() === "failed" ? "Couldn't copy" : "Copy"}
    </button>
  )
}

/** A text file: line numbers, wrapped lines, and Copy. Text renders as text nodes only. */
function Code(props: { text: string }) {
  const all = createMemo(() => lines(props.text))
  return (
    <div class="overflow-hidden rounded border border-neutral-200 dark:border-neutral-800">
      <div class={`flex items-center justify-between border-b border-neutral-200 px-3 py-1 text-xs dark:border-neutral-800 ${MUTED}`}>
        <span>
          {all().length} {all().length === 1 ? "line" : "lines"}
        </span>
        <CopyButton text={props.text} />
      </div>
      <div class="py-2 font-mono text-[13px] leading-5">
        <Index each={all()}>
          {(line, i) => (
            <div class="flex">
              <span
                data-testid="line-number"
                aria-hidden="true"
                class="w-12 shrink-0 pr-3 text-right text-neutral-400 select-none dark:text-neutral-600"
              >
                {i + 1}
              </span>
              <span data-testid="line-text" class="min-h-5 min-w-0 flex-1 pr-3 whitespace-pre-wrap wrap-anywhere">
                {line()}
              </span>
            </div>
          )}
        </Index>
      </div>
    </div>
  )
}

/** A plain message in the pane, with Retry: a failed read never leaves the pane blank. */
function Failed(props: { text: string; onRetry: () => void }) {
  return (
    <div role="alert" class="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950">
      <p>{props.text}</p>
      <button
        type="button"
        onClick={() => props.onRetry()}
        class={`rounded border border-neutral-300 px-2 py-1 hover:bg-white dark:border-neutral-700 dark:hover:bg-neutral-900 ${RING}`}
      >
        Retry
      </button>
    </div>
  )
}

/** A file read's outcome for one path. */
type Read = { path: string; file?: CompanyFile; error?: unknown }

/**
 * The company repo's files, read-only, at the commit HQ serves: the folder tree beside the open entry on a desktop,
 * one pane with a breadcrumb on a phone. Follows the store's commit: a new one reads the tree, then the open file.
 */
export function Source(props: { company: string; path: string; desktop: boolean }) {
  const office = useOffice()
  const navigate = useNavigate()
  const open = (path: string) => navigate(sourceHref(path))
  const [tree, setTree] = createSignal<CompanyTree>()
  const [treeError, setTreeError] = createSignal<string>()
  const [read, setRead] = createSignal<Read>()
  const types = createMemo(() => new Map(tree()?.entries.map((e) => [e.path, e.type])))
  const roots = createMemo(() => buildFiles(tree()?.entries ?? []))
  /** Each folder's entries, by the folder's path. */
  const folders = createMemo(() => {
    const m = new Map<string, Entry[]>([["", roots()]])
    const walk = (list: Entry[]) => list.forEach((e) => e.type === "folder" && (m.set(e.id, e.children), walk(e.children)))
    walk(roots())
    return m
  })
  const isFolder = (path: string) => typeOf(types(), path) === "folder"

  let treeAsk = 0
  /** Reads the tree; only the latest read's answer is kept, and a read that was overtaken gives undefined. */
  async function readTree(): Promise<CompanyTree | undefined> {
    const ask = ++treeAsk
    try {
      const t = await office.client.company.tree()
      if (ask !== treeAsk) return undefined
      batch(() => {
        setTree(t)
        setTreeError(undefined)
      })
      return t
    } catch (error) {
      if (ask === treeAsk) setTreeError(messageOf(error))
      return undefined
    }
  }

  let fileAsk = 0
  /**
   * Reads the open path at the tree's commit, unless it's a folder the tree lists. A 409 means the office no longer
   * serves that commit: the tree is read again once, and the file at its commit.
   */
  async function readFile(retried = false) {
    const ask = ++fileAsk
    const t = untrack(tree)
    const path = untrack(() => props.path)
    if (!t || untrack(() => isFolder(path))) return
    try {
      const file = await office.client.company.file(t.commit.id, path)
      if (ask === fileAsk) setRead({ path, file })
    } catch (error) {
      if (ask !== fileAsk) return
      if (isStaleCommit(error) && !retried && (await readTree()) && ask === fileAsk) return readFile(true)
      if (ask === fileAsk) setRead({ path, error })
    }
  }
  const reload = () => void readTree().then((t) => t && readFile())

  // The store's commit, not the event: company.updated, a reconnect's snapshot and a tab coming back all move it.
  createEffect(
    on(
      () => office.state.sha,
      (sha) => {
        if (!tree() || sha !== tree()!.commit.id) reload()
      },
    ),
  )
  createEffect(on(() => props.path, () => void readFile(), { defer: true }))

  // Open folders live as long as the page; the open path's folders open as it changes.
  const [openMap, setOpenMap] = createSignal<Record<string, boolean>>({})
  createEffect(
    on(
      () => props.path,
      (path) => {
        const shown = path ? [...ancestors(path), path] : []
        setOpenMap((m) => ({ ...m, ...Object.fromEntries(shown.map((p) => [p, true])) }))
      },
    ),
  )
  const setOpen = (id: string, value: boolean) => setOpenMap((m) => ({ ...m, [id]: value }))

  // The commit's age, kept current.
  const [now, setNow] = createSignal(Date.now())
  const clock = setInterval(() => setNow(Date.now()), 60_000)
  onCleanup(() => clearInterval(clock))

  /** The open path's read, once it's for that path. */
  const current = () => (read()?.path === props.path ? read() : undefined)

  return (
    <div>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800">
        <Show when={tree()?.commit}>
          {(c) => (
            <p data-testid="commit" class="min-w-0">
              <code class="rounded bg-neutral-100 px-1 font-mono text-xs dark:bg-neutral-800">{c().id.slice(0, 7)}</code>{" "}
              {c().subject} · {c().author} ·{" "}
              <time datetime={c().time} title={c().time}>
                {ago(c().time, now())}
              </time>
            </p>
          )}
        </Show>
        <Show when={tree()?.truncated}>
          <p class={MUTED}>Only the first {tree()!.entries.length.toLocaleString("en")} entries are listed.</p>
        </Show>
        <Show when={tree()?.skipped}>
          {(n) => (
            <p class={MUTED}>
              {n()} {n() === 1 ? "path isn't" : "paths aren't"} listed.
            </p>
          )}
        </Show>
      </div>
      <div class="flex">
        <Show when={props.desktop && tree()}>
          <div class="sticky top-0 max-h-screen w-64 shrink-0 self-start overflow-y-auto border-r border-neutral-200 dark:border-neutral-800">
            <FileTree roots={roots()} path={props.path} isOpen={(e) => !!openMap()[e.id]} setOpen={setOpen} onOpen={open} />
          </div>
        </Show>
        <section data-testid="source-pane" aria-label={props.path || props.company} class="min-w-0 flex-1 space-y-3 p-3">
          <nav aria-label="Breadcrumb" class="text-sm">
            <ol class="flex flex-wrap items-center">
              <For each={[{ path: "", name: props.company }, ...crumbs(props.path)]}>
                {(c) => (
                  <li class="min-w-0 before:px-1.5 before:text-neutral-400 before:content-['/'] first:before:content-none">
                    <Show
                      when={c.path !== props.path}
                      fallback={
                        <span aria-current="page" class="font-semibold">
                          {c.name}
                        </span>
                      }
                    >
                      <a href={sourceHref(c.path)} class={`rounded underline-offset-2 hover:underline ${RING}`}>
                        {c.name}
                      </a>
                    </Show>
                  </li>
                )}
              </For>
            </ol>
          </nav>
          <Switch fallback={<p aria-busy="true" class={`text-sm ${MUTED}`}>Loading…</p>}>
            <Match when={treeError()}>
              {(error) => <Failed text={`Couldn't read the company repo's files: ${error()}.`} onRetry={reload} />}
            </Match>
            <Match when={tree() && isFolder(props.path)}>
              <ul aria-label="Entries" class="divide-y divide-neutral-200 rounded border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
                <For each={folders().get(props.path)} fallback={<li class={`px-3 py-2 text-sm ${MUTED}`}>This folder is empty.</li>}>
                  {(e) => (
                    <li>
                      <a
                        href={sourceHref(e.id)}
                        class={`flex items-center gap-2 px-3 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900 ${RING}`}
                      >
                        <EntryIcon type={e.type} />
                        <span class="min-w-0 truncate">{e.name}</span>
                      </a>
                    </li>
                  )}
                </For>
              </ul>
            </Match>
            <Match when={current()?.error}>
              {(error) => (
                <Switch fallback={<Failed text={`Couldn't read ${props.path}: ${messageOf(error())}.`} onRetry={() => void readFile()} />}>
                  <Match when={isNoFile(error())}>
                    <p data-testid="gone" class="text-sm">
                      {props.path} isn't in the latest commit.{" "}
                      <a href={sourceHref(nearestFolder(props.path, isFolder))} class={`rounded underline ${RING}`}>
                        Open {nearestFolder(props.path, isFolder) || props.company}
                      </a>
                      .
                    </p>
                  </Match>
                  <Match when={isBadPath(error())}>
                    <p class="text-sm">
                      {props.path} isn't a path in the company repo.{" "}
                      <a href={sourceHref("")} class={`rounded underline ${RING}`}>
                        Open {props.company}
                      </a>
                      .
                    </p>
                  </Match>
                </Switch>
              )}
            </Match>
            <Match when={current()?.file}>
              {(file) => (
                <>
                  <Show when={noteOf(file())}>
                    {(text) => (
                      <p role="note" class="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-900">
                        {text()}
                      </p>
                    )}
                  </Show>
                  <Show when={file().content === "text" ? file().text : undefined}>{(text) => <Code text={text()} />}</Show>
                </>
              )}
            </Match>
          </Switch>
        </section>
      </div>
    </div>
  )
}
