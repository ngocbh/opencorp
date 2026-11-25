---
title: "Talk to your team and hire"
description: "Open the TUI in a project folder to talk to your employees, and hire new ones."
---

`opencorp` opens the TUI, where you talk to your employees and hire new ones.

## Talk to your team

Run `opencorp` in a project folder. In a folder nobody has worked in yet, it first asks "Who do you
want to talk to?". `opencorp -c` continues the newest session in that folder. Ctrl+C twice leaves the chat; if the
office can't be reached, `Connection lost…` covers the screen until it is back, and one Ctrl+C leaves.

In the chat, each run of your employee's tool calls shows as one line, such as `+ 3 commands, 1 edit, 4 reads`:
click it to see the calls. "Verbosity" in the command list (ctrl+p) switches between Low (the default), Medium, which
folds only reads and searches, and High, which shows every call. Scrolled up in a long chat, click
`Jump to latest ↓` under it to go back to the newest message.

Enter sends a message. While your employee works, they read it before their next step; until then it has a grey
border, and a click on it moves it to the queue or deletes it. ctrl+x Enter queues a message instead: it waits for
their next turn, in a line above the prompt such as `2 queued · Then book the hotel.`. Click the line to see what is
queued: Enter steers with one now, ctrl+d deletes it, and ctrl+u puts it back in the prompt. Enter on an empty prompt
steers with the first. Esc stops your employee, and what is queued is their next turn. Anyone who may write in the
chat may queue; only whoever opened it moves or deletes a message, and only their own, so the line above the prompt
lists only yours, and someone else's queued message has a grey border in the chat. If a move can't finish, a toast says
why, and the message goes back where it was, or into your prompt.

A session's id in your employee's reply shows as a link named after that session, such as `@minh · codex 1` or
`@minh · chat`; one of the chat's Codex or Claude Code sessions opens in [the pane](/instruments/#the-pane).

## Hire

In that picker, or after opening it with `/people` or ctrl+x p, pick "Hire new…". Fill in Name,
Handle, Title and Manager (you, by default). The first Enter shows the change to the company repo;
the second hires. `office`, `opencorp` and `yian` can't be anyone's handle: OpenCorp and Yian speak as
them.

## What your employee works with

Your employee runs their commands in a sandboxed shell, and hands work to Codex or Claude Code when `tools` in their
`person.yaml` lists that harness. [Instruments and permissions](/instruments/) says how you watch and steer each one,
what `harness_policy` lets it touch, and where that permission stops.

To let your employee's Codex and Claude Code use one of your MCP servers, name it in their `harness_policy`
(`mcp_servers: [github]`). An allowed server runs as you, outside their folder fence: allowing `github` lets them do
whatever your GitHub token can. See [MCP servers](/instruments/#mcp-servers).
