---
title: "Check and run"
description: "Check the office with opencorp doctor, and start or restart it."
---

`opencorp doctor` checks the office, its service, the provider, the sandbox, Codex, Claude Code, HQ
and the web app, and says how to fix what it finds. `opencorp start` starts the office if it isn't running;
`opencorp restart` restarts it.

Doctor prints one line per check: ✓ when it passes, ⚠ for a warning and ✗ for a failure. It exits 1
when any check fails. On a terminal the marks are coloured, unless `NO_COLOR` is set or `TERM` is
`dumb`. With an office home but no company yet, its report starts like this:

```plaintext
✓ home         /home/you/.opencorp
✗ company      no company repo at /home/you/.opencorp/company; run `opencorp init` to create one, or `opencorp onboard --from URL` to join one
⚠ provider     no /home/you/.opencorp/office/connections/office.json; runs use the login `yian auth` saved. `opencorp onboard` asks for one
```

Yian reads only the run-log schema it writes, so an update can leave run logs the office can't read,
and doctor warns how many there are. The office still starts: Run Logs names such a log's schema but
can't show it, and its session starts over at its next message, without that history. There's no
migration. To start clean, run `opencorp offboard`, then `opencorp init`, or
`opencorp onboard --from URL` for a company you pushed. Going back to an older OpenCorp leaves logs
of a later schema, which doctor counts too: update OpenCorp (run the installer again), then
`opencorp restart`, and the office reads them again.

Your company repo keeps its own copy of the flows its chats run, in `shared/flows/`, as `opencorp init` wrote them; an
update doesn't change them. To take an update's flows, start clean as above, or copy
`packages/office/src/company/template/shared/flows/` from OpenCorp's repo into your company repo and commit them. A chat
on flows that take no model of their own moves to a fresh run whenever `/model` picks another model.

OpenCorp needs Codex 0.167.0 or later. For an older one doctor fails and says to update Codex:
`npm install -g @openai/codex@latest` (or `brew upgrade codex`), then `opencorp doctor`. With Codex
signed in, doctor also starts a thread under an employee's permission, checks that Codex can use
it, and runs one command in Codex's sandbox under that permission, without running a model turn. So
a Codex whose sandbox can't run its commands fails here, saying what Codex said, and not at your
employee's first command. A Codex from Codex's own installer works too (see
[What an employee may touch](/instruments/#what-an-employee-may-touch)). Doctor warns about each
project you trust in Codex whose own `.codex/config.toml` Codex would load: your employees' Codex
sessions won't start there.

OpenCorp needs Claude Code 2.1.325 or later. For an older one doctor fails and says to update it:
`claude update` (or `brew upgrade claude-code`, or
`npm install -g @anthropic-ai/claude-code@latest`), then `opencorp doctor`. Doctor also starts
Claude Code as an employee's session starts it, under their permission, and reads its sign-in,
without sending it a message. Signed out is a warning: run `claude` and sign in with `/login`.
Claude Code runs only inside its own sandbox, so doctor fails when that sandbox can't start; on
Linux, install `bubblewrap` and `socat`. The office finds `socat` on its `PATH` when it starts, or
where `OPENCORP_SOCAT_BIN` points, and doctor fails when it finds none. Doctor runs no command in
that sandbox, so one that starts but fails on a command shows only when your employee runs one.

For each employee you allow MCP servers, doctor lists those servers and whether Codex and Claude Code define each,
by name only, and warns when a harness the employee uses doesn't ([MCP servers](/instruments/#mcp-servers)).

Codex and Claude Code run as you. Doctor fails, without running it, a Codex or Claude Code that
someone else could change: one the group or others may write, or one in a folder an employee may
write.
