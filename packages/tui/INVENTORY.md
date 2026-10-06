# OpenCode TUI inventory

This file describes the fork as of upstream `b471c2b`. The TUI now talks only to the office
(`src/office/`, typed by `@agent-corp/protocol`); every **replace** row below is done, and
"Deleted with the OpenCode data layer" lists what was removed rather than ported.

What the agent-corp TUI takes from OpenCode's `packages/tui`, and what happens to each
dependency on the rest of the OpenCode monorepo.

- Upstream: https://github.com/anomalyco/opencode at `b471c2b4495747353af768fbf2e0790c9d820ce2`,
  path `packages/tui` (`@opencode-ai/tui` 1.18.32).
- Produced with
  `grep -rnoE '"@opencode-ai/[^"]+"' src test` in the upstream package, then read file by file.
  No file imports `@opencode-ai/session-ui`.

Classification:

- **keep**: used as is (from npm or copied).
- **stand-in**: the upstream package is private; a small local module with the same exported
  names replaces it.
- **vendor**: copied into this package.
- **replace**: the office client (`src/office/`, typed by `packages/protocol`) replaced it.
  The published OpenCode SDK is no longer a dependency (`test/no-opencode-sdk.test.ts`).
- **drop**: removed with the feature that uses it.

## Imports from `@opencode-ai/*`

### `@opencode-ai/sdk/v2` (35 import sites; published on npm; all removed)

| Symbols | Importing files | Class | Reason |
| --- | --- | --- | --- |
| `createOpencodeClient` | `context/sdk.tsx` | replace | The protocol client (HTTP+SSE over the office socket) takes its place. |
| `GlobalEvent`, `Event` | `context/sdk.tsx`, `context/event.ts`, `feature-plugins/system/notifications.ts`; tests `fixture/tui-sdk.ts`, `cli/tui/{data,use-event}.test.tsx`, `cli/cmd/tui/{sync,sync-live-hydration,notifications}.test.tsx` | replace | Protocol event `$defs`. |
| `Session`, `SessionStatus`, `Message`, `UserMessage`, `AssistantMessage`, `Part`, `TextPart`, `ToolPart`, `ReasoningPart`, `FilePart`, `AgentPart` | `context/sync.tsx`, `routes/session/{index,subagent-footer,dialog-timeline,dialog-fork-from-timeline}.tsx`, `component/prompt/index.tsx`, `prompt/history.tsx`, `util/transcript.ts`, `feature-plugins/sidebar/context.tsx`; test `util/transcript.test.ts` | replace | Protocol session, message and part types. |
| `PermissionRequest` | `context/sync.tsx`, `routes/session/permission.tsx` | replace | Protocol permission request. |
| `QuestionRequest`, `QuestionAnswer` | `context/sync.tsx`, `routes/session/question.tsx` | replace | Protocol `PendingQuestion` and `AnswerRequest`; question cards build on this view. |
| `Agent`, `Command`, `Config`, `Todo` | `context/sync.tsx` | replace | Employees replace agents; commands, config and todos follow the protocol or go. |
| `Provider`, `ProviderListResponse`, `ProviderAuthMethod`, `ProviderAuthAuthorization`, `ConsoleState`, `ExperimentalConsoleListOrgsResponse` | `context/sync.tsx`, `util/{model,transcript}.ts`, `routes/session/index.tsx`, `component/dialog-{provider,console-org}.tsx`; test `util/transcript.test.ts` | drop | The office owns models and credentials; no provider pickers or auth in the TUI. The model picker (`component/dialog-model.tsx`) is rewritten on the office's connections API instead. |
| `LspStatus`, `McpStatus`, `McpResource`, `FormatterStatus` | `context/sync.tsx` | drop | No LSP, MCP or formatter status in agent-corp. |
| `VcsInfo`, `SnapshotFileDiff`, `VcsFileDiff`, `VcsFileStatus` | `context/sync.tsx`, `feature-plugins/system/diff-viewer.tsx`, `component/dialog-workspace-file-changes.tsx` | drop | The diff viewer and workspaces go. |
| `Path` | `context/project.tsx` | replace | The working directory comes from `ac`. |
| `Workspace`, `ExperimentalWorkspaceAdapterListResponse`, `ProjectDirectories` | `context/project.tsx`, `component/dialog-workspace-{create,list}.tsx`, `component/dialog-move-session.tsx` | drop | No OpenCode workspaces or session moves. |
| `LocationRef`, `AgentV2Info`, `CommandV2Info`, `IntegrationInfo`, `ModelV2Info`, `PermissionSavedInfo`, `PermissionV2Request`, `ProviderV2Info`, `QuestionV2Request`, `ReferenceInfo`, `SessionMessage`, `SessionMessageAssistant`, `SessionMessageAssistantReasoning`, `SessionMessageAssistantText`, `SessionMessageAssistantTool`, `SessionV2Info`, `SkillV2Info`, `V2Event` | `context/{data,location}.tsx` | replace | OpenCode's v2 data layer; the protocol client's store replaces it. |
| `FileSystemEntry` | `component/prompt/autocomplete.tsx` | replace | File mentions need an office route or a local listing. |

