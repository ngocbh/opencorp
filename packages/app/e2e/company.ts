// Fixture data for Playwright: a company, its live sessions, open cards, costs and work items.
import type {
  CompanyFile,
  CompanyTree,
  CompanyTreeEntry,
  CompanyView,
  CostReport,
  Person,
  Question,
  Session,
  WorkItem,
} from "@opencorp/protocol"

export const SHA = "0123456789abcdef0123456789abcdef01234567"
export const T = "2026-10-19T10:00:00.000Z"

export type Data = {
  view: CompanyView
  sessions: Session[]
  questions: Question[]
  costs: CostReport["people"]
  workItems: Record<string, WorkItem>
}

export const person = (handle: string, name: string, kind: Person["kind"], title: string, manager: string | null,
  groups: string[] = []): Person =>
  ({ handle, name, kind, title, manager, groups, devices: [], password_hash: null, home_office: "mac", harnesses: ["composer"] })

export const session = (id: string, who: string, status: Session["status"], over: Partial<Session> = {}): Session =>
  ({ id, person: who, harness: "composer", office: "mac", cwd: "/work", repo_commit: SHA, status, kind: "main",
     created_at: T, updated_at: T, ...over })

export const card = (id: string, sessionId: string, asker: string, over: Partial<Question> = {}): Question =>
  ({ id, session_id: sessionId, run_id: "r1", node_id: null, source: "ask_user", asker, question: "Which one?",
     status: "open", created_at: T, updated_at: T, ...over })

export const item = (id: string, title: string, over: Partial<WorkItem> = {}): WorkItem =>
  ({ id, title, kind: "task", status: "in_progress", requester: "ngocbh", created_at: T, updated_at: T, ...over })

/**
 * Acme: the CEO @ngocbh (human); @lead (agent, head of ENG) with @minh (also in OPS) and @kai under them; @ann
 * (human); @zoe, whose manager doesn't exist (unplaced); a file that doesn't parse. @minh is busy in Codex, @kai is
 * waiting on a card for the CEO, @lead is waiting on an ask_manager card whose work item W1 the CEO is assigned.
 */
export function acme(): Data {
  const people = [
    person("ngocbh", "Ngoc", "human", "CEO", null),
    person("lead", "Lead", "agent", "Tech lead", "ngocbh", ["eng"]),
    person("minh", "Minh", "agent", "Engineer", "lead", ["eng", "ops"]),
    person("kai", "Kai", "agent", "Engineer", "lead", ["eng"]),
    person("ann", "Ann", "human", "Designer", "ngocbh"),
    person("zoe", "Zoe", "agent", "Analyst", "ghost"),
  ]
  return {
    view: {
      sha: SHA,
      company: { name: "Acme", ceo: "ngocbh" },
      people,
      groups: [{ id: "eng", name: "ENG", parent: null, head: "lead" }, { id: "ops", name: "OPS", parent: "eng", head: null }],
      issues: [{ path: "people/bad/person.yaml", code: "repo.schema", message: "kind: isn't an allowed value", severity: "error" }],
    },
    sessions: [
      session("S-minh", "minh", "busy", { harness: "codex", work_item_id: "W-minh" }),
      session("S-kai", "kai", "waiting", { opened_by: "ngocbh", cost: 0.42, waiting_on: ["ngocbh"] }),
      session("S-lead", "lead", "waiting", { cost: 0, waiting_on: ["ngocbh"] }),
    ],
    questions: [card("Q-kai", "S-kai", "kai"), card("Q-lead", "S-lead", "lead", { source: "ask_manager", work_item_id: "W1" })],
    costs: { minh: { usd: 0, unpriced_sessions: 1 }, kai: { usd: 0.42, unpriced_sessions: 0 } },
    workItems: {
      W1: item("W1", "Pick a database", { kind: "question", requester: "lead", assignee: "ngocbh" }),
      "W-minh": item("W-minh", "Fix the build", { assignee: "minh" }),
    },
  }
}

/** A file as /api/company/file answers it, less `path` and `commit`, which the fixture fills in. */
export type SourceFile = Omit<CompanyFile, "path" | "commit">

/**
 * The company repo as Source reads it: the tree at HEAD, each file's answer, and the commits the office has served
 * (a tree read adds its commit, as the office's ring of the last 8 HEADs does, unless `serve` is false).
 */
export type Source = { tree: CompanyTree; files: Record<string, SourceFile>; served: string[]; serve: boolean }

export const LONG_LINE = `${"word ".repeat(80)}end`

/**
 * Acme's repo at SHA, committed two hours ago: text, a re-rendered human's person.yaml, and one file of every other
 * content state (binary, too large, hidden twice, a symlink and a submodule).
 */
