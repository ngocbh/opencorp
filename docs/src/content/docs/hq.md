---
title: "HQ"
description: "Open HQ, the office's web view, here or from a machine without the office."
---

HQ is the office's web view. `opencorp hq` opens HQ in your browser, signed in by a one-time link.
On Linux HQ's web port is off by default, so it prints how to reach HQ instead. Over SSH it prints
the forwarding commands.

## HQ from another machine

On a machine without the office, `opencorp hq` runs `~/.opencorp/hq/reach.sh` (under `$OPENCORP_HOME`
when set), logs in to HQ's machine over SSH, forwards HQ's socket to `http://127.0.0.1:49381/` and opens
it. It holds the connection until Ctrl-C; after a drop it tries once quietly, then reconnects each time you
press Enter (SSH may ask for Duo again). The first visit and `--sign-in` sign the browser in, for 30 days;
`--port N` picks another local port, which means signing in again. `--no-open` prints the link instead.
Run it on your own machine, not on one others share such as a cluster login node: anything there that can
reach the local port reaches HQ's sign-in page.

A visit's SSH reads your own SSH config (`~/.ssh/config`, then the system's) before OpenCorp's, so your
settings win wherever you set them. If you share connections there (`ControlMaster`, `ControlPath` and
`ControlPersist`), a visit rides a connection your terminal has open and asks for nothing, or leaves one your
terminals reuse for as long as your `ControlPersist` says. Where you set none, OpenCorp shares its own in
`~/.opencorp/hq/cm`: you log in once per visit, and those connections close when it ends. OpenCorp closes only
the connections it keeps there.

With no `reach.sh` yet, `opencorp hq` in a terminal offers to learn the way there with an agent, after
saying what the model will see: each command it runs and its output (hostnames, your username, paths, job
lists). The agent asks you questions, and each command it wants runs, as you and with your SSH keys, only
once you approve it; SSH's prompts (passwords, Duo, host keys) come to you, never to the model. It then
shows you `reach.sh` and `notes.md` (how your cluster is reached, in plain words) with the risks of your
setup, and saves them only once you approve and the whole connection works: the script, the login, the
check on HQ's machine, the forward and HQ's health through it. That connection becomes the visit's. The
first learning run asks for a model with `opencorp init`'s picker and keeps it in
`~/.opencorp/hq/provider.json`. For OpenAI you can sign in to your ChatGPT subscription instead of giving
an API key: it shows a link and a code to enter in a browser on any device, and keeps the sign-in in
`~/.opencorp/hq/auth.json`. To forget the model, delete `provider.json` and `auth.json`. Later visits replay
`reach.sh` and use no model. `opencorp hq --relearn` learns again, starting from the old notes and script, and a saved path that
breaks offers to; the old path stays until a new one works.

You can also write `reach.sh` yourself: a `sh` script that finds HQ's machine (a Slurm job's node, say) and
prints, as its last line of output, how to reach it:

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
