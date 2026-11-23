---
title: "HQ"
description: "Open HQ, the office's web view, here or on other machines over SSH."
---

HQ is the office's web view. `opencorp hq` opens HQ in your browser, signed in by a one-time link.
On Linux HQ's web port is off by default, so it prints how to reach HQ instead. Over SSH it prints
the forwarding commands. `opencorp hq NAME` opens the HQ of an office on another machine, which you
save as a destination (see [Several offices](#several-offices)).

## HQ from another machine

`opencorp hq NAME` runs destination NAME's `~/.opencorp/hq/NAME/reach.sh` (under `$OPENCORP_HOME` when
set), logs in to HQ's machine over SSH, forwards HQ's socket to a local port (`http://127.0.0.1:49381/` for
your first destination) and opens it. It holds the connection until Ctrl-C; after a drop it tries once
quietly, then reconnects each time you press Enter (SSH may ask for Duo again). The first visit and
`--sign-in` sign the browser in, for 30 days; `--port N` picks another local port, which means signing in
again. `--no-open` prints the link instead. Run it on your own machine, not on one others share such as a
cluster login node: anything there that can reach the local port reaches HQ's sign-in page.

A visit's SSH reads your own SSH config (`~/.ssh/config`, then the system's) before OpenCorp's, so your
settings win wherever you set them. If you share connections there (`ControlMaster`, `ControlPath` and
`ControlPersist`), a visit rides a connection your terminal has open and asks for nothing, or leaves one your
terminals reuse for as long as your `ControlPersist` says. Where you set none, OpenCorp shares its own in a
folder per destination, `~/.opencorp/hq/cm-<id>`: you log in once per visit, and those connections close when it
ends. OpenCorp closes only the connections it keeps there.

When NAME isn't saved yet, `opencorp hq NAME` in a terminal offers to learn the way there in a chat with
OpenCorp, which opens in the TUI; so does plain `opencorp hq` on a machine with no office and no destination,
and names the path after the first host it reaches. It needs a terminal the TUI can draw on; elsewhere,
`TERM=dumb` included, it says so and asks nothing. Before the chat it says what the model will see: what the
agent's shell shows (hostnames, your username, paths, job lists).

- **The mode.** The chat starts in `auto`: read-only commands and short answers to a prompt (a host key's
  `yes`, Duo's `1`) run at once, and the rest goes to Auto's check, a model call on your connection, or asks
  you. Press Shift+Tab for `default` or `ask` to approve more of it yourself, as for a careful relearn. While a
  command waits for your answer, the agent's next commands wait behind it; a No also refuses those that would ask.
- **The agent's shell** runs in a sandbox that reaches your SSH files (`~/.ssh`, your SSH config, your agent)
  and nothing else of your home or of `~/.opencorp`: not the model's key, nor another destination's files.
  Where this machine can't sandbox it (no bubblewrap, say), `opencorp hq` says why and asks first whether to
  run it with none; the default is to stop.
- **Passwords.** When ssh asks for a password or a code, the shell opens itself in the chat and you type it
  there. The agent sees the prompt as the screen shows it, never what you type at it.
- **One login.** The agent's ssh uses a connection you have open to the cluster, with no password prompt.
  Without one, each separate ssh may ask you to log in. Connect from your own terminal first, or let the agent
  log in once and type its commands into that shell. The agent's commands could end a connection of yours; that
  asks you first, in every mode.
- **The agent's ssh** goes through OpenCorp's ssh wrapper, which reads OpenCorp's config for the agent: it rides a
  connection you have open and never keeps one of its own (`ControlMaster no`).
  - **On Linux** the sandbox puts the wrapper in place of every system ssh, so ssh goes through it however it is run:
    by its path, through `command -p`, with another `PATH`, from a program such as `python`, and from `scp` and
    `sftp`, which run ssh themselves. The wrapper passes that config and `ControlMaster=no` ahead of the agent's own
    options, so theirs can't override it. The real ssh stays at `/run/opencorp/ssh` for the wrapper, and a command
    could run it directly: a line naming that folder asks you first, in every mode, and running it gains nothing but
    a login of its own, which asks you for any password or code as usual.
  - **On macOS** the sandbox can't put one program in place of another, so only an ssh found on the shell's `PATH`
    goes through the wrapper. OpenCorp's command check asks you first, in every mode, before ssh run by its path,
    through `command -p` or an `env` that clears or sets `PATH`, and before a line that changes `PATH` or runs
    `hash -p` (on Linux too). A program that runs ssh itself, `scp` and `sftp` included, isn't caught, and uses your
    config as it is.
- **Saving.** The agent shows you `reach.sh` and `notes.md` (how your cluster is reached, in plain words)
  with the risks of your setup on a card, which you read to the end before you choose. It asks in every
  mode. "Test it, then save it" runs the whole connection in OpenCorp's own connection shell, which the chat
  shows: the script, the login, the check on HQ's machine, the forward and HQ's health through it. SSH asks
  you there for any password or Duo. Only when it all works are the files saved; the chat then closes, and the
  visit holds that connection. Type what should change instead, and the agent tries again.

The first learning run asks for a model with `opencorp init`'s picker, before the chat, and keeps it in
`~/.opencorp/hq/provider.json`, which every destination's learning uses. For OpenAI you can sign in to your
ChatGPT subscription instead of giving an API key: it shows a link and a code to enter in a browser on any
device, and keeps the sign-in in `~/.opencorp/hq/auth.json`. To forget the model, delete `provider.json` and
`auth.json`. Later visits replay `reach.sh` and use no model. `opencorp hq NAME --relearn` learns NAME again,
starting from its old notes and script, and a saved path that breaks offers to; the old path stays until a new
one works. Press Ctrl-C twice in the chat to stop learning: the visit lists the commands the agent ran.

You can also write `~/.opencorp/hq/NAME/reach.sh` yourself, then run `opencorp hq NAME`: a `sh` script that
finds HQ's machine (a Slurm job's node, say) and prints, as its last line of output, how to reach it:

