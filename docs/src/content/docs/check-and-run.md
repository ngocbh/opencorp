---
title: "Check and run"
description: "Check the office with opencorp doctor, and start or restart it."
---

`opencorp doctor` checks the office, its service, the provider, the sandbox, Codex, HQ and the web
app, and says how to fix what it finds. `opencorp start` starts the office if it isn't running;
`opencorp restart` restarts it.

OpenCorp needs Codex 0.167.0 or later. For an older one doctor fails and says to update Codex:
`npm install -g @openai/codex@latest` (or `brew upgrade codex`), then `opencorp doctor`. With Codex
signed in, doctor also starts a thread under an employee's permission and checks that Codex can
use it, without running a model turn.
