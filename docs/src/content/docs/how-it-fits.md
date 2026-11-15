---
title: "How it fits together"
description: "What Yian does and what OpenCorp does, and where the details live."
---

OpenCorp is built on Yian. This page says in short which of the two does what.

**Yian is the engine.** It owns the mechanisms any program needs to run agent work reliably: the
flow language, running and replaying flows, the run log, agents and their tools, memory and model
clients. It knows nothing of companies, people or offices. Its docs are at
[yian.readthedocs.io](https://yian.readthedocs.io/).

**OpenCorp is the company built on it.** It owns the company (people, the org chart, SOPs as flows
in the company repo), the office, who may do what, which model each person uses and what it
costs, and the TUI, CLI and HQ.

Everything in OpenCorp is built around Yian flows: chatting with an employee, running an SOP and
handing work to Codex, Claude Code, or OpenCode are flows. The owner's Codex sessions are the
exception: they run outside Yian. Yian's run log is the source of truth for what happened;
OpenCorp stores only identity, policy and views over it.

For the details, see the repository:
[AGENTS.md](https://github.com/ngocbh/opencorp/blob/main/AGENTS.md#yian-and-opencorp) compares
Yian and OpenCorp concept by concept and says where a new piece goes, and
[ARCHITECTURE.md](https://github.com/ngocbh/opencorp/blob/main/ARCHITECTURE.md) maps the packages,
the office's layers and the rules that must not break.
