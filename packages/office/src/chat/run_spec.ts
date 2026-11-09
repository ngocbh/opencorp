/** How the office starts a session's runs: the run specs of a main chat, a side chat and the profile manager, and
 *  the worker job built from one. */
import type { MemoryBase } from "@ngocbh/yian"
import { CompanyDefaults, type Person as PersonSchema } from "@opencorp/protocol"
import type { z } from "zod"
import type { CompanyGit } from "../company/git.ts"
import type { CompanyRepo } from "../company/loader.ts"
import type { Monitor } from "../perm/monitor.ts"
import { MANAGER_FLOW } from "../profile/manager.ts"
import { GitProfileStore } from "../profile/store.ts"
import type { Carried, OnQuestion } from "../questions/ask.ts"
import type { QuestionRecord, SessionRecord, Store } from "../store/store.ts"
import { build } from "../tools/index.ts"
import type { WorkspaceTools } from "../tools/workspace.ts"
import {
  type Delivery,
  groupSpecs,
  type Job,
  type Parent,
  parseJob,
  personFlow,
  type Seed,
} from "../worker/job.ts"
import type { OfficeTool } from "../worker/rpc.ts"
import { personInputs, talkingTo } from "./identity.ts"
import { HarnessError, notAnAgent } from "./state.ts"
import { type ChatFlow, MAIN_CHAT } from "./turns.ts"

const SIDE_CHAT_FLOW = "shared/flows/side_chat.yaml"
// Room in a side chat's history beyond its seed, so compaction doesn't fold the seed.
const SIDE_HISTORY_CHARS = 32000

type Person = z.output<typeof PersonSchema>
type Workspace = Pick<WorkspaceTools, "call" | "interrupt">

/** What a run's tool groups are built for: the session, the run, and how its tools ask questions. */
export interface GroupContext {
  readonly session: SessionRecord
  readonly runId: string
  readonly onQuestion?: OnQuestion
}

/**
 * How to start (and restart) a session's runs.
 *
 * `flow` is relative to the session's pinned commit. `chat` names the turn and reply nodes of the conversation
 * flow. `groups` builds the office tools of one run, `{group: {tool name: tool}}`. `memories` are the office memories
 * the worker binds to the flow's memory inputs of the same names, on every run call; history lives in the flow's
 * `summary` and `history` inputs, not in a memory. `names` are what the person answers to (handle, then name).
 * `workspace` is the workspace the run's workspace tools call, if it has one. `parent` is the run (and node) the
 * session's fresh runs nest under in yian's run index, if any. Python's `learnable` is dropped: learning is
 * deferred.
 */
export interface RunSpec {
  readonly flow: string
  readonly chat: ChatFlow
  readonly inputs: Record<string, unknown>
  groups(ctx: GroupContext): Record<string, Record<string, OfficeTool>>
  readonly memories: Record<string, MemoryBase>
  readonly skills: string[]
  readonly names: readonly string[]
  readonly workspace?: Workspace
  readonly parent?: Parent | null
}

/** The company defaults of `repo`; the schema's defaults without any. */
export function defaultsOf(repo: CompanyRepo): z.output<typeof CompanyDefaults> {
  return repo.company?.defaults ?? CompanyDefaults.parse({})
}

/** `session.person` in `repo`. Throws `HarnessError` (`422`) when the pinned commit has no such person. */
function personOf(repo: CompanyRepo, session: SessionRecord): Person {
  const person = repo.people.get(session.person)
  if (person === undefined) {
    const commit = session.repo_commit.slice(0, 12)
    throw new HarnessError(422, "not_found", `no person ${session.person} at commit ${commit}`)
  }
  return person
}

/** The flow's `profile` memory: `handle`'s memory folder in the company clone, whose settings are the same in every
 *  company, so every advance of a run binds the settings it recorded. */
function profileMemory(git: CompanyGit, handle: string): Record<string, MemoryBase> {
  return { profile: new GitProfileStore(git, handle).memory() }
}

/**
 * The run spec of a person's main chat, `repo` being the session's pinned commit.
 *
 * The person's main flow, who they are and who they're talking with, their profile as its `profile` memory, their
 * skills, and the toolbox, workspace and company groups. Throws `HarnessError` (`422`) when the person isn't in
 * `repo` or has no main flow.
 */
