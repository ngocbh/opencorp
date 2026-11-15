# OpenCorp

OpenCorp: run a company of AI employees on your machine. A local office daemon runs them on top
of the Yian engine. Its goals:

- Yian flows hold each employee's traits and SOPs: repeatable work that improves over long runs.
- Flexible or one-off work runs in Codex, Claude Code, or OpenCode, unchanged. OpenCorp lets
  an employee act as their user.
- OpenCorp dogfoods Yian. Whenever we can, automate work with a Yian YAML flow that people and
  agents can share and reuse, rather than with one-off code.

Read before you change code:

- [`CONTRIBUTING.md`](CONTRIBUTING.md): setup, the tests and the pull-request workflow.
- [`ARCHITECTURE.md`](ARCHITECTURE.md): the packages, the office's layers, and the rules that must
  not break.
- [`docs/STYLE.md`](docs/STYLE.md): how to write a page on the docs site.

## Yian and OpenCorp

**Yian is the engine.** It owns the mechanisms any program needs to run agent work reliably: the
flow language; loading, compiling, running and replaying flows; the run log; agents and their tool
loop; inboxes, steers, `ask_user` and interrupts; memory and skills; model clients (providers,
logins, connections, model lists and checks); message authors. Yian knows nothing of companies,
people or offices.

**OpenCorp is the company built on it.** It owns policy and product: the company (people, org
chart, SOPs as flows in the company repo); the office (daemon, sessions, the people and devices who
sign in); who may do what (modes, approvals, rules, sandbox profiles); the three instruments (the
terminal, Claude Code and Codex; the first two come with #888); which model each person uses and
what it costs; the TUI, CLI and HQ.

**Where a new piece goes.** Ask: would another program running Yian flows need it? If so, it is a
mechanism and goes in Yian, as a yian issue. OpenCorp never re-implements a Yian mechanism or works
around a gap. If it is about the company, its people, the office, or who may do what, it goes in
OpenCorp.

| Concept | Yian | OpenCorp |
|---|---|---|
| A run | Its log, replay and resume | Which session it belongs to |
| An agent at work | The tool loop, steers, interrupts | Who may steer it; modes and approvals |
| A question | `ask_user`, held and answered | Question cards, and who answers |
| Models | Providers, logins, named connections, listing, checks | Which connection the office and each employee use; prices and cost caps |
| Memory | Memory types and their tools | An employee's profile, and who may edit it |
| Speakers | A message's `author`, and the wrapper that can't be forged | Who the speakers are, and whose word wins |
| Flows | The language and the engine | The company's SOPs; the built-in flows (`init`, `hq` learning) |

Yian's run log is the source of truth for what happened. OpenCorp stores only identity, policy and
views over the log (#302).

## Built around Yian

Everything in OpenCorp is built around Yian flows. Each kind of work an employee does is a flow:
chatting with them, running an SOP, handing work to Codex, Claude Code, or OpenCode. Office code
runs flows and provides the tools they call (workspace, company, questions, ...). It doesn't add
a way to do work beside a flow.

Codex sessions (#144) predate this principle and run outside Yian; #179 sketches moving them
onto flows.

## Building a feature on Yian

Before designing a feature, during brainstorming:

1. Design the feature as Yian flows plus the office tools they call. Ask whether the work
   repeats: will the owner, other people, or agents run it again? If so, make it an SOP that
   anyone can share and reuse. If it's one-off or flexible work, a flow hands it to Codex,
   Claude Code, or OpenCode.
2. For a flow, list the Yian features it needs and check that Yian supports each one.
3. For each missing feature, file an issue on the yian repo (github.com/ngocbh/yian) asking for a
   generic feature. Don't work around it in OpenCorp; build on what Yian has today and expand
   when Yian ships more.

## Rules

- Follow the pull-request steps and code style in `CONTRIBUTING.md`. Work test-first.
- Run `opencorp` in a checkout only through `packages/cli/bin/opencorp`, which runs Bun with
  `--no-install --no-env-file --config=/dev/null`. Never run `bun packages/cli/src/main.ts`: it
  reads the folder's `.env` and `bunfig.toml`.
- `bun test` has no fixtures: inject dependencies, give children an explicit env, and never change
  `process.env` in a test.
- Never edit `packages/yian/`. Yian changes go to the yian repo.
- Keep the rules in `ARCHITECTURE.md` ("Rules that must not break"): imports go one way, down the
  office's layers; only `platform.ts` uses Bun; only the worker hosts yian runs; secrets never reach
  argv, logs or what the model sees.
- OpenCorp is MIT-licensed. When you copy or substantially port code from another project, credit
  it in `THIRD_PARTY_NOTICES.md` (project, license, upstream paths and commit, our paths).
- Keep the docs up to date: update them when behavior changes. Keep them concise and direct.

## Counterparts to study

Before designing something, or when stuck, look at how well-established open-source projects solve
it. Map their pieces to ours, reuse as much as their licenses allow, and decide only where
following them conflicts with our goals. Yian's own invention is learning across runs and
readable, typed SOPs. For everything else (durable recovery, external events, scheduling,
retries, run views), borrow the designs below instead of re-solving them.

| Area | Project | Strong at |
|---|---|---|
| Agent graphs | LangGraph | Checkpoints per step, `interrupt()` and resume for human input, time travel, Studio's run view |
| Durable execution | Temporal | Event-history replay, retries, signals, queries and updates, long-running workflows, versioning, a mature web UI |
| Event-driven steps | Inngest | Memoized `step.run`, `step.waitForEvent`, `step.sleep`, concurrency and throttling controls |
| Learning from feedback | DSPy, TextGrad | DSPy: optimizers that tune prompts and examples against a metric. TextGrad: text feedback propagated backward through LLM calls |
| Server and clients | OpenCode (our TUI's upstream) | One service with many clients, a contract-first API, an SSE event stream, a SolidJS web app, pairing, an Electron desktop app |
| Gateway, security, native apps | OpenClaw | Device pairing and scopes, auth on loopback, protocol schema discipline, a macOS menu-bar app. Its security advisories show what to avoid |
| Coding-agent protocol | Codex app-server | Threads, turns and items; approvals as server requests; one protocol for many clients |
| AI-company org | Paperclip | Org chart, reporting lines and budgets for agent companies |

Research notes on these live in `docs/plans/research/` (local only).
