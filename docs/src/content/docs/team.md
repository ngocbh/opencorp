---
title: "Talk to your team and hire"
description: "Open the TUI in a project folder to talk to your employees, and hire new ones."
---

`opencorp` opens the TUI, where you talk to your employees and hire new ones.

## Talk to your team

Run `opencorp` in a project folder. In a folder nobody has worked in yet, it first asks "Who do you
want to talk to?". `opencorp -c` continues the newest session in that folder.

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
