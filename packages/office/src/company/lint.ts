/** Check a loaded company repo for problems the schema can't express. */
import fs from "node:fs"
import path from "node:path"
import { type ComposedFlow, LoadError } from "@ngocbh/yian"
import { loadSkillDir, type Skill, SkillError } from "@ngocbh/yian/skills"
import { MAIN_CHAT } from "../chat/turns.ts"
import { errno, FlowOutsideRepo, loadConfined, outsideRoot, resolvePath } from "./flows.ts"
import { type RepoIssue, repoIssue } from "./issues.ts"
import { type CompanyRepo, profilePath } from "./loader.ts"
import { shownAssetToolName, TOOL_NAME } from "./naming.ts"

/** One lint check: the issues it finds in a repo. */
type Check = (repo: CompanyRepo) => Iterable<RepoIssue> | AsyncIterable<RepoIssue>

/** Returns load errors plus every lint finding, errors and warnings. */
export async function lint(repo: CompanyRepo): Promise<RepoIssue[]> {
  const issues = [...repo.errors]
  for (const check of CHECKS) {
    for await (const issue of check(repo)) issues.push(issue)
  }
  return issues
}

/** Whether `p` is a file; false for a path that doesn't exist or can't be one, as Python's `Path.is_file`. */
function isFile(p: string): boolean {
  return statOrNull(p)?.isFile() ?? false
}

/** Whether `p` is a directory; false for a path that doesn't exist or can't be one, as `Path.is_dir`. */
function isDir(p: string): boolean {
  return statOrNull(p)?.isDirectory() ?? false
}

/** `p`'s stat, or null for a path that doesn't exist or can't be one; other errors are thrown. */
function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p)
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EBADF", "ELOOP"].includes(errno(error) ?? "")) return null
    throw error
  }
}

