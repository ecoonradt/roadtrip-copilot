# Antigravity Harness Adapter

Scope: how to express AGENTS.md Section 6C in the Antigravity harness.
Antigravity-only. No other harness reads this directory.

## Delegation tool: `invoke_subagent`
Accepts an array of subagents under `Subagents`. Each entry must specify:
* `TypeName` — Subagent type. Use `'self'` for implementation workers (inherits write tools and bash runner) or `'research'` for read-only exploration.
* `Role` — A 2–5 word description of the subagent's role (e.g. `'TypeScript Worker'`, `'Test Suite Author'`). **Required by tool schema.**
* `Prompt` — The complete, self-contained task description. Subagents start with fresh context. Every `flash` worker prompt MUST include:
  1. Exact target file paths and literal TypeScript/Kotlin type signatures.
  2. Explicit concurrency/cleanup invariants (`AbortController` / revision counters on async UI state updates; `try/finally` + socket `close` cleanup for timers/streams).
  3. Negative constraints: never hardcode `'us-east-1'` in regional AWS SDK clients (`new Client(region ? { region } : {})`); zero `any` types; validate user-supplied IDs against allowlists (`400 Bad Request`); preserve existing Playwright browser fixtures (`tests/browser/appHeader.browser.ts`).
* `Model` — Use `'flash'` for worker tasks (enforces project quota optimization). Use `'pro'` or `'inherit'` only when complex architectural reasoning is required.
* `Workspace` — `'inherit'` (default) to share the workspace, or `'branch'` for isolated edits.

## Dynamic Workers: `define_subagent`
If a specialized worker configuration is needed (e.g., custom toolsets or system prompts), use `define_subagent` to register it, then dispatch via `invoke_subagent`.

## Parallelism, Concurrency & Orchestrator Audit
Dispatch independent tasks in parallel within the `Subagents` array (avoid overlapping file edits across concurrent workers). Antigravity handles reactive wakeup automatically—do not poll task status. After workers finish, the orchestrator MUST personally audit `git diff` against the 7-point Adversarial Review Checklist in `WORKING_MODEL.md` and run both `./scripts/ci_check.sh` and `cd route-builder && npm run test:browser`.

## Budget note
Always-on rules share a 20,000-token aggregate budget, and each rule file is capped at 24,000 bytes. Keep this adapter concise.
