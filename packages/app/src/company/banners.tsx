import type { Person, RepoIssue } from "@opencorp/protocol"
import { For, Show } from "solid-js"

const ALERT = "rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950"

/** What's wrong with the company repo at the commit HQ shows. */
export function Banners(props: { noCompany: boolean; ceoHasManager: boolean; issues: RepoIssue[] }) {
  return (
    <div class="space-y-2 px-3 pt-3 empty:hidden">
      <Show when={props.noCompany}>
        <p role="alert" class={ALERT}>
          company.yaml is missing or doesn't parse at the last commit, so there's no CEO: everyone without a manager is
          at the top. `opencorp doctor` says more.
        </p>
      </Show>
      <Show when={props.ceoHasManager}>
        <p role="alert" class={ALERT}>
          The CEO has a manager (company.ceo_has_manager): the CEO stays at the top and that line isn't drawn. Fix the
          CEO's person.yaml; `opencorp doctor` says more.
        </p>
      </Show>
      <For each={props.issues}>
        {(issue) => (
          <p role="alert" class={ALERT}>
            <code>{issue.path}</code>: {issue.message}
          </p>
        )}
      </For>
    </div>
  )
}

/** People whose managers never reach the top: an unknown manager or a cycle. */
export function Unplaced(props: { people: Person[]; onSelect: (handle: string) => void }) {
  return (
    <Show when={props.people.length}>
      <section aria-label="Unplaced" class="m-3 rounded border border-neutral-200 p-3 dark:border-neutral-800">
        <h2 class="font-medium">Unplaced</h2>
        <ul class="mt-1 text-sm">
          <For each={props.people}>
            {(p) => (
              <li>
                <button type="button" class="underline" onClick={() => props.onSelect(p.handle)}>
                  {p.name}
                </button>{" "}
                <span class="text-neutral-500 dark:text-neutral-400">@{p.handle}</span>
              </li>
            )}
          </For>
        </ul>
        <p class="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          `opencorp doctor` names unknown managers and cycles. It checks the working tree, while HQ shows the last
          commit, so they differ until edits are committed.
        </p>
      </section>
    </Show>
  )
}