export function mainSpec({
  store,
  git,
  repo,
  session,
  workspace,
  monitor,
  carried,
}: {
  store: Store
  git: CompanyGit
  repo: CompanyRepo
  session: SessionRecord
  workspace: Workspace
  monitor: Monitor
  carried: Carried
}): RunSpec {
  const person = personOf(repo, session)
  if (!person.main) throw notAnAgent()
  const defaults = defaultsOf(repo)
  return {
    flow: personFlow(person.handle, person.main),
    chat: MAIN_CHAT,
    inputs: {
      person: personInputs(repo, person),
      talking_to: talkingTo(repo, person, session.opened_by),
      max_turns: defaults.max_turns,
    },
    groups: ({ session, runId, onQuestion }) => {
      const ctx = { store, repo, session, runId, onQuestion, carried, monitor, workspace }
      return build(["toolbox", "workspace", "company"], ctx)
    },
    memories: profileMemory(git, person.handle),
    skills: [...person.skills],
    names: [person.handle, person.name],
    workspace,
  }
}

/**
 * The run spec of a side chat about `question`, `repo` being the session's pinned commit.
 *
 * The side chat flow, who the asker is and who they're talking with, their profile as its `profile` memory, and
 * read-only lookups: the workspace's read tools and the work items. The caller passes a `workspace` built read-only
 * and offline whatever the person's `harness_policy` says: a side chat explains, it doesn't act. Its history budget
 * leaves room for the seed, the first turn. Its runs nest under the question's run and node; with no question, under
 * none. Throws `HarnessError` (`422`) when the asker isn't in `repo`.
 */
export function sideSpec({
  store,
  git,
  repo,
  session,
  workspace,
  monitor,
  question,
}: {
  store: Store
  git: CompanyGit
  repo: CompanyRepo
  session: SessionRecord
  workspace: Workspace
  monitor: Monitor
  question: QuestionRecord | undefined
}): RunSpec {
  const person = personOf(repo, session)
  const defaults = defaultsOf(repo)
  return {
    flow: SIDE_CHAT_FLOW,
    chat: MAIN_CHAT,
    inputs: {
      person: personInputs(repo, person),
      talking_to: talkingTo(repo, person, session.opened_by),
      max_turns: defaults.max_turns,
      history_budget: defaults.side_seed_max_chars + SIDE_HISTORY_CHARS,
    },
    groups: ({ session, runId }) =>
      build(["workspace", "work_items"], { store, session, runId, monitor, workspace, readOnly: true, question }),
    memories: profileMemory(git, person.handle),
    skills: [],
    names: [person.handle, person.name],
    workspace,
    parent: question === undefined ? null : { run_id: question.run_id, node: question.node_id },
  }
}

/**
 * The run spec of a profile-manager session, `repo` being the session's pinned commit.
 *
 * Its only group is `profile`, the given profile tools, which already carry the person whose profile they edit and
 * the session. It has no memory: it edits the profile rather than learning from it.
 */
export function managerSpec({
  repo,
  tools,
}: {
  repo: CompanyRepo
  tools: Record<string, OfficeTool>
}): RunSpec {
  return {
    flow: MANAGER_FLOW,
    chat: MAIN_CHAT,
    inputs: { max_turns: defaultsOf(repo).max_turns },
    groups: () => ({ profile: tools }),
    memories: {},
    skills: [],
    names: [],
  }
}

/**
 * The worker job that runs `spec` for `session` as run `runId`, its office tools being `tools` (what
 * `spec.groups` built for this run).
 *
 * A new chat starts with an empty history at `turns`, the session's turns so far; with a `seed` (the run it
 * replaces) the worker replaces the empty `summary` and `history` with that run's. Only a `chat` job carries
 * `spec.parent`: an `advance` resumes a log that already records it. Every job names `spec.memories`, which the
 * worker binds on every run call. With `keep`, the worker stays parked after a run call that leaves the run waiting,
 * for the run's next job. Throws `JobError`, whose message holds no value, when a field is invalid.
 */
export function chatJob(
  spec: RunSpec,
  tools: Record<string, Record<string, OfficeTool>>,
  {
    kind,
    session,
    runId,
    pin,
    log,
    llmConfig,
    turns,
    seed = null,
    deliver = [],
    advance = true,
    keep = false,
  }: {
    kind: "chat" | "advance"
    session: SessionRecord
    runId: string
    pin: string
    log: string
    llmConfig: Record<string, unknown> | null
    turns: number
    seed?: Seed | null
    deliver?: Delivery[]
    advance?: boolean
    keep?: boolean
  },
): Job {
  return parseJob({
    kind,
    session_id: session.id,
    run_id: runId,
    person: session.person,
    pin,
    flow: spec.flow,
    log,
    inputs: { ...spec.inputs, summary: "", history: [], turns },
    llm_config: llmConfig,
    skills: spec.skills,
    groups: groupSpecs(tools),
    memory: Object.keys(spec.memories),
    seed,
    deliver,
    advance,
    parent: kind === "chat" ? (spec.parent ?? null) : null,
    keep,
  })
}
