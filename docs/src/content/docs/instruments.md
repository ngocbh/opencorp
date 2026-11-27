---
title: "Instruments and permissions"
description: "The shell, Codex and Claude Code your employees work with: how you watch them, the mode that decides their tool calls, what they may touch, the MCP servers you allow them, and where that stops."
---

Your employees work with three instruments: a shell, Codex and Claude Code. This page says how you watch and steer
each one, how the mode decides each tool call, what an employee's permission lets it touch, and what that permission
doesn't cover.

## The pane

What you open from the picker (↓ at the end of the prompt) shows in one pane to the right of the chat: a shell, or
a Codex or Claude Code session. It sits in a box in the colour of whoever is at the controls, your employee's while
they work and yours while you type, and its header says so: `@thanh is driving`, with a spinner while the shell or
the harness works, or `you are driving`. The box is bright while the pane has your keys and dim while the chat has
them.

| Key | What it does |
|---|---|
| ctrl+x ← and ctrl+x →, or a click | Move your keys between the chat and the pane, or show a pane that waits |
| ctrl+x ↑, or a click on the × at the box's top-left corner | Close the pane; Esc does too when it takes no typing |
| ctrl+x ↓ | Open the picker again |
| ctrl+x f | Show the pane full screen, or beside the chat again; the next pane opens the same way. On a card for a command in a shell, with no pane open, open that shell beside the card |

Drag the line between the chat and the pane to resize it, or double-click it to go back to half. One width, kept,
serves every pane. Under 108 columns the pane is full screen while it has your keys; without them it waits rather
than cover what you type, and a line in the chat says so (`shell 2 is open in the pane: ctrl+x → shows it`). A pane
never takes your keys while you type in the prompt or a card.

## The mode

Every tool call your employee's model makes goes through the chat's mode and rules before it runs. A chat starts in
`auto`; Shift+Tab switches it to `default`, `ask`, `dontAsk` and back.

| Call | `auto` | `default` | `ask` | `dontAsk` |
|---|---|---|---|---|
| A shell command or typed line | Runs if read-only or a file operation in the project folder; else Auto's check | Runs if read-only; else asks | Asks | As in `auto`, but refused where it would ask |
| File, company, asset and memory tools | Run | Run | Run | Run |
| Starting a Codex or Claude Code session | Runs | Runs | Asks | Runs |
| A tool module's or an MCP server's tool | Auto's check | Asks | Asks | Refused, unless an allow rule covers it |
| A flow granted to your employee | Runs | Runs | Runs | Runs if an allow rule covers each module tool it calls |

- **Rules.** The company's `rules.yaml` and your employee's `people/<handle>/rules.yaml` allow, ask or deny. A rule of
  kind `command` or `input` names shell commands or typed lines (`git status *`). One of kind `tool` names a call by
  where its tool comes from, such as `host codex start`, `mcp github create_issue`, `module crm *` or
  `flow drive_harness`; a last `*` stands for one or more words. Deny rules refuse in every mode, then ask rules ask,
  then allow rules run, then the table decides. A rule names a tool module by its `uses:` alias (`crm` in
  `module crm *`), so the company's lint refuses a module file given two aliases.
- **Auto's check** is a model call on the office's connection. It reads the command, or the tool and its arguments,
  never your employee's reason, with your secrets taken out. What it says run runs; the rest asks you, and `dontAsk`
  refuses it. A command over 1000 bytes asks without it.
- **Cards.** A card shows the call and why it asks. Yes runs it once; "Don't ask again" and "Always allow" also add a
  rule for its exact words; No tells your employee what you wrote. While a card is open, the reply's later calls wait,
  and a No refuses those that would ask too. Esc closes the card and stops your employee, the call not run. Switching
  to `dontAsk` refuses the open cards. An open card survives an office restart, and is decided again by the rules then.
  A call a restart or crash cut off before you approved it isn't run when the work resumes; one cut off after your Yes
  doesn't run again, and your employee reads that its outcome is unknown.
- **Granted flows.** A flow you grant your employee runs with no card or check: granting it approves what its own
  steps do. Your rules still cover the tool modules those steps call (`call:`, `map`, `loop` or a `call(...)` in a
  binding, in the flow and the flows it calls): a deny rule on one refuses the flow in every mode, while an ask rule
  doesn't ask. When OpenCorp can't read which module tools a flow calls, it counts the flow as calling every one. The
  calls the flow's own agents make go through the mode as your employee's do.
- **The record.** Each run's log keeps why each call ran (the rule or form that let it, who said Yes, or Auto's check
  with its own run), what was refused and why, and what your employee read. Each shell's record keeps its commands,
  who ran them and their exits.

## The shell