```sh frame="code"
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
which uses the visit's SSH config and records each ssh's exit), `HOME`, `SSH_AUTH_SOCK`, `OPENCORP_SSH_CONFIG`
and `OPENCORP_SSH_STATUS`, and stdin from `/dev/null`; its stderr goes to you. It exits 0 with the spec, 3
when HQ's office isn't there (no job, say; the reason on stderr), or 255 when it couldn't connect (`set -eu`
passes ssh's 255 through). Any ssh in it that exits 255, even one whose failure the script handles, means
"couldn't connect", so failover such as `ssh a true || ssh b true` isn't supported. Control commands don't
count: `ssh -O check login || ssh -fN login` works. A `reach.sh` you wrote or changed is shown, whole or as a
diff, and runs only once you approve it. `opencorp hq` exits 3 when no office answers there.

Each visit runs `opencorp hq --check` on HQ's machine, so that checkout needs this version of OpenCorp.

## Several offices

Each office you reach from this machine is a destination with a name you choose. `opencorp hq misha` learns
the way to it the first time, then reaches it, even while an office runs on this machine. Each destination
keeps its own path, local port and browser sign-in, so several can be open at once.

| Command | What it does |
|---|---|
| `opencorp hq` | This machine's office, when one answers. Otherwise your one destination, or a question listing them, the last used first; without a terminal it prints their names and exits 2. |
| `opencorp hq NAME` | Destination NAME. When it isn't saved, it offers to learn it under that name; without a terminal it lists the saved ones and exits 2. |
| `opencorp hq NAME --relearn` | Learns NAME's path again; the old one stays until the new one works. |
| `opencorp hq --list` | Each destination's name, host, local port and last use. |
| `opencorp hq --rename OLD NEW` | Renames a destination. |
| `opencorp hq --forget NAME` | Deletes a destination's folder, after asking; it needs a terminal to ask on. |

- **Names** are 1 to 32 lowercase letters, digits and dashes, starting with a letter or a digit. A few words
  `opencorp hq` uses itself, such as `list` and `ssh`, aren't names. A path learned with plain `opencorp hq`
  is named after the first host it reaches, such as `login1`, or `login1-2` when that name is taken.
- **Ports.** Your first destination gets 49381, and each later one the next port no other destination uses.
  `--port N` moves a destination to N, unless another destination has it.
- **Flags.** `--port`, `--sign-in`, `--no-open` and `--relearn` apply to the destination named. `--handle` and
  `--json` are for this machine's office.
- **Open destinations.** `--rename` and `--forget` refuse a destination another `opencorp hq` has open, and
  `--rename` refuses a name that is taken.
- **Files.** Each destination's files are in `~/.opencorp/hq/NAME/`. A destination whose `access.json` is
  broken names the file and says to relearn it; the others still work.

## Troubleshooting

A visit can't work with some SSH settings for the hosts it reaches. When a visit fails, `opencorp hq` reads
your config for each host that `reach.sh` and its spec name, and for their jump hosts, with `ssh -G` (which
connects nowhere), and names any of these you set:

- `RemoteCommand`: SSH refuses to run a command of its own beside it, such as the one in `reach.sh`.
- `RequestTTY force`.
- `SessionType none` or `subsystem`, `StdinNull yes` or `ForkAfterAuthentication yes` (OpenSSH 8.7 and
  later).
- A `ControlPath` in a folder that doesn't exist or that you can't write to: SSH logs in, then can't share
  the connection, and exits.

Keep such settings under a name you use by hand, not under the hosts in `reach.sh`, and create your
`ControlPath`'s folder (for example `mkdir -p ~/.ssh/tmp`):

```ssh-config frame="code"
Host login-tmux
  HostName login.example.edu
  RemoteCommand tmux new -A -s main
  RequestTTY force
```

If a visit can't reconnect after your machine sleeps, a connection your own SSH config shares may be stale: end
it with `ssh -O exit <login host>`, or set `ServerAliveInterval` in your SSH config so SSH notices a dead
connection.
