# What `opencorp hq` risks

The fixed texts the owner reads before learning the path to HQ and before saving it, kept out of the flow so the model
can't edit them; the agent's risks specific to the setup follow them. `risks.ts` reads this file: each `##` heading
names a text, each `- ` line is one line of it, and `{name}` is filled in.

## beforeLearning

Shown before every learning run, ahead of asking to use the model. `{dir}` is the hq folder.

- Learning is a chat with OpenCorp, whose agent uses a model: it sees each command its shell runs and what the screen shows, hostnames, your username, paths and job lists, but never what you type at a password prompt.
- The chat starts in auto: read-only commands and short answers to a prompt run at once (a host key's yes, Duo's 1); the rest goes to Auto's check, a model call on your connection, or asks you.
- Press Shift+Tab to switch to default or ask for a careful relearn.
- The agent's shell is sandboxed to your SSH files: {dir}, which holds the model's key or its ChatGPT sign-in, is out of its reach. Where this machine can't sandbox it, you're asked first whether to run it with none.
- If you have a connection open to the cluster, the agent's ssh uses it, with no password prompt, and could end it; otherwise each ssh may ask you to log in.

## beforeSaving

Shown on save_access's card with the two files, before the owner saves. `{persist_s}` is how long a login master of
OpenCorp's stays after its last use, in seconds; `{provider}` and `{auth}` are hq's provider.json and auth.json.

- The script, and `opencorp hq --check` on HQ's machine, run now and on every visit.
- While `opencorp hq` runs, anything running as you on this machine can reuse its SSH connections without Duo. A crash or `kill -9` closes the ones it keeps itself within seconds; only if its watcher dies too (`kill -9` of its process group) do they stay while an HQ tab is open, the login node's for {persist_s} s more. A connection your own ssh config shares (ControlMaster and ControlPath) stays as long as its ControlPersist says, as from your terminal.
- Anything on this machine that can reach the port reaches HQ, though HQ still asks it to sign in (its cookie is SameSite=Strict, and the Host header is checked). So don't run `opencorp hq` on a machine others share, such as a cluster login node: they share 127.0.0.1.
- Each new node HQ runs on asks you to accept its host key; check it the way your cluster documents.
- The saved files record the cluster's layout, and backups copy them.
- {provider} or {auth} holds the model's key or its ChatGPT sign-in.

## LEARN

The answer that starts a learning run.

- Learn it

## LEARN_QUESTION

Asked before learning a first path.

- Learn how to reach HQ from here? This uses the model.

## RELEARN_QUESTION

Asked before learning again in place of a saved path.

- Relearn? This uses the model.

## noSandbox

Shown before learning's shells start with no sandbox, ahead of asking whether to run them anyway; Stop is the
default. `{why}` says why there's none; `{dir}` is the hq folder.

- OpenCorp can't sandbox the agent's shells here: {why}.
- Without a sandbox, each command the agent runs can read and change everything you can: your files, your SSH keys, and the model's key or ChatGPT sign-in in {dir}.
- Then the session's mode is all that stands between the agent and them: in ask mode you approve each command before it runs.

## NO_SANDBOX_QUESTION

Asked after noSandbox.

- Run the agent's shells with no sandbox?

## RUN_UNSANDBOXED

The answer that runs them anyway.

- Run them with no sandbox

## STOP

The answer that starts no shell: the default.

- Stop
