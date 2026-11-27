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

/** One replay: a node view; model call `n` of agent node `node`; or record `seq`, rebuilt when it is derived. A call
 *  and a record read a log of at most `maxBytes`; `codeRoot` is where the recorded flow's CODE must stay (null for the
 *  folder the run recorded). */
export type ReplayJob =
  | ({ kind: "view" } & ViewJob)
  | { kind: "call"; log: string; node: string; n: number; codeRoot: string | null; maxBytes: number }
  | { kind: "record"; log: string; seq: number; codeRoot: string; maxBytes: number }

/** What a replay gives: a view, a call, or a record (null for no such record). */
export type Replayed = RunNodeView | RunCall | RunEvent | null

/** The log grew past a call's `maxBytes` while the call waited for the replays before it. */
export class LogGrew extends Error {
  override name = "LogGrew"
}

/** The run's environment: the office runs flows with no `YIAN_*` values. */
const env = () => undefined

/** `job`, replayed. Throws what yian throws (a log of another schema, a flow it can't rebuild), and LogGrew. */
export async function replay(job: ReplayJob): Promise<Replayed> {
  switch (job.kind) {
    case "view":
      return readView(job)
    case "call":
      if (fs.statSync(job.log).size > job.maxBytes) throw new LogGrew("the log grew past the limit")
      return readCall(job.log, job.node, job.n, { env, codeRoot: job.codeRoot })
    case "record":
      return rebuiltEvent(job.log, job.seq, { env, codeRoot: job.codeRoot }, job.maxBytes)
  }
}
