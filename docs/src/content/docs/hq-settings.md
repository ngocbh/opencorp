---
title: "HQ settings"
description: "The keys of hq.json: HQ's web port, the web app's folder and extra origins."
---

HQ, the office's web view, reads `~/.opencorp/office/hq.json` (under `$OPENCORP_HOME` when set) when the office
starts, so run `opencorp restart` after editing it. The file is optional; create it if it doesn't exist. It's a
JSON object with any of these keys:

- `tcp`: whether HQ listens on `http://127.0.0.1:<port>/`; on by default on macOS only. Off, `opencorp hq` prints
  an SSH forward of HQ's socket instead.
- `port`: that port, 49380 by default; 0 picks any free one each start. Set another when something else holds it,
  for example `{"port": 49390}`.
- `app_dir`: where the built web app is; by default the checkout's `packages/app/dist`.
- `dev_origins`: extra origins HQ's API accepts, such as a Vite dev server's `"http://localhost:5173"`.

A file HQ can't read, or one with an unknown key or a bad value, turns the web port off until it's fixed;
`opencorp doctor` says what's wrong with it.