export function source(): Source {
  const text = (text: string): SourceFile => ({ content: "text", text })
  const files: Record<string, SourceFile> = {
    "README.md": text(`# Acme\n\nThe company repo.\n${LONG_LINE}\n`),
    "company.yaml": text("name: Acme\nceo: ngocbh\n"),
    "people/ngocbh/person.yaml": {
      content: "text",
      text: "handle: ngocbh\nname: Ngoc\nkind: human\ntitle: CEO\nmanager: null\n",
      rewritten: true,
    },
    "people/ngocbh/profile.md": text("# Ngoc\n\nRuns Acme.\n"),
    "people/kai/person.yaml": text("# Kai writes the code.\nhandle: kai\nname: Kai\nkind: agent\ntitle: Engineer\nmanager: lead\n"),
    "people/kai/profile.md": text("# Kai\n\nTests first.\n"),
    "people/lead/person.yaml": text("handle: lead\nname: Lead\nkind: agent\ntitle: Tech lead\nmanager: ngocbh\n"),
    "assets/logo.png": { content: "binary" },
    "assets/big.csv": { content: "too_large" },
    "assets/.env": { content: "hidden", reason: "may hold credentials" },
    "assets/keys.yaml": { content: "hidden", reason: "holds a secret-named key" },
    "latest.md": { content: "symlink", target: "README.md" },
    "vendor/yian": { content: "submodule" },
  }
  const folders = ["assets", "people", "people/kai", "people/lead", "people/ngocbh", "vendor"]
  const type = (f: SourceFile): CompanyTreeEntry["type"] =>
    f.content === "symlink" ? "symlink" : f.content === "submodule" ? "submodule" : "file"
  const entries: CompanyTreeEntry[] = [
    // Folders and submodules have no size, as the office lists them.
    ...folders.map((path): CompanyTreeEntry => ({ path, type: "folder", size: null })),
    ...Object.entries(files).map(([path, f]): CompanyTreeEntry => {
      const t = type(f)
      return { path, type: t, size: t === "submodule" ? null : (f.text?.length ?? 100) }
    }),
  ]
  const time = new Date(Date.now() - 2 * 3_600_000).toISOString()
  return {
    tree: { commit: { id: SHA, subject: "Add Kai", author: "Ngoc", time }, entries, truncated: false, skipped: 0 },
    files,
    served: [],
    serve: true,
  }
}

/** A Yian flow with its custom tags, for syntax colors. */
export const FLOW = `# Hire an engineer.
name: hire
version: 2
strict: true
inputs:
  role: !str "Engineer"
  manager: !Person lead
steps:
  - ask: Who should we hire?
    retries: 3
    notes: |
      Ask the lead first.
      Then the CEO.
`

/** A file that looks like HTML and a template: it must show as text. */
export const HOSTILE = '<script>window.__xss = 1</script>\n<img src="x" onerror="window.__xss = 2">\n{{ constructor.constructor("window.__xss = 3")() }}\n'

/** Extra files for Source, in folders the default repo doesn't have: `flows/hire.yaml`, JSON, hostile text and more. */
export const EXTRA_FILES: Record<string, SourceFile> = {
  "flows/hire.yaml": { content: "text", text: FLOW },
  "flows/office.json": { content: "text", text: '{\n  "tcp": false,\n  "port": 49380,\n  "name": "HQ",\n  "dev_origins": null\n}\n' },
  "flows/hostile.md": { content: "text", text: HOSTILE },
  "flows/hostile.txt": { content: "text", text: HOSTILE },
  "flows/scrubbed.yaml": { content: "text", text: "url: https://kai:(hidden)@example.com\ntoken: (hidden)\n" },
  "flows/big.yaml": { content: "text", text: `big: ${"x".repeat(512 * 1024)}\n` },
  // highlight.js's YAML grammar is quadratic on a long line of unquoted words: this one would take about a minute.
  "flows/words.yaml": { content: "text", text: `name: words\nnotes: ${"word ".repeat(100_000)}\nend: true\n` },
}

/** `s` with `files` added to its files and its listing, and their folders listed. */
export function withFiles(s: Source, files: Record<string, SourceFile>): Source {
  const listed = new Set(s.tree.entries.map((e) => e.path))
  for (const [path, f] of Object.entries(files)) {
    const parts = path.split("/")
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/")
      if (!listed.has(folder)) s.tree.entries.push({ path: folder, type: "folder", size: null })
      listed.add(folder)
    }
    s.files[path] = f
    if (!listed.has(path)) s.tree.entries.push({ path, type: "file", size: f.text?.length ?? 100 })
    listed.add(path)
  }
  return s
}

/** A company with `n` agents under the CEO: one very wide level, for the chart's fit. */
export function wide(n: number): Data["view"] {
  const agents = Array.from({ length: n }, (_, i) => person(`a${i}`, `Agent ${String(i).padStart(2, "0")}`, "agent", "Worker", "ngocbh"))
  return { ...acme().view, people: [person("ngocbh", "Ngoc", "human", "CEO", null), ...agents], groups: [], issues: [] }
}