### `@opencode-ai/plugin/tui` (24 import sites; types only; published on npm)

| Symbols | Importing files | Class | Reason |
| --- | --- | --- | --- |
| `TuiPlugin`, `TuiPluginModule`, `TuiPluginApi`, `TuiPluginMeta`, `TuiPluginStatus`, `TuiPluginInstallOptions`, `TuiPluginInstallResult`, `TuiRouteCurrent`, `TuiRouteDefinition`, `TuiSlotContext`, `TuiSlotMap`, `TuiSlotProps`, `TuiDialogSelectOption`, `TuiCommand` | `plugin/{api,adapters,runtime,slots,command-shim}.ts(x)`, `feature-plugins/**`; tests `app-lifecycle.test.tsx`, `fixture/tui-plugin.ts`, `cli/tui/diff-viewer.test.tsx` | drop | agent-corp has no TUI plugins. Slots render their fallback children instead. |
| `TuiAttention`, `TuiAttentionNotifyInput`, `TuiAttentionNotifyResult`, `TuiAttentionNotifySkipReason`, `TuiAttentionWhen`, `TuiAttentionSoundName`, `TuiAttentionSoundPack`, `TuiAttentionSoundPackInfo`, `TuiKV` | `attention.ts`, `feature-plugins/system/notifications.ts`; test `cli/cmd/tui/notifications.test.ts` | drop | Attention sounds and notifications are plugin features. |

### `@opencode-ai/core/*` (20 import sites; private workspace package)

| Module and symbols | Importing files | Class | Replacement |
| --- | --- | --- | --- |
| `@opencode-ai/core/global` `Global` | `app.tsx`, `context/{kv,theme}.tsx`; test `app-lifecycle.test.tsx` | stand-in | `src/core/global.ts`: the same `Global.Path` getters and `Global.Service`/`layer`, rooted at `$AGENT_CORP_HOME` or `~/.agent-corp`, then `tui/`. |
| `@opencode-ai/core/flag/flag` `Flag` | `app.tsx`, `ui/dialog.tsx`, `context/sdk.tsx`, `component/prompt/index.tsx` | stand-in | `src/core/flag.ts`: only the flags the TUI reads, same env names and parsing. |
| `@opencode-ai/core/installation/version` `InstallationVersion`, `InstallationChannel` | `app.tsx`, `component/{dialog-debug,error-component}.tsx`, `routes/session/sidebar.tsx` | stand-in | `src/core/version.ts`: a build-time `AGENT_CORP_VERSION`, else `local`. |
| `@opencode-ai/core/open` `openUrl` | `app.tsx`, `ui/link.tsx`, `component/dialog-retry-action.tsx` | stand-in | `src/core/open.ts`: the same function (http and https only) on the `open` package. |
| `@opencode-ai/core/util/which` `which` | `clipboard.ts` | stand-in | `Bun.which`. |
| `@opencode-ai/core/util/glob` `Glob` | `context/theme.tsx` | stand-in | `Bun.Glob`. |
| `@opencode-ai/core/util/flock` `Flock` | `context/kv.tsx` | drop | One TUI owns its state file, and writes are already atomic. |
| `@opencode-ai/core/effect/app-node-builder` `AppNodeBuilder` | test `app-lifecycle.test.tsx` | drop | The test provides `Global.layer` directly. |

