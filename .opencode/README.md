# OpenCode Workflow Skills — Roadtrip Co-Pilot

A gated orchestrator-worker pipeline implementing AGENTS.md Section 6C on the OpenCode Go
subscription. **The main session is always the orchestrator and reviewer; subagents do the
bounded implementation work.** The main session's model is always your manual choice — model
defaults in this project bind subagents only.

## Pipeline

```text
/plan  →  /plan-review  →  /implement  →  /review-loop (pre-PR)  →  /wrapup
```

| Command | Role of the main session | Subagents launched |
| --- | --- | --- |
| `/plan [initiative]` | Adversarial architect: grills you, then authors/revises the Gate 1 Contract-First Work Package | Scouts (`explore`) for research only |
| `/plan-review [WP path]` | Confirms findings and fixes the plan | `plan-reviewer` (Gate 1B, fresh + unprimed each round) |
| `/implement [scope]` | Dispatches, personally runs the Gate 2A diff audit, re-runs tests | `impl-worker` / `infra-worker` / `test-author` / `review-fix-worker`, optional `diff-reviewer` (Gate 2B) |
| `/review-loop [base/PR]` | Reviews the delta and reproduces findings | `review-fix-worker` for bounded fixes, optional `diff-reviewer` |

A task closes only when the optional Gate 2B reviewer emits APPROVED **and** the orchestrator's
own audit plus `./scripts/ci_check.sh` and `npm run test:browser` pass. No worker or reviewer
self-report is ever sufficient evidence. Plain review requests stay reporting-only; only
`/review-loop` (or an explicit fix request) authorizes bounded fixes.

## Model registry

Defaults live in exactly one place — the **Subagent Model Registry** in
`rules/harness.md`. Edit the table there to retune; no skill or command hardcodes a model id.

| Subagent role | Default | Sanctioned alternatives |
| --- | --- | --- |
| `impl-worker`, `infra-worker` | `opencode-go/gpt-5.6-luna` | `gpt-6-luna`, `kimi-k2.7-code` |
| `test-author` | `opencode-go/kimi-k2.7-code` | `deepseek-v4.1-flash` |
| `review-fix-worker` | `opencode-go/deepseek-v4.1-flash` | `mimo-v2.6-flash`, `glm-5.3-flash`, free-tier alias |
| `diff-reviewer` | `opencode-go/deepseek-v4-pro#max` | `hy4-preview` |
| `plan-reviewer` | `opencode-go/hy4-preview` | `step-5-preview`, `kimi-k3.1-pro` |
| Scout (built-in `explore`) | `opencode-go/deepseek-v4.1-flash` (passed explicitly) | `mimo-v2.6-flash`, `claude-haiku-5-5` |

## Overriding a model

Any of the four commands accepts ordinary argument text plus these tokens:

```text
/implement
/implement steps 1–3 only
/implement fix-model=gpt-5.6-luna
/plan-review plan-review-model=kimi-k3.1-pro
/review-loop origin/main; model=mimo-v2.6-flash
```

- `model=<id>` sets the worker model for single-role skills; role-qualified forms
  (`impl-model=`, `infra-model=`, `test-model=`, `fix-model=`, `review-model=`,
  `plan-review-model=`, `scout-model=`) target one role in multi-role loops. Bare names resolve
  against the model catalog; unknown or ambiguous → fail loud with candidates.
- **Independence:** a worker's underlying model must differ from the main session's (variants,
  `-free` aliases, and provider mirrors count as the same model). On conflict the skill reports
  the blocker instead of launching — choose a different main model or pass a different `model=`.
- `fallback=<id>` pre-authorizes exactly one substitution, usable only **after** a loud,
  reported failure and logged in the findings file. Auto-switching without a token is a
  forbidden silent fallback (AGENTS.md rule 12).

## Files

- `rules/harness.md`: delegation mechanics, Subagent Model Registry, override grammar, shared
  Contract-First worker prompt shape. Auto-loaded into every session, including workers.
- `skills/{planning,plan-review,implement,review-loop}/SKILL.md`: the four reusable protocols.
- `commands/{plan,plan-review,implement,review-loop}.md`: current-session slash-command entries.
- `agents/*.md`: subagent profiles carrying role prompts, `model:` defaults, step budgets, and
  `subagent -> deny` nesting protection; reviewers additionally deny `edit` except `tmp/**`.

OpenCode watches these definitions automatically; run `/reload` if a command is not visible yet.
Nothing needs a service restart.

## Portability

Copy `.opencode/` (agents, commands, skills, rules) into another repository; the protocols read
that repository's own rules and required suites instead of assuming this layout. The registry's
model ids are OpenCode Go subscription names — retune the table for a different provider mix.
For a user-wide install: `~/.config/opencode/{agents,commands,skills}/` and global config
instructions for `rules/harness.md`.
