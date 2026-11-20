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
the second hires.

## What your employee runs

Your employee runs their commands in a shell sandboxed to the project folder: a command reaches that folder and a
private temp folder, and nothing else of your home or of `~/.opencorp`. Each command starts afresh in the project
folder. A new hire may write the folder and has no network; `harness_policy` in their `people/<handle>/person.yaml`
says so. In a folder they may write, `.git`'s hooks and config and the project config Codex and Claude Code read
(`.codex/`, `.agents/`, `.claude/`, `.mcp.json`) stay read-only, so a command can't plant something that later runs
as you. In a folder with no repository, `.git` stays read-only too: your employee can't start one there, so run
`git init` yourself. On Linux the shell first makes any of those four folders that is missing, empty (`.git` only
while a command runs), and a missing `.mcp.json` can still be created.

- **The mode.** A chat starts in `auto`: read-only commands and file operations in the project folder run at once,
  and the rest goes to Auto's check, a model call on the office's connection, or asks you. Shift+Tab switches the
  mode to `default`, `ask`, `dontAsk` and back. A card asks you before what the mode doesn't allow; `dontAsk`
  refuses it instead.
- **The shell.** The line under the prompt counts your employee's shells. Press ctrl+x o to open one and watch it;
  Ctrl-C there stops its command. Esc stops your employee and the command they were waiting on. A command they were
  told is still running goes on, and they read its output later.
- **The end.** Ending the session ends its shells and their commands.

## What an employee may touch

`harness_policy` in your employee's `people/<handle>/person.yaml` sets what their commands may touch:

```yaml
harness_policy:
  sandbox: workspace-write   # they may write the project folder; read-only by default
  network: false
  folders:                   # extra folders, each read-only or writable
    - { path: ~/.cargo, access: read }
    - { path: ~/miniconda3/envs/ml, access: write }
    - { path: /data/shared, access: write }
```

When your employee works in Codex or Claude Code, that harness's own sandbox holds their commands to the project
folder, a private temp folder and the listed folders, each with exactly the access listed. The shell above doesn't
mount the listed folders.

- A path is absolute or starts with `~/`, your home. `opencorp doctor` fails on any other, and on `/`, a folder
  listed twice, a path holding `*`, `?`, `[`, `]`, `{` or `}`, and a read-only one holding `:`.
- A folder that doesn't exist mounts nothing.
- The harness won't start with a folder whose path goes through a folder your employee can write (the project
  folder, or another writable listed folder), since a link there could repoint it. The same goes for a project
  folder reached through a link in a writable listed folder, and for a writable project folder inside a read-only
  listed folder.
- A project folder may lie inside a writable listed folder. `.git` stays read-only in each folder above it there, and
  the project config at its repository's root too, so a command can't plant a repository config that git later runs
  as you.
- Your employee's commands can't write the harnesses' own config (`~/.codex`, `~/.claude`, `~/.claude.json`, or
  where `CODEX_HOME` and `CLAUDE_CONFIG_DIR` point) or `~/.opencorp`, whatever you list.
- A read-only folder's `bin` is on the harness's `PATH`, unless someone else may write it: another user, another
  employee's writable listed folder, or the project folder of a session that is running. A writable folder's
  programs aren't on your employee's harness `PATH`: they run by full path. A program the harness runs for itself
  (`git`, `rg`) comes only from the system and read-only folders. Nothing checks for a program planted earlier, by
  someone who may no longer write there, or a repository config in a folder above the project folder that another
  employee may write.

Beyond that, nothing guards a listed folder: OpenCorp mounts it as listed, whatever it holds, and `opencorp doctor`
counts each one as a lint warning.

- Your employee's commands can read everything in a listed folder, and change anything in a writable one, programs
  included.
- If you later run one of those programs yourself, outside the sandbox, a change your employee planted runs as you,
  with full access.

So list no folder that holds secrets, make a folder writable only where your employee must write there, and keep the
folders of tools you run yourself read-only: `~/.cargo` read-only, `~/miniconda3/envs/ml` writable.
