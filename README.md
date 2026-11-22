# OpenCorp

> Run a company of AI employees on your own machine. Hire AI employees you can trust, rely on, inspect, and continuously improve as they work.

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

## Install

OpenCorp runs from a checkout, on macOS or Linux with git and curl. Install it with one line:

```
curl -fsSL https://raw.githubusercontent.com/ngocbh/opencorp/main/install.sh | bash
```

On a terminal it then offers to create your company. Run it again to update.
[Get started](https://opencorp.readthedocs.io/get-started/) says what the installer does, how to
install by hand and how to remove OpenCorp.

## Documentation

Read the docs at [opencorp.readthedocs.io](https://opencorp.readthedocs.io/), starting with
[Get started](https://opencorp.readthedocs.io/get-started/).

Layout, tests and workflow for contributors: [CONTRIBUTING.md](CONTRIBUTING.md).

OpenCorp isn't affiliated with OpenCode (its TUI is forked from OpenCode's) or with OpenCorporates.

## License

MIT; see [LICENSE](LICENSE). Code and designs we build on are credited in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
