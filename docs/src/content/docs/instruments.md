---
title: "Instruments and permissions"
description: "The shell, Codex and Claude Code your employees work with: how you watch them, what they may touch, the MCP servers you allow them, and where that stops."
---

Your employees work with three instruments: a shell, Codex and Claude Code. This page says how you watch and steer
each one, what an employee's permission lets it touch, and what that permission doesn't cover.

## The shell

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
- **Watching.** The line under the prompt counts your employee's shells. Press ctrl+x o to open one and watch it;
  Ctrl-C there stops its command. Esc stops your employee and the command they were waiting on. A command they were
  told is still running goes on, and they read its output later.

## Codex and Claude Code

An employee hands work to Codex if their `person.yaml` lists the codex harness (`harnesses: [composer, codex]`), and
to Claude Code if it lists claude.

- **Sessions.** The line under the prompt counts their Codex and Claude Code sessions. "Open an instrument…" in the
  command list (ctrl+p), or ctrl+x down, opens one as a chat of its own, where you watch the harness work and write
  to it too; ctrl+x up goes back. Only the chat's opener (its company's CEO for a chat nobody opened) writes there
  besides your employee. A chat has at most four live sessions of each harness.
- **Two speakers.** The session shows who sent each message, and the harness reads each one with its author and is
  told your word wins: your employee reads what you told it with its next answer, and can't interrupt or stop a turn
  you started. A message you or your employee send while Claude Code works joins its turn once its running tool calls
  finish.
- **Esc.** Esc in your employee's chat stops your employee and the harness turn they were waiting on, and so does their
  run stopping (the cost cap, say); Esc in the session stops the harness's turn. Either Esc on a Codex turn also stops
  the commands that turn started and hadn't finished, which would otherwise go on after it; one an earlier turn left
  running goes on until the session ends. Either Esc on a Claude Code turn stops the command it runs (Claude Code runs
  none in the background there) and cancels every message it hasn't started, so none of them runs after.
- **Idle and the end.** A Claude Code session left idle for five minutes stops Claude Code, and the next message
  resumes the same conversation; so does the next message after Claude Code exits on its own, whose turn is marked
  interrupted. Ending the chat ends its shells, their commands and its harness sessions.
- **Restarting the office.** Restarting the office stops its harness sessions but keeps them, each listed as it was:
  your employee still reads each one's record by its name, and the next message to it, theirs or yours in the
  session, continues the same Codex thread or Claude Code conversation, through every check a new session's start
  makes. Until then it shows idle and doesn't count toward the four. A turn the restart cut off is marked interrupted, naming who started it, and nothing reruns
  it. A new session never takes an old one's name. A Codex session the restart caught before its first turn ran can't
  be continued, so your employee starts another.

### The SOP that drives a harness

Every new company has an SOP for handing a task to a harness, `shared/flows/drive_harness.yaml`. OpenCorp doesn't
start SOPs yet; the flow is there to read, reuse and list in an employee's `sops:`. It takes the task, which says
where in the chat's folder to work, and the harness (`codex` or `claude`). Your employee starts one session of that
harness, follows it, checks its work, sends it what is missing, then stops the session and reports. Messages sent to
its run steer them, and an interrupt stops them and the harness turn they wait on.

A resumed run never repeats a start or a message: a call a crash cut off comes back as one whose outcome is unknown,
and your employee reads the session's record before acting again. After the office restarts, a resumed run finds its
session by name and its next message continues it, so the work goes on where it stopped.
`opencorp doctor` warns about an employee who lists the SOP in `sops:` but uses neither harness.

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
folder, a private temp folder and the listed folders, each with exactly the access listed. The shell doesn't mount
the listed folders.