Your employee runs their commands in a shell sandboxed to the project folder: a command reaches that folder and a
private temp folder, and nothing else of your home or of `~/.opencorp`. Each command starts afresh in the project
folder. A new hire may write the folder and has no network; `harness_policy` in their `people/<handle>/person.yaml`
says so. In a folder they may write, `.git`'s hooks and config and the project config Codex and Claude Code read
(`.codex/`, `.agents/`, `.claude/`, `.mcp.json`) stay read-only, so a command can't plant something that later runs
as you. In a folder with no repository, `.git` stays read-only too: your employee can't start one there, so run
`git init` yourself. On Linux the shell first makes any of those four folders that is missing, empty (`.git` only
while a command runs), and a missing `.mcp.json` can still be created.

- **The mode.** Each command and each line typed into a running command goes through [the mode](#the-mode), decided
  on the whole line: `sca` then `ncel 42` is decided as `scancel 42`. A command runs only as it was decided: if the
  shell moved to another folder, or the line changed, before it runs, your employee is told to run it again.
- **Deny rules.** A deny rule in the company's `rules.yaml` or your employee's `people/<handle>/rules.yaml` refuses
  the commands it matches in every mode, including a line your employee types into a running command. A
  command OpenCorp can't fully read (a `$(…)`, `eval "$CMD"`, `sh -c "$CMD"`, an unclosed quote) could hide one, so
  while any deny rule is in force it never goes to Auto's check: it asks you in every mode, and `dontAsk` refuses it.
  A literal string, as in `sh -c 'git status'`, is judged as the commands in it.
- **Watching.** The line under the prompt counts your employee's shells that run a command, after ↓. Press ↓ at the
  end of the prompt, or click the count, to open the picker in the prompt's place: its Shell tab lists the chat's
  shells, Enter opens one in [the pane](#the-pane), and ctrl+d sends it Ctrl-C. There the shell takes your keys,
  Esc and Ctrl-C included, so Ctrl-C stops its command; one that takes no typing shows your employee's commands as
  `$` lines in their colour. A shell waiting for your password opens itself, with your keys unless you are typing a
  draft or a card is open; then press ctrl+x → to type the password there. Esc in the chat stops your employee and
  the command they were waiting on. A command they were told is still running goes on. A message you send while they
  wait has a grey border until they read it before their next step; Esc stops them, and they read it next, unless ↑
  takes it back into your prompt. One you [queue](/team/#talk-to-your-team) waits for their next turn instead.
- **Typing in their shell.** A line you start in your employee's shell is yours until you finish it: their commands
  and keys wait, and they are told why. The pane's footer says how to give it back,
  `Enter or Ctrl-C (Ctrl-U at the prompt) gives it to @thanh`, and with your keys in the chat, a line there says the
  same. Enter or Ctrl-C works anywhere. For a line typed at the shell's own prompt, with no command running, Ctrl-U
  works too, and so does deleting all you typed, unless you used an arrow, Tab or another editing key on it. Keys you
  type while a command runs that it never reads are dropped when it ends, so none of them runs at the prompt.
- **The picker.** ← and → switch its tabs (Sessions, Shell), ↑ and ↓ move, Enter opens in the pane, and Esc or ↑ on
  the first row closes it. It opens on the first tab with something running. Sessions lists the live sessions,
  running or idle, and Shell the shells that run; ctrl+a shows the rest, and stays as you set it until you quit.
- **Closing a shell.** In the Shell tab, ctrl+d on an idle shell closes it, as your employee's own close does; on a
  running one it stops the command. If the idle shell has output you haven't seen in the pane, OpenCorp asks first.
  Only the chat's approver may close its shells. The shell's record says you closed it, and your employee is told in
  a note from the shell, ``↳ shell 2: closed by @you.``: while they work, they read it before their next step; while
  they rest, it never wakes them, and goes with their next turn (your message or answer, or a note that wakes them).
  ctrl+d leaves an ended shell alone: it is the record of what ran.
- **Waits.** A command's reply waits 5 seconds unless your employee asks for longer (at most two minutes): a quick
  command replies with its output, and a longer one runs on while your employee does other work or ends their reply.
  A message for your employee, yours or a note, ends the wait at once, even one sent while their model was still
  writing the call or while its card was open; the command goes on, and they read the message at their next step. A
  password prompt the command shows right away is in the reply; one it shows after a message ended the wait comes as
  a note from the shell, saying it waits for you to type. A message you queue for their next turn leaves the wait
  alone.
- **When a command ends.** Your employee is told when a command they were told is still running ends, in a note from its
  shell (signed `shell 1`, never by a person): the command, its exit code and its last lines. While they work, they read
  it before their next step; while they rest, it starts a new turn, as a message does. The chat shows it as one line,
  ``↳ shell 1: `make test` ended, exit 2``; click it to read the whole note. After Esc, notes wait, one your employee
  hadn't read yet included, and go with your next message or answer; messages of yours they hadn't read go on, in order.
  Over the cost cap, a note waits for a raise. No note comes for a command your employee stopped, or once the chat has
  ended. If the office restarts while such a command runs, its shell is gone, and your next message tells your employee
  so.

## Tool modules

A company flow may grant its agent a tool module's tools: `uses: {crm: ./crm.ts}`, then `tools: [crm]`. The file must
be inside the company repo. Each call your employee's model makes of them goes through [the mode](#the-mode). A module
runs with your full power ([Where the permission stops](#where-the-permission-stops)), so grant only code you would run
yourself.

- Its top-level code runs at every run start and resume. A tool's argument validator, if it has one, reads the
  model's arguments before the mode and rules decide the call.
- A module loads code only from inside the company repo. An import that resolves outside it, by a path that leaves
  the repo, an absolute path, a symlink out of it or a package from a `node_modules` above it, is refused, and the
  error names the import; one at the module's top keeps the run from starting. So a module can't load `@ngocbh/yian`
  itself: write `import type { ToolOptions } from "@ngocbh/yian/tools"`, which loads nothing. The company's lint
  reports such an import, in the module or a repo file it imports, before any run; it reads only imports written as
  literal paths.
- A module tool that returns `pending()` fails: nothing in the office answers it.

## Codex and Claude Code

An employee's `person.yaml` lists the harnesses they use in `tools`, such as `tools: [yian, codex, claude]`. `yian`
is the employee's own chat, on the Yian engine. They hand work to Codex if `tools` lists codex, and to Claude Code if
it lists claude.

- **Sessions.** The line under the prompt counts their live Codex and Claude Code sessions, running or idle. The
  picker's Sessions tab (↓, or "Open an instrument…" in the command list, ctrl+p) lists them, each marked Running,
  Idle or Ended; Enter opens one in [the pane](#the-pane), where you watch the harness work and write to it too, and
  ctrl+d interrupts its turn. A click on your employee's call to a session in the chat, such as
  `Codex: codex 1 — Fix the parser`, opens that session in the pane too. ↑ past the oldest entry of the session's
  prompt history, or "Go back to the chat" in the command list, gives the chat the keys. An ended session opens
  read-only: the picker takes its prompt's place, and Esc closes it. The session list still opens a session as a chat
  of its own. Only the chat's opener (its company's CEO for a chat nobody opened) writes there besides your employee.
  A chat has at most four live sessions of each harness.
- **Drafts.** Each chat and session keeps its own unsent text, so what you type in one never shows in another.
- **Codex's cards.** What Codex asks you shows as a card in its session and in your employee's chat, above the prompt
  and after the chat's own cards; in the chat it says which session asks (`codex 1 asks`). The card or the prompt has
  your keys, and ctrl+t moves them, to the chat's own card when one waits behind it; a card that opens while you
  answer another waits its turn. If a card closes unanswered while you type into it (Codex stopped waiting, say), the
  rest of your line is dropped until Enter. Esc on the card stops the session's turn.
- **Waits and notes.** Starting a session or sending it a message replies within 5 seconds, unless your employee asks
  to wait longer (at most two minutes), and a message ends the wait as it ends a command's. The harness works on,
  and when a turn your employee was told is still running ends, they get a note from its session (signed `codex 1`
  or `claude 1`): whether the turn completed, was interrupted or failed, and the end of the harness's last message.
  It reaches them, shows in the chat and waits after Esc as a shell's note does. No note comes for a turn whose end
  your employee waited for, or one they interrupted or stopped. If the office restarts before a note reaches your
  employee, your next message carries it, or says the restart stopped the turn.
- **Two speakers.** The session shows who sent each message, its border in the sender's colour, and the pane's header
  says `you are driving` while a turn you started runs. As in the chat, the line under the prompt names who answers:
  the session, its harness and its model, then `as @you`, since you write there as yourself
  (`claude 1 Claude Code · claude-opus-5-5 · as @you`). The harness reads each message with its author and is
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

Codex runs each command in its sandbox through its own program. Codex's own installer (`codex update`, or its
`install.sh`) puts that program in `~/.codex`, which your employee's commands can't read. So the office runs such a
Codex from its own private copy of the install, in `~/.cache/opencorp/codex/` (or `$XDG_CACHE_HOME/opencorp/codex/`):
a few hundred MB, made the first time a session starts on that Codex version, shared by every session after, and put
right by the next session's start if a file of it goes missing. Once you update Codex, a session removes each copy of
an earlier version that no session has started from for a day and none still runs. A Codex installed elsewhere (with
npm or Homebrew, say) runs where it is. Your employee's Codex sessions are refused if that cache folder lies in their
project folder or a folder they list.

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

Claude Code also refuses a command it can't check before it runs, such as one with a `( )` group or a `$(…)`
substitution, or one naming a path outside its working folders: the project folder, the listed folders and the
session's own temp folder (`$TMPDIR`: empty at each start, since OpenCorp keeps nothing of its own there, and gone
with the session). Nobody can approve such a command there. OpenCorp tells Claude Code so, and asks it for plain
commands, scratch files in the project folder or `$TMPDIR`, and plain steps in place of a command it refused. Your
employee and the session's pane see a refusal as one line after the command, in Claude Code's words:
``Claude Code refused `( time make eval )`: A group in parentheses in this command can't be checked before it runs``.

A project you've trusted in Codex (Codex asks the first time you run it there) loads its own `.codex/config.toml`,
whose MCP servers and hooks would run as you, outside your employee's permission. So your employee's Codex session
won't start in such a project, nor take a message once you trust the project while it runs, and says which file it
is: untrust the project in `~/.codex/config.toml` (its `[projects]` entry), or remove that file. `opencorp doctor`
lists the trusted projects this applies to.

- A path is absolute or starts with `~/`, your home. `opencorp doctor` fails on any other, and on `/`, a folder
  listed twice, a path holding `*`, `?`, `[`, `]`, `{` or `}`, a read-only one holding `:`, and one that holds or
  lies in `/tmp/opencorp-<uid>`, where the harnesses keep every session's temp folder (so `/tmp` itself too). The
  harness won't start with such a folder either.
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

- **Where it starts.** A server the harness starts as a program starts in an empty folder of the office's, in
  `~/.opencorp`, never in your employee's project folder, where a launcher such as `npx`, `uvx` or `python` would load
  files they wrote. Your employee's commands can't read that folder.
- **Codex** keeps each allowed server as your `~/.codex/config.toml` (or `CODEX_HOME`'s) defines it, but where it
  starts, and turns every other one off. A project's own `.codex/config.toml` never loads, so allowing a name never
  runs a project's server of that name.
- **Claude Code** gets each allowed server's definition from your user-scope servers (`claude mcp add --scope user`,
  kept in `~/.claude.json`, or in `CLAUDE_CONFIG_DIR`). OpenCorp hands Claude Code only those, in a file in that
  office folder, removed when Claude Code stops; nothing else loads, a project's `.mcp.json` and your local-scope
  servers included. It starts each program through `sh`, which moves to the office's folder first and keeps from it
  the socket and token of the session's inbox, and runs a `headersHelper` the same way. Their tools run without
  asking, as Claude Code asks nobody there.
- **Names.** A name is letters, digits, `-` and `_`, with no `__`, as your harness config names the server. A server
  only one harness defines loads only there.
- **Revoking.** Remove the name and commit: your employee's sessions started earlier drop the server the next time
  their harness starts or resumes, as a server must be allowed both where the session started and now.
- **Your environment.** The harnesses run with few of your shell's variables, so a server that reads a token from
  one (`${GITHUB_TOKEN}`, say) doesn't get it there.

`opencorp doctor` lists each employee's allowed servers and whether Codex and Claude Code define each, and warns when
a harness they use doesn't. Its lint warns about each allowed server.

## Where the permission stops

- **A flow's own steps.** Only the calls your employee's model makes go through the mode. A granted flow's own steps
  run without it: your rules see the module tools they call, but not what a CODE step does in its own code, which
  runs on a worker thread with no sandbox, as you, its imports held to the repo as a module's are. Grant only flows
  you trust.
- **Tool modules run as you.** A module gets nothing from the office through `ctx` (`ctx.context` is `undefined`), but
  it runs on a worker thread with no sandbox, as you: it can read the model connection's environment, the worker's
  channel to the office and everything in `~/.opencorp`. Yian holds what its imports load to the company repo, but
  that guard fixes which files load; it isn't a sandbox. A module can still read a file and `eval` it, start a
  process or a `Worker` whose imports aren't held to the repo, or open a native library (see
  [Imports under a code root](https://yian.readthedocs.io/code-and-tools/#imports-under-a-code-root)). What protects
  you is that only you write the company repo.
- **The harnesses run as you.** Only their commands, and Codex's file edits, are held to your employee's
  permission; those commands can't read the harnesses' own folders. Codex keeps its sign-in, sessions, logs and
  caches in your `~/.codex`. Claude Code keeps its sign-in in `~/.claude` (or the Keychain on macOS), and each
  session's transcript in your `~/.claude/projects`, so `/resume` in your own Claude Code lists your employees'
  sessions in that folder.
- **The mode doesn't apply inside a harness.** Only starting a session asks, and only in `ask` mode. Your employee
  messages Codex and Claude Code with no card, and the harness runs every command inside their permission without
  asking.
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
  folder covers where it writes. You can't list `/tmp` itself ([What an employee may touch](#what-an-employee-may-touch)).
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
