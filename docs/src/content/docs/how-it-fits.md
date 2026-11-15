---
title: "How it fits together"
description: "What Yian does and what OpenCorp does, the packages, and the office's layers."
---

This page says which part of OpenCorp does what. The details live in the repository, for
contributors: [AGENTS.md](https://github.com/ngocbh/opencorp/blob/main/AGENTS.md) splits the work
between Yian and OpenCorp, and
[ARCHITECTURE.md](https://github.com/ngocbh/opencorp/blob/main/ARCHITECTURE.md) maps the packages
and the office's layers.

## Yian and OpenCorp

- **Yian is the engine.** It runs agent work: the flow language, running and replaying flows, the
  run log, agents and their tools, questions, memory and model clients. It knows nothing of
  companies, people or offices. Its docs are at [yian.readthedocs.io](https://yian.readthedocs.io/).
- **OpenCorp is the company built on it.** It owns the company (people, the org chart, SOPs as flows
  in the company repo), the office, who may do what, which model each person uses and what it
  costs, and the TUI, CLI and HQ.

Each kind of work an employee does is a Yian flow: chatting with them, running an SOP, handing
work to Codex, Claude Code, or OpenCode. Yian's run log is the record of what happened; OpenCorp
stores only identity, policy and views over it.

[Yian and OpenCorp](https://github.com/ngocbh/opencorp/blob/main/AGENTS.md#yian-and-opencorp) in
AGENTS.md compares the two, concept by concept, and says where a new piece goes.

## The packages

| Package | What it is |
|---|---|
| `office` | The office daemon that runs the employees |
| `protocol` | The schemas the office and its clients share |
| `client` | What the TUI, CLI and HQ app reach the office with |
| `tui` | The TUI, forked from OpenCode's |
| `cli` | The `opencorp` command |
| `app` | HQ, the web app |
| `yian` | The Yian engine, as a submodule |

## The office's layers

The office's code is in layers. Imports go down the layers or stay in their own. Lowest first:

| Layer | What it is |
|---|---|
| `util/` | Helpers that know nothing of the company, models, flows or the office's state |
| `company/` | The company |
| `runtime/` | What runs agents safely |
| `models/` | The office's model connections and their policy |
| `tools/` | What agents use |
| `features/` | What the owner and agents do |
| `server/` | The office's processes and how clients reach them |

[ARCHITECTURE.md](https://github.com/ngocbh/opencorp/blob/main/ARCHITECTURE.md#the-offices-layers)
gives each layer and folder a card, and lists the rules that must not break.
Layout, tests and workflow for contributors are in
[CONTRIBUTING.md](https://github.com/ngocbh/opencorp/blob/main/CONTRIBUTING.md).
