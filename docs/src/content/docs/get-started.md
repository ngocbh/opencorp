---
title: "Get started"
description: "Install OpenCorp with one line or by hand, and remove it."
---

This page installs OpenCorp. Then [create your company](/create-the-company/).

## Install

OpenCorp runs from a checkout, on macOS or Linux with git and curl. Install it with one line:

```sh
curl -fsSL https://raw.githubusercontent.com/ngocbh/opencorp/main/install.sh | bash
```

It clones OpenCorp into `~/.local/share/opencorp`, installs [Bun](https://bun.sh) 1.4.2 if there's
no Bun (Bun's own installer adds `~/.bun/bin` to your rc files, even with `--no-modify-path`),
installs the dependencies, builds the HQ web app, writes the `opencorp` command into
`~/.local/bin`, and puts that folder on your `PATH` in your shell's rc files. On a terminal it then
offers to create your company in a project folder (`~/projects/opencorp` by default). Run it again
to update. Options go after `bash -s --`: `--dir`, `--branch`, `--repo`, `--skip-setup`,
`--no-modify-path` and `--switch`; `--help` says what each does. On Linux you also need bubblewrap
(`bwrap`), which sandboxes the agents' commands; the installer warns when it's missing.

If an office is set up and `opencorp` runs another checkout (for example one linked by hand, as
below), the installer stops and changes nothing, since the office's service keeps running that
checkout's code. `--switch` moves the office over: it runs `opencorp stop` before it points `opencorp`
at the new checkout, and you then run `opencorp onboard` from the new install, which sets the
office's service up again.

Codex is optional: to use Codex sessions, install Codex 0.167.0 or later
(`npm install -g @openai/codex`) and run `codex login` before `opencorp init`.

## Install by hand

`./install.sh` in a checkout installs that checkout. Or, without the installer:

```sh
git clone --recurse-submodules https://github.com/ngocbh/opencorp.git && cd opencorp
bun install
mkdir -p ~/.local/bin && ln -sf "$PWD/packages/cli/bin/opencorp" ~/.local/bin/opencorp
bun run build    # the HQ web app
```

`~/.local/bin` must be on your `PATH`. Always run `opencorp` through this wrapper, never
`bun packages/cli/src/main.ts`, which reads the folder's `.env` and `bunfig.toml`. Don't put project
folders on `PATH`: a model-written project could then shadow `bun` or `opencorp`.
`opencorp --help` lists every command.

## Remove

To remove it:

```sh
curl -fsSL https://raw.githubusercontent.com/ngocbh/opencorp/main/uninstall.sh | bash
```

While an office is set up, it first runs `opencorp offboard`, which asks before it removes anything
and keeps company work that isn't pushed. Then it removes the command and its `PATH` lines, and the
clone with the `node_modules` folders and HQ's build (`packages/app/dist`) that install made in it.
It keeps the clone, and names what's in the way, when it holds work found nowhere else, ignored files
such as `.env` included. Bun, its rc lines and `~/.opencorp` stay, and so do rc files, emptied.