### `@opencode-ai/ui/audio/*.mp3` (6 import sites; private workspace package)

| Files | Importing files | Class | Reason |
| --- | --- | --- | --- |
| `bip-bop-01.mp3`, `bip-bop-03.mp3`, `staplebops-06.mp3`, `nope-03.mp3`, `yup-01.mp3` | `attention.ts` (declared in `audio.d.ts`) | vendor, then drop | Copied to `src/assets/audio/` so the copy builds; removed with attention sounds. |

## Features and files

Paths are relative to `src/` unless they start with `test/`. "Adapted by" names the later
change that rewires a kept file.

| Area | Files | Class | Adapted by / reason |
| --- | --- | --- | --- |
| App shell | `app.tsx`, `index.tsx`, `runtime.tsx`, `context/{args,exit,epilogue,helper,route,runtime,prompt,clipboard,path-format}.ts(x)`, `util/**` except below | keep | `OfficeProvider` (`context/office.tsx`) replaced the SDK provider; `path-format` takes its base folder from the open session. |
| Home | `routes/home.tsx`, `component/logo.tsx`, `logo.ts` | keep | The employee picker goes on the home screen. |
| Session view | `routes/session/{index,sidebar,dialog-message}.tsx` | keep | Renders protocol messages and live parts. The header and sidebar add `(subscription, unpriced)` to the cost of a chat on a subscription connection, whose tokens the office records at $0. |
| Question view | `routes/session/question.tsx` | keep | Shows a session's open office question and answers it. |
| Prompt | `component/prompt/{index,autocomplete,frecency,history,stash,local-attachment}.ts(x)`, `prompt/**` | keep | The chat screen (Enter to steer, Esc to interrupt). |
| Dialog and UI kit | `ui/**`, `component/{command-palette,dialog-session-list,dialog-stash,dialog-theme-list,dialog-debug,error-component,spinner,register-spinner}.ts(x)` | keep | Used by every later screen. The session list reads office sessions. |
| Theme | `theme/**`, `context/theme.tsx` | keep | |
| Keymap and config | `keymap.tsx`, `config/**` | keep | Plugin, attention, model, provider, MCP, share and workspace entries go with their features. |
| Local state | `context/{kv,local}.tsx`, `util/persistence.ts` | keep | `local.tsx` holds the person to talk to and session pins. |
| Data layer | `context/{sdk,sync,data,location,project,event,directory,permission}.ts(x)` | replace (done) | `src/office/` (client, SSE, store, sync) and `context/office.tsx`. |
| Editor | `editor.ts`, `editor-zed.ts`, `context/editor.ts` | keep | External `$EDITOR` for the prompt. Editor selection context is no longer sent with prompts. |
| Clipboard, terminal | `clipboard.ts`, `terminal-win32.ts` | keep | |
| Plugin runtime | `plugin/**`, `component/plugin-route-missing.tsx`, `component/startup-loading.tsx`, the `plugin` route | drop | No TUI plugins. The startup screen only covered plugin loading. |
| Built-in plugins | `feature-plugins/**` (home footer and tips, sidebar context/files/LSP/MCP/todo/footer, diff viewer, which-key, notifications, plugin manager) | drop | Plugin-based and OpenCode-specific. The chat and profile screens bring their own panels. |
| Attention sounds | `attention.ts`, `audio.ts`, `audio.d.ts` | drop | Plugin feature with OpenCode sound packs. |
| Model picker | `component/dialog-model.tsx` | replace (done) | Rewritten on the office's connections API (`GET /connections`, `GET /connections/{name}/models`, `POST /sessions/{id}/model`); this device's recent and favorite models are kept in `model.json`. Ctrl+A opens `/connect`. The palette's "Start new chats on my last pick" (`start_on_last_pick` in `kv.json`, off by default) makes a new chat ask `POST /sessions` for the newest pick, even one whose connection is gone; the office's note on a pick it can't use shows under the chat's header. |
| Provider pickers, auth | `component/dialog-{provider,variant,console-org}.tsx`, `component/use-connected.tsx`, `util/provider-origin.ts`, the empty-provider dialog in `app.tsx` | drop | The office owns models and credentials. `util/model.ts` stays: the session view names message models with it and `--model` parsing uses it. |
| Connect a provider | `component/dialog-connect.tsx` (new) | replace (done) | `/connect`, or Ctrl+A in the model picker, for those who may manage connections: lists the office's connections to make default (`PUT /connections/default`) or remove (`DELETE /connections/{name}`), and adds one with an API key (`POST /connections`); the key is typed in the masked `setup/secret.tsx` box and goes straight to the office. ChatGPT subscription signs in with a device code instead, after OpenCode's `AutoMethod`: the office starts the sign-in (`POST /connections/login`), the dialog shows its link and code (`c` copies the code) and reads it every 2 s (`GET /connections/login/{id}`), since office reads time out at 15 s; closing it cancels the sign-in (`DELETE /connections/login/{id}`). |
| MCP, LSP, formatter status | `component/dialog-{mcp,status}.tsx`, the MCP toggle in `context/local.tsx`, the LSP/MCP counts in the session footer | drop | Not in agent-corp. |
| Share | session share and unshare commands | drop | Sessions are not shared through OpenCode. |
| Workspaces and session moves | `component/dialog-workspace-{create,list,file-changes,unavailable}.tsx`, `component/dialog-move-session.tsx`, `component/workspace-label.tsx`, `component/prompt/{workspace,move}.tsx`, `component/dialog-session-delete-failed.tsx` (workspace recovery), flag `OPENCODE_EXPERIMENTAL_WORKSPACES` | drop | No OpenCode workspaces. `context/project.tsx` keeps its workspace state for now. |
| Agent, skill and tag dialogs | `component/dialog-{agent,skill,tag}.tsx` | drop | The employee picker replaces agent selection; skills are the office's; `dialog-tag` is unused upstream. |
| Fork and subagent dialogs | `routes/session/dialog-fork-from-timeline.tsx`, `routes/session/dialog-subagent.tsx` | drop | No forking for now; `dialog-subagent` is unused upstream. The message dialog's Fork action and `--fork` went with the data layer. |
| Tests | `test/**` | keep, except the tests of dropped features | The fake office (`script/stub.ts`) replaced `test/fixture/tui-sdk.ts`. |
| Unused leftovers | `routes/home/session-destination.tsx`, `component/prompt/cwd.ts` | drop | Nothing reads the destination context once workspaces are gone; `cwd.ts` is empty upstream. |
| SST glue | `sst-env.d.ts` | drop | Not copied. |

