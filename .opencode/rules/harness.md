# OpenCode Harness Adapter

Scope: how to express AGENTS.md Section 6C in the OpenCode harness.
OpenCode-only. Antigravity does not read `.opencode/`.

## Delegation tool: `subagent`
* `agent` — a subagent id. Built-ins: `general` (broad tools; can write files and run shell, but
  CANNOT spawn subagents) and `explore` (read-only search/read).
* `prompt` — the full task. Workers have fresh context but DO inherit AGENTS.md and this file.
  * **Implementation workers (`impl-worker` / `infra-worker` / `test-author` / `review-fix-worker`):**
    Every implementation prompt MUST follow Gate 1 Contract-First rules and the shared prompt shape
    below (exact file paths, literal TypeScript/Kotlin interfaces, HTTP status codes,
    concurrency/cleanup invariants, negative constraints).
  * **Independent reviewers (`diff-reviewer`, Gate 2B) and plan reviewers (`plan-reviewer`,
    Gate 1B):** Short neutral prompts — only the diff/base or plan path, pointers to the
    objective/spec (`WP-XX`) and architectural rules (`AGENTS.md`, `DECISIONS.md`), a unique `tmp/`
    findings path, and read-only/no-nesting boundaries. Never prime with a fix list, earlier
    findings, or an expected-bug checklist.
