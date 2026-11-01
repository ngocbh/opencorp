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

## HQ settings

HQ, the office's web view, reads `~/.opencorp/office/hq.json` (under `$OPENCORP_HOME` when set) when the office
starts, so run `opencorp restart` after editing it. The file is optional; create it if it doesn't exist. It's a
JSON object with any of these keys:

- `tcp`: whether HQ listens on `http://127.0.0.1:<port>/`; on by default on macOS only. Off, `opencorp pair` prints
  an SSH forward of HQ's socket instead.
- `port`: that port, 49380 by default; 0 picks any free one each start. Set another when something else holds it,
  for example `{"port": 49390}`.
- `app_dir`: where the built web app is; by default the checkout's `packages/app/dist`.
- `dev_origins`: extra origins HQ's API accepts, such as a Vite dev server's `"http://localhost:5173"`.

A file HQ can't read, or one with an unknown key or a bad value, turns the web port off until it's fixed;
`opencorp doctor` says what's wrong with it.

## License

MIT; see [LICENSE](LICENSE). Code and designs we build on are credited in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