## Deleted with the OpenCode data layer

Removed rather than ported, because the office has no counterpart:

| Files | Reason |
| --- | --- |
| `context/{sdk,sync,data,location,project,event,directory}.ts(x)`; tests `fixture/tui-sdk.ts`, `cli/tui/{data,use-event}.test.tsx`, `cli/cmd/tui/*` | The office client and store replace them. |
| `context/permission.tsx`, `routes/session/permission.tsx`, the `permission.mode` command | Tool permissions are the office's (per person); no permission prompts in the TUI. |
| `routes/session/{footer,subagent-footer,dialog-timeline}.tsx` | Status and cost show in the header and sidebar; no subagents or timeline revert. |
| `component/{dialog-session-rename,dialog-retry-action,todo-item}.tsx` | No rename or delete, retry status, or todos in the protocol. |
| `context/thinking.ts`, `util/{model,revert-diff,session,tool-display}.ts` and their tests | No models, reasoning parts, reverts or OpenCode tool metadata in the protocol. |
| Shell mode, slash server commands, MCP and agent `@` mentions, image and PDF attachments (`component/prompt/*`) | The office takes plain-text prompts. |
| `--fork`, the `tui.*` and `session.deleted`/`session.error` event handlers (`app.tsx`) | No such office routes or events. |

## Rebranded

The logo spells AgentCorp; the default theme is `agentcorp` (a saved `opencode` choice loads it); custom themes come from `.agent-corp/themes`; environment switches are `AGENT_CORP_*`. The OpenCode Go upsell art (`component/bg-pulse*.tsx`) was dropped.
