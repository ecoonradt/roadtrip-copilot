---
name: implement
description: Bounded orchestrator-worker implementation loop over an approved Work Package — dispatch, implement via registry workers, personally audit at Gate 2A, fix, and verify until clean.
---

# Implement

Execute one approved Work Package. The main session orchestrates and audits; every product-code
edit is delegated to registry-bound worker subagents. No model ids are hardcoded here; resolve
them from the harness Subagent Model Registry.

## Preflight

1. Read the active WP, `DECISIONS.md`, and AGENTS.md Section 5. If the WP has not passed
   `/plan-review` (Gate 1B), stop and recommend it first; proceed only on the user's explicit
   waiver, logged in the WP Discoveries section.
2. Snapshot `git status` (staged, unstaged, untracked) and record the base revision. Preserve
   unrelated user work.
3. Resolve per-role models: profile-bound defaults, with `impl-model=` / `infra-model=` /
   `test-model=` / `fix-model=` / `review-model=` / `scout-model=` (or plain `model=`) overrides
   from the invocation, sanctioned alternatives only, and `fallback=` honored exactly as the
   registry rules state. Run the underlying-model independence check against the main session
   before the first dispatch.
4. Verify live external assumptions with read-only checks (Region resolution, credentials,
   upstream reachability) per Gate 1.

## Task queue

- Decompose the WP's tactical steps into atomic tasks sized for a single worker dispatch, each
  with exclusive file ownership and its acceptance criteria quoted from the WP.
- Parallelize only when file sets are disjoint; otherwise run serially. Never hand a worker an
  open-ended task.

## Per-task protocol

1. Dispatch the fitting profile — `impl-worker` (app code), `infra-worker` (`infra/`),
   `test-author` (tests only) — using the shared Gate 1 Contract-First prompt shape from the
   harness rules verbatim, including the anti-placeholder negatives.
2. Personally audit the complete worker diff against the 8-point Adversarial Review Checklist in
   `WORKING_MODEL.md`, including unexpected or untracked files the worker introduced.
3. Rerun the focused tests yourself. Confirm new tests strict-compile and actually execute —
   default builds can exclude test roots.
4. Every confirmed defect → a bounded fix task to `review-fix-worker` with the failing regression
   test and raw output as evidence. Repeat step 2. A worker's or reviewer's self-report is never
   evidence.
5. Where the WP calls for it, dispatch a fresh unprimed `diff-reviewer` (Gate 2B). Its findings
   feed your personal audit; its APPROVED verdict never replaces it.
6. Close the task: check off the WP step, update Discoveries & Handoff. Any technical surprise →
   ADR before the next dispatch.

## Run-level verification

After each task batch, and again before declaring the WP done: `./scripts/ci_check.sh` and
`cd route-builder && npm run test:browser` (or the governing repository's required suites),
run personally with zero `any` and the offline/region guard rules preserved. Distinguish tests
deferred for live cloud access from genuine failures, and say which were not run.

## Stop conditions

A WP is done only when all confirmed findings are closed, the full verification matrix is green
under personal runs, living docs and the WP DoD are updated, and the handoff log reflects the
true state. Stop and report — preserving all partial work — when progress stalls across three
consecutive rounds, a quota/permission/launch failure occurs (report the exact model and raw
error; re-invoke with a sanctioned `model=` alternative unless a pre-authorized `fallback=`
applies), or a user decision is required. Never weaken or delete tests to force green; never
commit, push, deploy, or mutate remotes without explicit authorization.

## Invocation

- `/implement` — execute the active Work Package.
- `/implement steps 1–3 only` — bounded scope.
- `/implement test-model=deepseek-v4.1-flash` — override one role for this run.
