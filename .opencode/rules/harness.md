# OpenCode Harness Adapter

Scope: how to express AGENTS.md Section 6C in the OpenCode harness.
OpenCode-only. Antigravity does not read `.opencode/`.

## Delegation tool: `subagent`
* `agent` — a subagent id. Built-ins: `general` (broad tools; can write files and run shell, but
  CANNOT spawn subagents) and `explore` (read-only search/read).
* `prompt` — the full task. Workers have fresh context but DO inherit AGENTS.md and this file.
  * **Implementation workers (`impl-worker` / `infra-worker` / `test-author` / `review-fix-worker`):** Every implementation prompt MUST follow Gate 1 Contract-First rules (exact file paths, literal TypeScript/Kotlin interfaces, explicit concurrency/cleanup invariants, and negative constraints).
  * **Independent reviewers (`diff-reviewer`, Gate 2B):** Use a short neutral prompt (diff/base to inspect, objective/spec and architectural-rule pointers, and a unique `tmp/` findings path if writing incremental output). Never prime an independent reviewer with a prior fix list, earlier findings, or a targeted checklist.
* `model` — `providerID/modelID`, optional `#variant`. Prefer the model already bound to a
  configured worker profile instead of naming one inline.
* `background` — `true` to fan out without blocking.
* `sessionID` — pass a returned id to continue the same worker conversation.

## Prefer the configured worker profiles
`.opencode/agents/*.md` binds each role's model, permissions, and step budget. Say
"use the `impl-worker` subagent" rather than naming a model in the prompt.

## Reusable review loop
`/review-loop [target/constraints]` loads the `review-loop` skill in the current main session; it does not select a main agent or model. The main session remains the reviewer/orchestrator and uses the `review-fix-worker` profile, pinned to **DeepSeek V4.1 Flash Free**, only for bounded fixes. Model/capability checks fail closed to reporting-only, including when the main and worker use the same underlying model. See [`.opencode/README.md`](../README.md) for invocation and portability.

## Hard limits
* No nesting, ever. `general` cannot launch subagents, and the worker profiles here also carry
  `permission: subagent -> deny`, so this is enforced rather than merely discouraged.
* A worker's success report is not verification. Perform the Gate 2 8-point Adversarial Diff Audit in `WORKING_MODEL.md` and run both `./scripts/ci_check.sh` and `cd route-builder && npm run test:browser` yourself.

## Session rituals
* `/kickoff` — read `DECISIONS.md` and the active Work Package, verify live cloud/SDK assumptions, then state scope.
* `/wrapup` — audit `git diff` against the Adversarial Review Checklist, run the suites, sync living docs, update the WP handoff log.
