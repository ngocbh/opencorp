/**
 * One node attempt's view for Run Logs, read with yian's `nodeView`: each input as the node bound it and what its
 * success accepted, with their types. Yian's values become the protocol's here: in the display form an opened record
 * shows, fitted as one opened record is. `nodeView` replays the log up to the attempt's end, which takes seconds on a
 * long run, so the office reads views on the viewer thread (`view_thread.ts`, hosted by `replays.ts`).
 */
import { type NodeValue, nodeView } from "@ngocbh/yian/run"
import type { RunNodeValue, RunNodeView } from "@opencorp/protocol"
import { displayed, fitValues, LINE_CAP, TOO_LARGE } from "./reader.ts"

/** What one view reads: node `nodeId`'s start `attempt` (counting its starts from 1) in the log `log`; for a flow call
 *  or a loop, the attempt whose outputs are its (its END's, or its last turn's driver's), else null; and the folder the
 *  recorded flow's CODE must stay inside (null for the one the run recorded). */
export interface ViewJob {
  log: string
  nodeId: string
  attempt: number
  ender: { nodeId: string; attempt: number } | null
  codeRoot: string | null
}

/** The run's environment: the office runs flows with no `YIAN_*` values. */
const env = () => undefined

/** `job`'s view: one `nodeView`, and one more of its ender for a flow call's or a loop's outputs. Throws what
 *  `nodeView` throws: a log of another schema, no such attempt, a flow built in code. */
export async function readView(job: ViewJob): Promise<RunNodeView> {
  const options = { env, codeRoot: job.codeRoot, maxLineBytes: LINE_CAP }
  const view = await nodeView(job.log, job.nodeId, job.attempt, options)
  const outputs = job.ender === null
    ? view.outputs
    : (await nodeView(job.log, job.ender.nodeId, job.ender.attempt, options)).outputs
  const inputs = (view.inputs ?? []).map(wire)
  const fitted = fitValues([...inputs, ...outputs.map(wire)])
  return {
    kind: view.kind,
    inputs: view.inputs === null ? null : fitted.slice(0, inputs.length),
    outputs: fitted.slice(inputs.length),
    missing: view.missing,
  }
}

/** A value of the view in the protocol's words. */
function wire(value: NodeValue): RunNodeValue {
  const row = { name: value.name, seq: null, type: value.type, missing: value.missing, size: null }
  const shown = displayed(value.value)
  // So deep that its cuts can't be named: as a record too large to show is.
  if (shown === null) return { ...row, value: null, missing: TOO_LARGE, cut: [] }
  return { ...row, value: shown.value, cut: shown.cut }
}
