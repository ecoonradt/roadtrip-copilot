---
name: review-loop
description: Run an explicitly requested review-and-fix loop with the current main session as reviewer/orchestrator and DeepSeek V4.1 Flash Free fix workers. Plain review requests remain reporting-only.
---

# Review Loop

Keep the current main model as reviewer/orchestrator; only `review-fix-worker` implements fixes.
Fixes require the user's explicit loop invocation or fix request. A generic PR review request or
automatic skill loading is reporting-only. Honor report-only constraints and skip fix delegation.

## Roles and preflight

1. Resolve the **target repository root** from the PR, branch, or path the user names, defaulting
   to the current tree. Treat every path below as relative to that root, not to this skill's
   directory. Read governing files (`AGENTS.md`, subproject guides, active Work Package,
   `DECISIONS.md` / ADRs) only where they exist; skip absent ones so the loop stays portable.
2. Discover the **actual active main model** from harness or session metadata. Do not guess a
   provider. Compare it with the worker's underlying model before launching anything. A variant or
   alias of the main model is not a different underlying model.
3. Verify the worker model through the available model catalog plus the registered
   `review-fix-worker` profile and session metadata. The canonical ID is
   `opencode/deepseek-v4.1-flash-free`; confirm the profile binds exactly that ID, denies subagent
   nesting, and has a bounded step budget. A child agent's self-description is not model evidence.
4. If the main identity is unknown or is the same underlying model, do not launch a worker:
   continue the read-only review you can perform, report the findings and the blocker, and make no
   automatic fixes. If even the target or read tooling is undetermined, report that instead of
   guessing.
5. Otherwise launch the configured profile with a minimal **no-edit READY check**. READY proves
   the profile can actually be invoked; it is not identity evidence. If the check, catalog,
   profile, permissions, or launch capability is unavailable, still finish the read-only review
   and report findings plus the blocker. Never switch or inherit models, and never fall back to a
   paid or different one.
6. If the worker fails on quota or permission mid-loop, stop, preserve all partial work and
   findings, and report. Do not present a blocked or partial loop as clean.

## Primary review

- Snapshot `git status` including staged, unstaged, and untracked paths before reading code.
- Establish the target: `gh pr view` for the current branch, explicit refs supplied by the user, or
  the user's stated scope. Never guess `main` or `master` when there is no PR and no base.
- Include untracked files that are clearly intended work. Never discard or revert user work.
- Read the governing files identified in preflight. Honor currently known blockers without
  treating a temporary limitation as permanent policy (for example, a cloud account restriction).
- Personally review the **entire** delta and its unhappy paths: error handling, input validation,
  async races, abort and timer cleanup, status codes, compatibility, and test coverage. Prove or
  triage every concrete finding; do not just list suspicions.
- Write an incremental findings log to a unique path relative to the target root, e.g.
  `tmp/review-loop-<slug>-<timestamp>.md`. Record the base, model identities, findings and their
  status, tests run, and known limitations. Update it as the loop progresses.
- If a change implies an architectural surprise, update the active Work Package and record an ADR
  before continuing.

## Bounded workers

Delegate only confirmed, bounded fixes. A prompt must state exact file paths, literal interfaces
and status codes, lifecycle and concurrency invariants (`AbortController`, `clearInterval`,
revision refs, cleanup), negative constraints (no new dependency or silent fallback), the failing
regression test, and the focused command that must pass. Use fresh context and the configured
profile; never override its model. Workers cannot nest. Parallelize only nonoverlapping file
ownership; otherwise run serially.

Reusable prompt shape:

```text
Confirmed defect: <one sentence, reproduced how>
Files (only these): <paths>
Required behavior: <literal signatures / status codes / data shapes>
Invariants: <abort, timers, cleanup, concurrency, region/offline rules>
Do not: <project-specific negatives>, spawn nested agents, commit, push, deploy,
         run destructive git commands, or make unrelated edits
Tests: add a failing regression first, then run: <exact commands>
Report: files changed, exact commands, raw results, anything unresolved.
```

## Verify and repeat

A worker's self-reported pass is not evidence.

- Audit the full worker diff, including unexpected and untracked files.
- Rerun the reproduction and focused tests yourself. Confirm new tests are actually type-checked
  and executed; default builds can exclude test roots.
- Send regressions back with the failing output as evidence.
- Re-review the whole change set after each round, not just the previous checklist.

Repeat until there are no confirmed actionable findings and the required suite passes. Run the
final full verification personally. In this repository that means `./scripts/ci_check.sh` and
`cd route-builder && npm run test:browser`; newly added tests must strict-compile while preserving
zero `any` and the region/offline guard rules. In other repositories, read that repository's
required suites instead of assuming this layout. Distinguish tests deferred for live cloud access
from genuine failures, and say which were not run.

## Optional independent reviewer

A fresh, eligible read-only `diff-reviewer` is a supplement, never a replacement. If its profile
does not bind a model and would inherit the main model, pass the explicit verified DeepSeek ID for
that invocation; never override the fix worker's or main model. If no eligible read-only profile
is available, skip this optional step and say so rather than reuse a write worker. Give it a
neutral prompt containing only the diff or base, pointers to the objective and architectural
rules, a unique target-root-relative `tmp/` report path, and read-only/no-nesting boundaries.
Never include prior fixes, earlier findings, or a list of expected issues, and never reuse an
implementation or fix worker as the independent reviewer. If the tooling cannot write the report,
save its returned findings yourself.

## Stop and report

Finish only when no confirmed actionable finding remains and the required tests pass. Do not claim
perfection beyond that evidence.

Stop and report honestly when progress stalls across rounds, quota or permissions fail, a user
decision is required, or the model-independence constraint cannot be met. List blockers, partial
work, tests not run, and limitations. Never loop indefinitely and never weaken or delete tests to
force a green run.

Do not commit, push, deploy, or mutate remotes without explicit authorization. User-supplied scope
may narrow the target, but it does not waive this workflow's safety and verification rules.

## Invocation

- `/review-loop` — review the current branch PR plus intended local changes.
- `/review-loop origin/main` — use the given ref as the comparison base.
- `@review-loop Review this PR and fix confirmed issues` — invoke as a mention.