* `model` — `providerID/modelID`, optional `#variant`. Pass this ONLY when (a) the user supplied an
  explicit `model=` token in this invocation, or (b) dispatching built-in `explore` for scout work
  (pass the registry's scout default explicitly). Otherwise let the profile-bound default apply.
* `background` — `true` to fan out without blocking.
* `sessionID` — pass a returned id to continue the same worker conversation. Never reuse an
  implementation worker's session as a reviewer (or vice versa).

## Subagent Model Registry

Defaults for the OpenCode Go subscription. The **main session model is always the user's manual
choice; nothing here binds it.** No skill may hardcode a model id — resolve roles from this table.

| Role | Profile | Default binding | Sanctioned alternatives | ~5hr cap |
| --- | --- | --- | --- | --- |
| Implementation | `impl-worker` | `opencode-go/gpt-5.6-luna` | `opencode-go/gpt-6-luna`, `opencode-go/kimi-k2.7-code` | 2,050 |
| Infra (CDK) | `infra-worker` | `opencode-go/gpt-5.6-luna` | `opencode-go/gpt-6-luna`, `opencode-go/kimi-k2.7-code` | 2,050 |
| Test authoring | `test-author` | `opencode-go/kimi-k2.7-code` | `opencode-go/deepseek-v4.1-flash` | 1,350 |
| Bounded fixes | `review-fix-worker` | `opencode-go/deepseek-v4.1-flash` | `opencode-go/mimo-v2.6-flash`, `opencode-go/glm-5.3-flash`, `opencode/deepseek-v4.1-flash-free` | 43,330 |
| Independent code review | `diff-reviewer` | `opencode-go/deepseek-v4-pro#max` | `opencode-go/hy4-preview` | 1,050 |
| Adversarial plan review | `plan-reviewer` | `opencode-go/step-5-preview` | `opencode-go/hy4-preview`, `opencode-go/kimi-k3.1-pro` | 1,350 |
| Scout / bulk search | built-in `explore` (no profile binding) | `opencode-go/deepseek-v4.1-flash` | `opencode-go/mimo-v2.6-flash`, `opencode-go/claude-haiku-5-5` | 43,330 |

* **Plan-review row is opt-in:** the `plan-review` skill audits in the main session by default, so
  this row only binds when the user explicitly asks for a truly independent subagent review. Its
  default is not `hy4-preview` because the main authoring session frequently is — surface any
  collision loudly and let the user pick among the sanctioned alternatives instead of switching.
* Do NOT shadow built-ins (`explore`, `general`) with same-id agent files; a Markdown body would
  replace their internal prompts. Pass the scout model explicitly instead.
* Free-tier aliases (`opencode/*-free`) remain available on explicit request via a `model=` token;
  they are no longer the default under subscription.
* Caps are the subscription's rolling 5-hour request estimates — the binding constraint for loops.
* Main-session selection ideas (informational, never auto-applied): a low-cap frontier model
  (`qwen3.8-max`, `kimi-k3.1-pro`, `gemini-4-argon`) for `/planning` interrogation; a high-cap
  runner (`glm-5.2`, `minimax-m3`) for long `/implement` loops.

## Model resolution & override tokens
1. Precedence: explicit user token in this invocation → profile-bound default → registry row (for
   the unbound built-in `explore`). Single-role skills accept `model=<id>`; multi-role invocations
   accept role-qualified forms (`impl-model=`, `infra-model=`, `test-model=`, `fix-model=`,
   `review-model=`, `plan-review-model=`, `scout-model=`). Accepted anywhere in the command arguments.
2. Bare names (e.g. `model=gpt-5.6-luna`) resolve against the available model catalog, preferring
   `opencode-go`. Unknown or ambiguous → fail loud and list candidates. Never guess a model id.
3. **Independence check:** a launched subagent's underlying model MUST differ from the main
   session's underlying model, and an independent reviewer's MUST differ from every implementation
   model used on that same change. Underlying id = catalog id after `provider/`, with `#variant`
   stripped and a trailing `-free` removed. A variant or free/paid alias of the same model is NOT a
   different model. Discover the main model from session metadata; never guess.
4. **Fail loud.** On quota/rate-limit, permission, or launch failure: stop, preserve all partial
   work and findings, report the exact model and raw error, and recommend a `model=<alternative>`
   re-invocation from the sanctioned alternatives list.
5. `fallback=<id>` pre-authorizes exactly ONE substitution for this invocation, usable only after a
   loud failure surfaced to the user, and MUST be logged in the findings/handoff file. Auto-switching
   without a `fallback=` token is a forbidden silent fallback (AGENTS.md rule 12).

## Shared worker prompt shape (Gate 1 Contract-First)

```text
Task: <one-sentence objective, plus how to reproduce it>
Files (only these): <paths>
Required behavior: <literal signatures / status codes / data shapes / migrations>
Invariants: <abort, timers, cleanup, concurrency, region/offline rules>
Do not: <project-specific negatives>, write placeholder bodies, `// TODO` stubs, `...`
         ellipses, or superficial mocks, spawn nested agents, commit, push, deploy,
         run destructive git commands, or make unrelated edits
Tests: add a failing regression first, then run: <exact commands>
Report: files changed, exact commands, raw results, anything unresolved.
```

## Workflow skills
* `/plan` → `planning` skill: adversarial main-session interrogation that produces or revises a
  Gate 1 Contract-First Work Package. The main session authors plans; workers never do.
* `/plan-review` → `plan-review` skill: **executed in the main session.** The invoking session
  keeps its own agent and model as the reviewer; it audits the plan against the sources of truth,
  writes findings to `tmp/`, emits a labeled verdict, and **waits for user triage before editing the
  plan** (skill Phase 1 is read-only). Dispatching the `plan-reviewer` profile is **opt-in only** —
  see the skill's "Optional independent review" section; the registry row above only governs that case.
* `/implement` → `implement` skill: bounded dispatch → implement → Gate 2A personal audit → fix
  loop over the approved Work Package. A task closes only when the optional Gate 2B reviewer emits
  APPROVED **and** the orchestrator's own 8-point audit plus the required suites pass. No worker or
  reviewer self-report is ever sufficient evidence on its own.
* `/review-loop` → `review-loop` skill: explicit review-and-fix loop over an existing delta. Plain
  review requests stay reporting-only; only this explicit invocation authorizes bounded fixes.
* `/kickoff` / `/wrapup` — session start/end rituals for `docs/projects/` initiatives.

## Hard limits
* No nesting, ever. `general` cannot launch subagents, and the worker profiles here also carry
  `permission: subagent -> deny`, so this is enforced rather than merely discouraged.
* A worker's success report is not verification. Perform the Gate 2 8-point Adversarial Diff Audit
  in `WORKING_MODEL.md` and run both `./scripts/ci_check.sh` and
  `cd route-builder && npm run test:browser` yourself.
* Model defaults and fallback chains bind subagents only, never the invoking session, and never
  silently.

## Session rituals
* `/kickoff` — read `DECISIONS.md` and the active Work Package, verify live cloud/SDK assumptions,
  then state scope.
* `/plan` → `/plan-review` — when `plan/active/` is empty or a WP needs authoring/revision; the WP
  must pass Gate 1B before `/implement`.
* `/implement` / `/review-loop` — execute or verify per the registry and gate protocol above.
* `/wrapup` — audit `git diff` against the Adversarial Review Checklist, run the suites, sync
  living docs, update the WP handoff log.