**Codex** asks you nothing: every command and file edit runs at once inside that permission, and one it refuses goes
back to Codex. In your employee's Codex threads your hooks, `notify`, apps and plugins are off, and so are your MCP
servers but those you [allow them](#mcp-servers), and so is web search when the network is off. Your
`~/.codex/config.toml` is left as it is. An MCP server you add while a session runs would start at its next turn, so
the session takes no message until you remove it or start a new session, which turns it off; one you allow them that
Codex reaches by URL is fine.

**Claude Code** asks you nothing either: what its permission doesn't allow is refused. Its only tools are its file
tools, Bash and ToolSearch: none that acts on your claude.ai account (routines, Claude Design, push notifications),
reaches outside its sandbox or runs on after the turn. A Claude Code that offers more is stopped before it uses them.
Neither your Claude Code settings nor the project's load: your hooks, plugins, skills, permission rules and default
model don't apply there, nor any MCP server but those you [allow them](#mcp-servers), and auto memory, background
sessions and agent view are off. Only a `/login` sign-in
reaches it: an API key in your shell or your settings doesn't. OpenCorp passes it your `~/.claude/CLAUDE.md` and the
project's `CLAUDE.md` (at the folder and at its repository's root, or its `AGENTS.md` when there's none) as text; an `@`
import in them isn't followed. It doesn't take messages from your other Claude Code sessions, and can't message or list
them. Claude Code doesn't hold commands to a network that's on, so an employee whose permission turns it on can't start
it. On Linux its sandbox fails every command in a folder your employee may only read, so an employee whose
`harness_policy` keeps the folder read-only can't start it either: make it `workspace-write`, or have them use Codex.
`opencorp doctor` names them.

A project you've trusted in Codex (Codex asks the first time you run it there) loads its own `.codex/config.toml`,
whose MCP servers and hooks would run as you, outside your employee's permission. So your employee's Codex session
won't start in such a project, nor take a message once you trust the project while it runs, and says which file it
is: untrust the project in `~/.codex/config.toml` (its `[projects]` entry), or remove that file. `opencorp doctor`
lists the trusted projects this applies to.

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

## MCP servers

Your employees' Codex and Claude Code load none of your MCP servers unless you allow them, by name, in
`harness_policy`:

```yaml
harness_policy:
  sandbox: workspace-write
  mcp_servers: [github]      # your servers they may use; none by default
```

**An allowed server runs as you, outside your employee's folder fence.** The harness starts it with your
credentials, and nothing holds it to their permission: allowing `github` lets your employee do whatever your GitHub
token can.

- **Codex** keeps each allowed server as your `~/.codex/config.toml` (or `CODEX_HOME`'s) defines it, and turns every
  other one off. A project's own `.codex/config.toml` never loads, so allowing a name never runs a project's server
  of that name.
- **Claude Code** gets each allowed server's definition from your user-scope servers (`claude mcp add --scope user`,
  kept in `~/.claude.json`, or in `CLAUDE_CONFIG_DIR`). OpenCorp hands Claude Code only those, in a file your
  employee's commands can't read, removed when Claude Code stops; nothing else loads, a project's `.mcp.json` and your
  local-scope servers included. Their tools run without asking, as Claude Code asks nobody there.
- **Names.** A name is letters, digits, `-` and `_`, as your harness config names the server. A server only one
  harness defines loads only there.
- **Your environment.** The harnesses run with few of your shell's variables, so a server that reads a token from
  one (`${GITHUB_TOKEN}`, say) doesn't get it there.

`opencorp doctor` lists each employee's allowed servers and whether Codex and Claude Code define each, and warns when
a harness they use doesn't. Its lint warns about each allowed server.

## Where the permission stops

- **The harnesses run as you.** Only their commands, and Codex's file edits, are held to your employee's
  permission; those commands can't read the harnesses' own folders. Codex keeps its sign-in, sessions, logs and
  caches in your `~/.codex`. Claude Code keeps its sign-in in `~/.claude` (or the Keychain on macOS), and each
  session's transcript in your `~/.claude/projects`, so `/resume` in your own Claude Code lists your employees'
  sessions in that folder.
- **The mode doesn't apply inside a harness.** In `ask` and `default` too, your employee starts and messages Codex and
  Claude Code with no card, and the harness runs every command inside their permission without asking.
- **Claude Code's reads are a deny list.** Its commands can't read your home, `~/.opencorp` or the folders where your
  sockets live, but they can read the rest of the disk, such as `/opt` or another drive. Its own file tools are held
  by Claude Code's permission rules, not by the operating system.
- **Claude Code still loads** managed settings (an administrator's), `~/.claude.json` and its built-in mods, so what
  they turn on applies to your employees' sessions too.
- **Allowed MCP servers** run as you, outside the fence ([MCP servers](#mcp-servers)).
- **Unix sockets.** Claude Code's commands can't see `/tmp`, `/run` or `/dev/shm` (nor `/var/folders` on macOS),
  where the sockets of your tmux, ssh-agent and desktop session live. Whether its Linux sandbox also blocks
  connecting to a socket elsewhere is unchecked.
- **The network.** On, Codex's commands get your machine's network: services on localhost and abstract Unix sockets,
  which can act as you, your LAN, and a cloud machine's metadata endpoint. Claude Code won't start with the network
  on. Off, commands get none, and the harness still reaches its own model.
- **No `/tmp`.** Commands get only their own temp folder, so a tool that writes to `/tmp` fails unless a listed
  folder covers it.
- **Project config.** Only the `.codex/`, `.agents/` and `.claude/` at the top of the project folder and its
  repository's root are read-only; ones in folders below aren't.
- **Placeholders on Linux.** Codex's sandbox holds a missing `.claude` or `.mcp.json` read-only by mounting an empty
  file there (a missing `.codex`, `.agents` or `.git`, an empty folder). So `git status` in your employee's Codex
  session lists `.claude` and `.mcp.json` as untracked though they aren't in your project; `.git` is read-only there,
  so nothing can commit them. On your side the empty files exist only while one of their commands runs, and go when
  it ends: don't `git add -A` in the project then.
- **The sandbox must run.** Each harness holds the permission with its own sandbox: bubblewrap in a user namespace on
  Linux, Seatbelt on macOS. Claude Code doesn't start without it ([Check and run](/check-and-run/)). On Linux its
  sandbox also needs `socat`, which it runs inside: the office gives it the one it found when it started, as it is in a
  system folder, or else through a link in a folder of the session's own that its commands can't change, first on their
  `PATH`, with that socat's folder and the folders its libraries load from readable to them. A socat that doesn't run,
  or that loads from a folder your employee or anyone else could change, isn't used. On macOS, how either sandbox holds
  an employee's permission is unchecked.