/** `items`' entries sorted by key, as Python's `sorted(d.items())`. */
function sorted<T>(items: ReadonlyMap<string, T>): [string, T][] {
  return [...items].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/** The repo path of a person's `person.yaml`. */
function personPath(handle: string): string {
  return `people/${handle}/person.yaml`
}

/** Each cycle in a child → parent map once, as its ids in child → parent order starting from the smallest. */
function cycles(links: ReadonlyMap<string, string | null>): string[][] {
  const seen = new Set<string>()
  const found: string[][] = []
  for (const start of [...links.keys()].sort()) {
    const path: string[] = []
    let node: string | null | undefined = start
    while (node != null && links.has(node) && !path.includes(node)) {
      path.push(node)
      node = links.get(node)
    }
    if (node != null && path.includes(node)) {
      const loop = path.slice(path.indexOf(node))
      const first = loop.indexOf([...loop].sort()[0]!)
      const cycle = [...loop.slice(first), ...loop.slice(0, first)]
      const key = JSON.stringify([...loop].sort())
      if (!seen.has(key)) {
        seen.add(key)
        found.push(cycle)
      }
    }
  }
  return found
}

/**
 * Group or asset ids don't differ only by case (their files collide on macOS).
 *
 * Slugs are lowercase and ULIDs uppercase, so the clash is a ULID and its lowercase spelling.
 * Handles are lowercase only, so people can't clash.
 */
function* checkIdCase(repo: CompanyRepo): Iterable<RepoIssue> {
  for (const [items, folder] of [[repo.groups, "groups"], [repo.assets, "assets"]] as const) {
    const first = new Map<string, string>()
    for (const [id] of sorted<unknown>(items)) {
      const key = id.toLowerCase()
      const earlier = first.get(key)
      if (earlier !== undefined) {
        yield repoIssue(`${folder}/${id}.yaml`, "repo.id_case_clash",
          `${earlier} and ${id} differ only by case`)
      } else {
        first.set(key, id)
      }
    }
  }
}

/** Managers exist, and reporting lines have no cycles. */
function* checkManagers(repo: CompanyRepo): Iterable<RepoIssue> {
  for (const [handle, person] of sorted(repo.people)) {
    if (person.manager !== null && !repo.people.has(person.manager)) {
      yield repoIssue(personPath(handle), "person.unknown_manager",
        `manager @${person.manager} isn't a person in the company`)
    }
  }
  const links = new Map([...repo.people].map(([handle, person]) => [handle, person.manager]))
  for (const cycle of cycles(links)) {
    const loop = [...cycle, cycle[0]].map((h) => `@${h}`).join(" -> ")
    yield repoIssue(personPath(cycle[0]!), "person.manager_cycle", `reporting lines loop: ${loop}`)
  }
}

/** The CEO exists, is a human, and reports to nobody. */
function* checkCeo(repo: CompanyRepo): Iterable<RepoIssue> {
  if (repo.company === null) return
  const ceo = repo.people.get(repo.company.ceo)
  if (ceo === undefined) {
    yield repoIssue("company.yaml", "company.unknown_ceo", `ceo @${repo.company.ceo} isn't a person in the company`)
    return
  }
  // Agents can't sign in or hold devices, and the office acts as the CEO for tokenless requests.
  if (ceo.kind !== "human") {
    yield repoIssue("company.yaml", "company.ceo_not_human", `ceo @${ceo.handle} is an agent, not a human`)
  }
  if (ceo.manager !== null) {
    yield repoIssue("company.yaml", "company.ceo_has_manager", `${ceo.handle} reports to ${ceo.manager}`)
  }
}

/** Group parents and heads exist, and parents have no cycles. */
function* checkGroups(repo: CompanyRepo): Iterable<RepoIssue> {
  for (const [id, group] of sorted(repo.groups)) {
    if (group.parent !== null && !repo.groups.has(group.parent)) {
      yield repoIssue(`groups/${id}.yaml`, "group.unknown_parent", `parent group ${group.parent} doesn't exist`)
    }
    if (group.head !== null && !repo.people.has(group.head)) {
      yield repoIssue(`groups/${id}.yaml`, "group.unknown_head", `head @${group.head} isn't a person in the company`)
    }
  }
  const links = new Map([...repo.groups].map(([id, group]) => [id, group.parent]))
  for (const cycle of cycles(links)) {
    yield repoIssue(`groups/${cycle[0]}.yaml`, "group.parent_cycle",
      `parent groups loop: ${[...cycle, cycle[0]].join(" -> ")}`)
  }
}

/** People belong only to groups that exist. */
function* checkPersonGroups(repo: CompanyRepo): Iterable<RepoIssue> {
  for (const [handle, person] of sorted(repo.people)) {
    for (const id of person.groups) {
      if (!repo.groups.has(id)) yield repoIssue(personPath(handle), "person.unknown_group", `group ${id} doesn't exist`)
    }
  }
}

/** Tool names, as a model sees them through the toolbox, fit the model's limits; grants name real subjects and
 *  tools. */
function* checkAssets(repo: CompanyRepo): Iterable<RepoIssue> {
  for (const [id, asset] of sorted(repo.assets)) {
    const file = `assets/${id}.yaml`
    for (const tool of Object.keys(asset.tools)) {
      const shown = shownAssetToolName(id, tool)
      if (!TOOL_NAME.test(shown)) {
        yield repoIssue(file, "asset.tool_name_invalid",
          `${JSON.stringify(shown)}, the name a model sees, must match ${TOOL_NAME.source}`)
      }
    }
    const gated = new Set(Object.keys(asset.tools).filter((tool) => asset.tools[tool]!.risk === "gated"))
    for (const grant of asset.grants) {
      const colon = grant.who.lastIndexOf(":")
      const kind = colon < 0 ? "" : grant.who.slice(0, colon)
      const known: ReadonlyMap<string, unknown> = kind === "group" ? repo.groups : repo.people
      if (!known.has(grant.who.slice(colon + 1))) {
        yield repoIssue(file, "asset.unknown_grantee", `grantee ${grant.who} isn't a person or group in the company`)
      }
      for (const tool of grant.can) {
        if (tool !== "admin" && !Object.hasOwn(asset.tools, tool)) {
          yield repoIssue(file, "asset.unknown_tool", `tool ${JSON.stringify(tool)} isn't one of this asset's tools`)
        } else if (gated.has(tool)) {
          yield repoIssue(file, "asset.gated_tool_granted",
            `${tool} is gated; gated tools are not exposed to agents yet`, "warning")
        }
      }
    }
  }
}

/** The inputs the office passes a main flow; Yian refuses inputs a flow doesn't declare. The office binds the
 *  person's memory folder to `profile`. */
const MAIN_INPUTS = ["messages", "person", "talking_to", "summary", "history", "turns", "max_turns", "profile"]

/** The fields of a compiled node or type the chat-shape checks read; yian exports none of their classes. */
interface Shape {
  kind?: string
  memory?: string
  element?: Shape
  required?: ReadonlySet<string>
  nullable?: boolean
  child?: Compiled
  predicateKind?: string
  steerInbox?: boolean
  outputContract?: { type?: Shape } | null
}

/** A compiled flow's nodes and input wiring, as the chat-shape checks read them. */
interface Compiled {
  nodes: ReadonlyMap<string, Shape>
  wiring: ReadonlyMap<string, ReadonlyMap<string, { source: unknown }>>
}

/** Whether a wiring binding's source reads `${input.<name>}`; yian accepts spaces inside the braces. */
function readsInput(binding: { source: unknown } | undefined, name: string): boolean {
  return typeof binding?.source === "string" && binding.source.replace(/\s/g, "") === `\${input.${name}}`
}

/** What's wrong with a main flow's chat shape, each with its fix; empty when it has the template's shape. */
function chatShapeProblems(ref: string, flow: ComposedFlow): string[] {
  const like = "as the template's shared/flows/chat.yaml does"
  const [loopName, replyName] = MAIN_CHAT.reply.split("/") as [string, string]
  const inbox = `\${input.${MAIN_CHAT.inbox}}`
  const problems: string[] = []
  const parameter = flow.input.find((p) => p.name === MAIN_CHAT.inbox)
  const type = parameter?.contract?.type as Shape | undefined
  const element = type?.kind === "inbox" ? type.element : undefined
  if (element?.kind !== "object" || !element.required?.has("role") || !element.required.has("parts")) {
    problems.push(`${ref}'s ${MAIN_CHAT.inbox} input isn't an inbox of messages; the office sends what people say`
      + ` there, so declare \`${MAIN_CHAT.inbox}: !Inbox(Message)\` ${like}`)
  }
  const profile = flow.input.find((p) => p.name === "profile")?.contract?.type as Shape | undefined
  if (profile?.kind !== "memory" || profile.memory !== "FileMemory") {
    problems.push(`${ref}'s profile input isn't a FileMemory; the office binds the person's memory folder there, so`
      + ` declare \`profile: !FileMemory\` ${like}`)
  }
  const compiled = flow.compiled as unknown as Compiled
  const loop = compiled.nodes.get(loopName)
  if (loop?.child === undefined || loop.predicateKind === undefined
    || !readsInput(compiled.wiring.get(loopName)?.get(MAIN_CHAT.inbox), MAIN_CHAT.inbox)) {
    problems.push(`${ref} has no LOOP node ${loopName} that passes ${MAIN_CHAT.inbox}: ${inbox} to its turn; the`
      + ` office reads each turn there, so loop a turn def as ${loopName} ${like}`)
    return problems
  }
  const reply = loop.child.nodes.get(replyName)
  if (reply?.kind !== "agent") {
    problems.push(`${ref}'s turn has no AGENT node ${MAIN_CHAT.reply}; the office reads each reply there, so name`
      + ` the turn's agent ${replyName} ${like}`)
    return problems
  }
  // "__steer_inbox" is yian's STEER_INBOX_KEY, which yian doesn't export.
  const steer = loop.child.wiring.get(replyName)?.get("__steer_inbox")
  if (reply.steerInbox !== true || !readsInput(steer, MAIN_CHAT.inbox)) {
    problems.push(`${ref}'s ${MAIN_CHAT.reply} doesn't read the ${MAIN_CHAT.inbox} inbox as its steer inbox, so`
      + ` messages sent while it works never reach it; set \`steer_inbox: ${inbox}\` on it ${like}`)
  }
  if (reply.outputContract?.type?.nullable !== true) {
    problems.push(`${ref}'s ${MAIN_CHAT.reply} output isn't optional; an interrupt cuts the reply and fails a strict`
      + ` output, so declare it as Optional(...), such as \`output: Optional(str)\`, ${like}`)
  }
  return problems
}

/** Agents have a main flow; every main, SOP, and routine flow is a relative path to a file inside the repo
 *  that compiles; a main flow declares the inputs the office passes it and has the template chat's shape. */
async function* checkFlows(repo: CompanyRepo): AsyncIterable<RepoIssue> {
  for (const [handle, person] of sorted(repo.people)) {
    const file = personPath(handle)
    if (person.kind === "agent" && !person.main) {
      yield repoIssue(file, "person.no_main", "agents need a main flow")
    }
    const base = path.join(repo.root, "people", handle)
    const refs: [ref: string, isMain: boolean][] = person.main ? [[person.main, true]] : []
    for (const { flow } of [...person.sops, ...person.routines]) refs.push([flow, false])
    for (const [ref, isMain] of refs) {
      if (ref.includes("\0")) {
        yield repoIssue(file, "person.flow_invalid", `${JSON.stringify(ref)}: embedded null byte`)
        continue
      }
      const resolved = resolvePath(path.resolve(base, ref))
      // The worker joins the ref under the session's pinned worktree, where an absolute path names no file; read
      // as absolute, it would name the live clone rather than the pinned commit. The message shows only the file
      // name, never the folders above the repo. An absolute ref outside the repo is reported below as outside it.
      if (path.isAbsolute(ref) && !outsideRoot(repo.root, resolved)) {
        yield repoIssue(file, "person.flow_invalid",
          `flow path .../${path.basename(ref)} is absolute; write it relative to people/${handle}/`)
        continue
      }
      if (!outsideRoot(repo.root, resolved) && !isFile(resolved)) {
        yield repoIssue(file, "person.flow_missing", `${ref} does not exist`)
        continue
      }
      let flow: ComposedFlow
      try {
        flow = await loadConfined(repo.root, resolved)
      } catch (error) {
        if (error instanceof FlowOutsideRepo) {
          yield repoIssue(file, "person.flow_outside_repo", `${ref}: ${error.message}`)
        } else if (error instanceof LoadError) {
          yield repoIssue(file, "person.flow_invalid", `${ref}: ${error.message}`)
        } else {
          // A system error or RangeError from a child file, or a surprise.
          const what = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
          yield repoIssue(file, "person.flow_invalid", `${ref}: ${what}`)
        }
        continue
      }
      if (!isMain) continue
      const declared = new Set(flow.input.map((parameter) => parameter.name))
      const missing = MAIN_INPUTS.filter((name) => !declared.has(name))
      if (missing.length > 0) {
        const names = missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}` : missing[0]
        const [them, s] = missing.length > 1 ? ["them", "s"] : ["it", ""]
        yield repoIssue(file, "person.main_inputs_missing",
          `${ref} doesn't declare the ${names} input${s}; the office passes ${them} to a main flow and Yian refuses`
          + ` inputs a flow doesn't declare, so declare ${them} under input: as the template's`
          + " shared/flows/chat.yaml does")
        continue
      }
      for (const problem of chatShapeProblems(ref, flow)) yield repoIssue(file, "person.main_chat_shape", problem)
    }
  }
}

