---
title: "Create the company"
description: "Run opencorp init to pick a model, describe your company and set up this machine's office."
---

`opencorp init` creates your company. The [installer](/get-started/) offers this. Otherwise, run
`opencorp init` from a project folder, since init opens the TUI there when it's done:

```console
$ mkdir -p ~/projects/demo && cd ~/projects/demo
$ opencorp init
```

The office won't work in your home folder or a folder that holds it, in the opencorp checkout, or
inside a sensitive home folder; it refuses those with "use a project folder". If you ran init in
one, quit, `cd` into a project folder and run `opencorp`.

init takes five steps:

1. Model: pick the provider (anthropic by default) and give its key, or leave it empty to use
   yian's own login. For OpenAI you can sign in to your ChatGPT subscription instead: init shows a
   link and a code to enter in a browser on any device, and keeps the sign-in in
   `office/connections/office.auth.json`. The model is checked before it's saved, and the key or
   sign-in stays in the office, readable only by you.
2. Company: tell the model about yourself, the company and your first AI teammate, then answer
   "Create this company?".
3. Password: it logs in your new devices.
4. Remote: the git remote for the company's repo, or "None for now".
5. This machine: installs the office as a service (launchd on macOS, systemd on Linux, otherwise
   tmux or a background process) and adds this device.

The flags `--company`, `--name`, `--handle`, `--title`, `--agent`, `--agent-handle`, `--remote` and
`--service` answer questions up front. A key is never a flag.
