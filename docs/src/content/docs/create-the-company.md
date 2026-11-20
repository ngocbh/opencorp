---
title: "Create the company"
description: "Run opencorp init to pick a model, describe your company and set up this machine's office."
---

`opencorp init` creates your company. The [installer](/get-started/) offers this. Otherwise, run
`opencorp init` from a project folder, since init opens the TUI there when it's done:

```sh
mkdir -p ~/projects/demo && cd ~/projects/demo
opencorp init
```

The office won't work in your home folder or a folder that holds it, in the opencorp checkout, or
inside a sensitive home folder; it refuses those with "use a project folder". If you ran init in
one, quit, `cd` into a project folder and run `opencorp`.

init takes five steps. It asks the first three on the terminal:

1. Model: pick the provider (anthropic by default) and give its key, or leave it empty to use
   yian's own login. For OpenAI you can sign in to your ChatGPT subscription instead: init shows a
   link and a code to enter in a browser on any device, and keeps the sign-in in
   `office/connections/office.auth.json`. The model is checked before it's saved, and the key or
   sign-in stays in the office, readable only by you. A model kept from an earlier run is checked
   again; if it doesn't answer, choose "Try again" or "Set up the model again".
2. Password: it logs in your new devices.
3. Remote: the git remote for the company's repo, or "None for now".
4. Company: a chat with OpenCorp in the TUI. Tell it about yourself, the company and your first AI
   teammates. It shows the company on a card: "Yes, create it" creates it, or type what to change.
5. This machine: installs the office as a service (launchd on macOS, systemd on Linux, otherwise
   tmux or a background process) and adds this device. There's nothing to answer.

Leaving the chat (Ctrl+C twice) stops init, and nothing is created. If the model fails in the
chat, init says why and stops; the next `opencorp init` checks the model first.

Where the TUI can't draw (no terminal, or `TERM=dumb`), there's no chat: init shows the company
made from your flags and defaults and asks "Create this company?".

The flags `--company`, `--name`, `--handle`, `--title`, `--agent`, `--agent-handle`, `--remote` and
`--service` answer questions up front. A key is never a flag. With `--provider-stdin`, init reads
the model from stdin and asks nothing.