/**
 * Loads each skill directory under one root and returns their names; each bad one becomes a `skill.invalid`
 * issue in `issues`.
 *
 * Mirrors yian's `loadSkills`: hidden entries and directories without `SKILL.md` are skipped, and two skills
 * with one name in the same root are a problem. It loads each directory itself to report each problem
 * at its own path.
 */
function skillRoot(root: string, rel: string, issues: RepoIssue[]): Set<string> {
  const names = new Set<string>()
  const entries = isDir(root) ? fs.readdirSync(root).sort() : []
  for (const name of entries) {
    const dir = path.join(root, name)
    if (name.startsWith(".") || !isFile(path.join(dir, "SKILL.md"))) continue
    let skill: Skill
    try {
      skill = loadSkillDir(dir)
    } catch (error) {
      if (!(error instanceof SkillError) && errno(error) === undefined) throw error
      issues.push(repoIssue(`${rel}/${name}`, "skill.invalid", (error as Error).message))
      continue
    }
    if (names.has(skill.name)) {
      issues.push(repoIssue(`${rel}/${name}`, "skill.invalid",
        `skill name ${JSON.stringify(skill.name)} is used twice in ${rel}`))
    }
    names.add(skill.name)
  }
  return names
}

/** Granted skills exist in the person's own skills or in shared/skills. */
function checkSkills(repo: CompanyRepo): RepoIssue[] {
  const issues: RepoIssue[] = []
  const shared = skillRoot(path.join(repo.root, "shared", "skills"), "shared/skills", issues)
  for (const [handle, person] of sorted(repo.people)) {
    const own = skillRoot(path.join(repo.root, "people", handle, "skills"), `people/${handle}/skills`, issues)
    for (const name of person.skills) {
      if (!own.has(name) && !shared.has(name)) {
        issues.push(repoIssue(personPath(handle), "person.unknown_skill",
          `skill ${JSON.stringify(name)} isn't in people/${handle}/skills or shared/skills`))
      }
    }
  }
  return issues
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** Agents should have a profile; humans may skip it. A profile, `memory/profile.md`, must be a regular UTF-8 file in a
 *  memory folder that is a real folder. */
function* checkProfiles(repo: CompanyRepo): Iterable<RepoIssue> {
  for (const [handle, person] of sorted(repo.people)) {
    const rel = profilePath(handle)
    const found = profileState(path.join(repo.root, rel))
    if (found === "absent" && person.kind === "agent") {
      yield repoIssue(rel, "person.no_profile", "an agent's chats read memory/profile.md; create one", "warning")
    }
    // Errors: chats with that person can't start without the folder, and leave any other such profile out of their
    // memory, which the office can't read or write either.
    if (found === "not_a_folder") {
      yield repoIssue(path.posix.dirname(rel), "person.profile_not_a_file",
        "memory must be a folder, not a symlink or file")
    }
    if (found === "not_a_file") {
      yield repoIssue(rel, "person.profile_not_a_file",
        "memory/profile.md must be a regular file, not a symlink, folder or hard link")
    }
    if (found === "not_utf8") {
      yield repoIssue(rel, "person.profile_not_utf8", "memory/profile.md is not UTF-8; save it as UTF-8")
    }
  }
}

/** Whether the profile at `p` is absent, in a memory folder that isn't a folder (a symlink, a file), not a regular
 *  file (a symlink, a folder, a hard link), not UTF-8, or fine. */
function profileState(p: string): "absent" | "not_a_folder" | "not_a_file" | "not_utf8" | "ok" {
  const absent = (error: unknown) => ["ENOENT", "ENOTDIR", "EBADF"].includes(errno(error) ?? "")
  let fd: number
  try {
    if (!fs.lstatSync(path.dirname(p)).isDirectory()) return "not_a_folder"
    if (!fs.lstatSync(p).isFile()) return "not_a_file"
    // No follow, so a symlink swapped in since isn't read; no block, so a FIFO isn't waited on.
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
    fd = fs.openSync(p, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error) {
    if (absent(error)) return "absent"
    if (errno(error) === "ELOOP") return "not_a_file"
    throw error
  }
  try {
    const st = fs.fstatSync(fd)
    // yian's FileMemory leaves a file with another link out of the memory.
    if (!st.isFile() || st.nlink > 1) return "not_a_file"
    UTF8.decode(fs.readFileSync(fd))
    return "ok"
  } catch (error) {
    if (error instanceof TypeError) return "not_utf8"
    throw error
  } finally {
    fs.closeSync(fd)
  }
}

/** Only humans list devices or have a password, each device name once per person, and no token hash under
 *  two people. */
function* checkDevices(repo: CompanyRepo): Iterable<RepoIssue> {
  const owners = new Map<string, Set<string>>()
  for (const [handle, person] of sorted(repo.people)) {
    if (person.devices.length > 0 && person.kind !== "human") {
      yield repoIssue(personPath(handle), "person.agent_devices",
        "agents act through the office, not from devices; remove devices")
    }
    if (person.password_hash && person.kind !== "human") {
      yield repoIssue(personPath(handle), "person.agent_password",
        "agents act through the office and never log in; remove password_hash")
    }
    const names = person.devices.map((device) => device.name)
    const twice = new Set(names.filter((name, i) => names.indexOf(name) !== i))
    for (const name of [...twice].sort()) {
      yield repoIssue(personPath(handle), "person.duplicate_device", `device ${name} is listed twice`)
    }
    if (person.kind === "human") {
      for (const device of person.devices) {
        const handles = owners.get(device.token_sha256) ?? new Set()
        owners.set(device.token_sha256, handles.add(handle))
      }
    }
  }
  // The office ignores a hash two people list, since it can't tell who acts.
  for (const [handle, person] of sorted(repo.people)) {
    if (person.kind !== "human") continue
    for (const device of person.devices) {
      const others = [...owners.get(device.token_sha256)!].filter((other) => other !== handle).sort()
      if (others.length > 0) {
        yield repoIssue(personPath(handle), "person.shared_device_token",
          `device ${device.name}'s token is also listed by ${others.join(", ")}`)
      }
    }
  }
}

const CHECKS: Check[] = [checkIdCase, checkManagers, checkCeo, checkGroups, checkPersonGroups, checkAssets,
  checkFlows, checkSkills, checkProfiles, checkDevices]
