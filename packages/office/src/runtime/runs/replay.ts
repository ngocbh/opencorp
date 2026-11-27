/**
 * What Run Logs reads by replaying a log, which the office does only on the viewer thread (`view_thread.ts`): a node
 * attempt's view (`view.ts`), a model call rebuilt (`calls.ts`), and a derived commit with the value it accepted
 * (`reader.ts`). Each takes seconds late in a long run.
 */
import fs from "node:fs"
import type { RunCall, RunEvent, RunNodeView } from "@opencorp/protocol"
import { readCall } from "./calls.ts"
import { rebuiltEvent } from "./reader.ts"
import { readView, type ViewJob } from "./view.ts"

/** One replay: a node view; model call `n` of agent node `node`; or record `seq`, rebuilt when it is derived. Each
 *  reads a log of at most `maxBytes`; `codeRoot` is where the recorded flow's CODE must stay (null for the folder the
 *  run recorded). */
export type ReplayJob =
  | ({ kind: "view"; maxBytes: number } & ViewJob)
  | { kind: "call"; log: string; node: string; n: number; codeRoot: string | null; maxBytes: number }
  | { kind: "record"; log: string; seq: number; codeRoot: string; maxBytes: number }

/** What a replay gives: a view, a call, or a record (null for no such record). */
export type Replayed = RunNodeView | RunCall | RunEvent | null

/** The log grew past a view's or a call's `maxBytes` while it waited for the replays before it. */
export class LogGrew extends Error {
  override name = "LogGrew"
}

/** The run's environment: the office runs flows with no `YIAN_*` values. */
const env = () => undefined

/** Throws LogGrew when the log is now over `maxBytes`: a replay holds it all in memory. */
function checkSize(log: string, maxBytes: number): void {
  if (fs.statSync(log).size > maxBytes) throw new LogGrew("the log grew past the limit")
}

/** `job`, replayed. Throws what yian throws (a log of another schema, a flow it can't rebuild), and LogGrew; a record
 *  of a log over the limit is as written. */
export async function replay(job: ReplayJob): Promise<Replayed> {
  switch (job.kind) {
    case "view":
      checkSize(job.log, job.maxBytes)
      return readView(job)
    case "call":
      checkSize(job.log, job.maxBytes)
      return readCall(job.log, job.node, job.n, { env, codeRoot: job.codeRoot })
    case "record":
      return rebuiltEvent(job.log, job.seq, { env, codeRoot: job.codeRoot }, job.maxBytes)
  }
}
