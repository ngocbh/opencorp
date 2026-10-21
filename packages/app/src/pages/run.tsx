import { useParams } from "@solidjs/router"
import { Show } from "solid-js"
import { RunPage } from "../runs/run"

/** Work › Run Logs › one run: a fresh page for each run id, so nothing of the last run carries over. */
export default function Run() {
  const params = useParams()
  return (
    <Show keyed when={params.id}>
      {(id) => <RunPage id={id} />}
    </Show>
  )
}
