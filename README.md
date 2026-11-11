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

## Quickstart

OpenCorp runs from a checkout. You need macOS or Linux, git, and [Bun](https://bun.sh) 1.4.2. On
Linux you also need bubblewrap (`bwrap`), which sandboxes the agents' commands. Codex is optional:
to use Codex sessions, install it (`npm install -g @openai/codex`) and run `codex login` before
`opencorp init`.

This repo and its yian submodule are private for now, so the clone needs access to both.

```
git clone --recurse-submodules https://github.com/ngocbh/opencorp.git && cd opencorp
bun install
mkdir -p ~/.local/bin && ln -sf "$PWD/packages/cli/bin/opencorp" ~/.local/bin/opencorp
bun run build    # the HQ web app
```

`~/.local/bin` must be on your `PATH`. Always run `opencorp` through this wrapper, never
`bun packages/cli/src/main.ts`, which reads the folder's `.env` and `bunfig.toml`. Don't put project
folders on `PATH`: a model-written project could then shadow `bun` or `opencorp`.
`opencorp --help` lists every command.

### Create the company

Run `opencorp init` from a project folder, since init opens the TUI there when it's done:

```
mkdir -p ~/projects/demo && cd ~/projects/demo
opencorp init
```

The office won't work in your home folder or a folder that holds it, in the opencorp checkout, or
inside a sensitive home folder; it refuses those with "use a project folder". If you ran init in
one, quit, `cd` into a project folder and run `opencorp`.

init takes five steps:

1. Model: pick the provider (anthropic by default) and give its key, or leave it empty to use
   yian's own login. The model is checked before it's saved, and the key stays in the office,
   readable only by you.
2. Company: tell the model about yourself, the company and your first AI teammate, then answer
   "Create this company?".
3. Password: it logs in your new devices.
4. Remote: the git remote for the company's repo, or "None for now".
5. This machine: installs the office as a service (launchd on macOS, systemd on Linux, otherwise
   tmux or a background process) and adds this device.

The flags `--company`, `--name`, `--handle`, `--title`, `--agent`, `--agent-handle`, `--remote` and
`--service` answer questions up front. A key is never a flag.

### Talk to your team

Run `opencorp` in a project folder. In a folder nobody has worked in yet, it first asks "Who do you
want to talk to?". `opencorp -c` continues the newest session in that folder.

### Hire

In that picker, or after opening it with `/people` or ctrl+x p, pick "Hire new…". Fill in Name,
Handle, Title and Manager (you, by default). The first Enter shows the change to the company repo;
the second hires.

### HQ

`opencorp hq` opens HQ in your browser, signed in by a one-time link. On Linux HQ's web port is off
by default, so it prints how to reach HQ instead. Over SSH it prints the forwarding commands.

### HQ from another machine

On a machine without the office, `opencorp hq` runs `~/.opencorp/hq/reach.sh` (under `$OPENCORP_HOME`
when set), logs in to HQ's machine over SSH, forwards HQ's socket to `http://127.0.0.1:49381/` and opens
it. It holds the connection until Ctrl-C; after a drop it tries once quietly, then reconnects each time you
press Enter (SSH may ask for Duo again). The first visit and `--sign-in` sign the browser in, for 30 days;
`--port N` picks another local port, which means signing in again. `--no-open` prints the link instead.

`reach.sh` is a `sh` script you write: it finds HQ's machine (a Slurm job's node, say) and prints, as its
last line of output, how to reach it:

```sh
set -eu
ssh me@login.example.edu true
printf '%s\n' '{"jump": ["me@login.example.edu"], "host": "me@node12", "opencorp": "/home/me/opencorp/packages/cli/bin/opencorp", "env": {"OPENCORP_BUN": "/home/me/.bun/bin/bun"}}'
```

- `host`: `[user@]host` of HQ's machine. `port`: its SSH port, if not 22.
- `jump`: up to 3 jump hosts, `[user@]host[:port]`, in order.
- `opencorp`: the absolute path of `opencorp` there (a checkout's `packages/cli/bin/opencorp`).
- `env`: `PATH`, `OPENCORP_BUN` or `OPENCORP_HOME` to set there, as absolute paths, when a
  non-interactive shell there lacks them.

Only these keys pass, each checked against a strict pattern, so nothing in the spec can become an SSH
option or a shell word. The script runs with only `PATH` (opencorp's ssh wrapper first,
which uses its own SSH config and records each ssh's exit), `HOME`, `SSH_AUTH_SOCK` and
`OPENCORP_SSH_CONFIG`, and stdin from `/dev/null`; its stderr goes to you. It exits 0 with the spec, 3 when
HQ's office isn't there (no job, say; the reason on stderr), or 255 when it couldn't connect (`set -eu`
passes ssh's 255 through). A new or changed `reach.sh` is shown, whole or as a diff, and runs only once you
approve it. `opencorp hq` exits 3 when no office answers there.

Each visit runs `opencorp hq --check` on HQ's machine, so that checkout needs this version of OpenCorp.

### Check and run

`opencorp doctor` checks the office, its service, the provider, the sandbox, Codex, HQ and the web
app, and says how to fix what it finds. `opencorp start` starts the office if it isn't running;
`opencorp restart` restarts it.

Layout, tests and workflow for contributors: [CLAUDE.md](CLAUDE.md).

OpenCorp isn't affiliated with OpenCode (its TUI is forked from OpenCode's) or with OpenCorporates.

## HQ settings

HQ, the office's web view, reads `~/.opencorp/office/hq.json` (under `$OPENCORP_HOME` when set) when the office
starts, so run `opencorp restart` after editing it. The file is optional; create it if it doesn't exist. It's a
JSON object with any of these keys:

- `tcp`: whether HQ listens on `http://127.0.0.1:<port>/`; on by default on macOS only. Off, `opencorp hq` prints
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
