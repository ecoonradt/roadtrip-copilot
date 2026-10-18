# OpenCode Harness Adapter

Scope: how to express AGENTS.md Section 6C in the OpenCode harness.
OpenCode-only. Antigravity does not read `.opencode/`.

## Delegation tool: `subagent`
* `agent` — a subagent id. Built-ins: `general` (broad tools; can write files and run shell, but
  CANNOT spawn subagents) and `explore` (read-only search/read).
* `prompt` — the full task. Workers have fresh context but DO inherit AGENTS.md and this file.
* `model` — `providerID/modelID`, optional `#variant`. Prefer the model already bound to a
  configured worker profile instead of naming one inline.
* `background` — `true` to fan out without blocking.
* `sessionID` — pass a returned id to continue the same worker conversation.

## Prefer the configured worker profiles
`.opencode/agents/*.md` binds each role's model, permissions, and step budget. Say
"use the `impl-worker` subagent" rather than naming a model in the prompt.

## Hard limits
* No nesting, ever. `general` cannot launch subagents, and the worker profiles here also carry
  `permission: subagent -> deny`, so this is enforced rather than merely discouraged.
* A worker's success report is not verification. Re-run the suite yourself.

## Session rituals
* `/kickoff` — read `DECISIONS.md` and the active Work Package, then state scope.
* `/wrapup` — run the suites, sync living docs, update the WP handoff log.
