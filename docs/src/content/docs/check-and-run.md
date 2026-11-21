---
title: "Check and run"
description: "Check the office with opencorp doctor, and start or restart it."
---

`opencorp doctor` checks the office, its service, the provider, the sandbox, Codex, Claude Code, HQ
and the web app, and says how to fix what it finds. `opencorp start` starts the office if it isn't running;
`opencorp restart` restarts it.

OpenCorp needs Codex 0.167.0 or later. For an older one doctor fails and says to update Codex:
`npm install -g @openai/codex@latest` (or `brew upgrade codex`), then `opencorp doctor`. With Codex
signed in, doctor also starts a thread under an employee's permission and checks that Codex can
use it, without running a model turn. It warns about each project you trust in Codex whose own
`.codex/config.toml` Codex would load: your employees' Codex sessions won't start there.

OpenCorp needs Claude Code 2.1.325 or later. For an older one doctor fails and says to update it:
`claude update` (or `brew upgrade claude-code`, or
`npm install -g @anthropic-ai/claude-code@latest`), then `opencorp doctor`. Doctor also starts
Claude Code as an employee's session starts it, under their permission, and reads its sign-in,
without sending it a message. Signed out is a warning: run `claude` and sign in with `/login`.
Claude Code runs only inside its own sandbox, so doctor fails when that sandbox can't start; on
Linux, install `bubblewrap` and `socat`.
