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
- **Codex.** An employee who uses the codex harness (`harnesses: [composer, codex]` in their `person.yaml`) can hand
  work to Codex. The line under the prompt counts their Codex sessions. "Open an instrument…" in the command list
  (ctrl+p), or ctrl+x down, opens one as a chat of its own, where you watch Codex work and write to it too; ctrl+x up
  goes back. Codex reads each message with its author and is told your word wins: your employee reads what you told
  Codex with Codex's next answer, and can't interrupt or stop a turn you started. Esc in your employee's chat stops
  your employee and the Codex turn they were waiting on, and so does their run stopping (the cost cap, say); Esc in
  the Codex session stops Codex's turn. A chat has at most four Codex sessions live at once. The chat's mode doesn't
  gate Codex: in `ask` and `default` too, your employee starts and messages Codex with no card, and Codex runs every
  command inside their permission without asking.
- **Claude Code.** An employee who uses the claude harness (`harnesses: [composer, claude]`) can hand work to Claude
  Code the same way: its sessions are counted under the prompt, open with ctrl+x down, and take your messages and
  Esc as a Codex session does. A message you or your employee send while Claude Code works joins its turn once its
  running tool calls finish. A chat has at most four Claude Code sessions live at once, beside its Codex ones. A
  session left idle for five minutes stops Claude Code, and the next message resumes the same conversation; so does
  the next message after Claude Code exits on its own, whose turn is marked interrupted. Claude Code doesn't hold
  commands to a network that's on yet, so an employee whose permission turns it on can't start it.
- **The end.** Ending the session ends its shells and their commands, and its Codex and Claude Code sessions.
  Restarting the office ends those sessions too, and your employee starts new ones.

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
mount the listed folders. Turning the network on (`network: true`) gives the harness's commands your machine's
network, services on localhost and abstract Unix sockets included, which can act as you.

Codex asks you nothing there: every command and file edit runs at once inside that permission, and one it refuses
goes back to Codex. The session's mode doesn't apply. Codex runs as you, with its own sign-in and `~/.codex`, where it
keeps its sessions, logs and caches; your employee's commands can't read it. In your employee's Codex threads your MCP
servers, hooks, `notify`, apps and plugins are off, and so is web search when the network is off, and your
`~/.codex/config.toml` is left as it is. Commands get no `/tmp`, so a tool that writes there fails unless a listed folder
covers it.

Claude Code asks you nothing either: what its permission doesn't allow is refused. It runs as you, with its own
sign-in in `~/.claude` (or the Keychain on macOS), but none of your Claude Code settings files load, nor the project's:
your hooks, plugins, MCP servers, skills, permission rules and default model don't apply there, and auto memory is
off. Only a `/login` sign-in reaches it: an API key in your shell or your settings doesn't. OpenCorp passes it your
`~/.claude/CLAUDE.md` and the project's `CLAUDE.md` (at the folder and at its repository's root, or its `AGENTS.md`
when there's none) as text; an `@` import in them isn't followed. It doesn't take messages from your other Claude Code
sessions, and can't message or list them. Its commands can't see `/tmp`, `/run` or `/dev/shm` (nor `/var/folders` on
macOS), where the sockets of your tmux, ssh-agent and desktop session live.

A project you've trusted in Codex (Codex asks the first time you run it there) loads its own `.codex/config.toml`,
whose MCP servers and hooks would run as you, outside your employee's permission. So your employee's Codex session
won't start in such a project, and says which file it is: untrust the project in `~/.codex/config.toml` (its
`[projects]` entry), or remove that file. `opencorp doctor` lists the trusted projects this applies to.

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
  someone who may no longer write there.
- An employee with a writable folder can change git settings in any project inside it, and those run as you the
  next time you, Codex, Claude Code or another employee use git in that project. So don't list a folder writable if
  it holds git projects.

Beyond that, nothing guards a listed folder: OpenCorp mounts it as listed, whatever it holds, and `opencorp doctor`
counts each one as a lint warning.

- Your employee's commands can read everything in a listed folder, and change anything in a writable one, programs
  included.
- If you later run one of those programs yourself, outside the sandbox, a change your employee planted runs as you,
  with full access.

So list no folder that holds secrets, make a folder writable only where your employee must write there, and keep the
folders of tools you run yourself read-only: `~/.cargo` read-only, `~/miniconda3/envs/ml` writable.
