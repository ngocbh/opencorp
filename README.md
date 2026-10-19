# OpenCorp

OpenCorp: run a company of AI employees on your machine.

OpenCorp runs AI employees locally, on top of [Yian](https://github.com/ngocbh/yian). Early stage.

## Goals

- Everything is built around Yian flows. Each kind of work an employee does is a flow: chatting
  with them, running an SOP, handing work to Codex, Claude Code, or OpenCode. The office runs the
  flows and provides the tools they call.
- Yian flows hold each employee's traits and SOPs: repeatable work that improves over long runs.
- Flexible or one-off work runs in Codex, Claude Code, or OpenCode, unchanged. OpenCorp lets
  an employee act as their user.
- OpenCorp dogfoods Yian: whenever we can, work is automated with Yian YAML flows that people
  and agents share and reuse.

Setup, layout, tests, and workflow: [CLAUDE.md](CLAUDE.md).

OpenCorp isn't affiliated with OpenCode (its TUI is forked from OpenCode's) or with OpenCorporates.
