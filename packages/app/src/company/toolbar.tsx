/** The company view's controls: the company's name and the search box. */
export function Toolbar(props: { company: string; query: string; onQuery: (q: string) => void }) {
  return (
    <div class="flex flex-wrap items-center gap-3 border-b border-neutral-200 p-3 dark:border-neutral-800">
      <h2 class="mr-auto text-base font-semibold">{props.company}</h2>
      <input
        type="search"
        aria-label="Search people"
        placeholder="Search people"
        value={props.query}
        onInput={(e) => props.onQuery(e.currentTarget.value)}
        class="w-48 rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
      />
    </div>
  )
}
