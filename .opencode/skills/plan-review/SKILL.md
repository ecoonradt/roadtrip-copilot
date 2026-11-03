---
name: plan-review
description: Gated adversarial review of a Work Package or plan spec before implementation. Executed by the current main session (the orchestrator keeps its own agent and model); findings are confirmed and the plan is fixed in place.
---

# Plan Review (Gated Plan Audit)

Review a plan the way code review treats a diff: audit it adversarially against its sources of
truth, then report findings and wait for the user to triage before changing anything.

**This skill runs in the current main session.** The session that invokes it keeps its own agent
and model; nothing is delegated by default. Do not launch a `plan-reviewer` subagent unless the
user explicitly asks for an independent review in this invocation (see "Optional independent
review" below). This keeps the user's manual model choice binding — the plan-review work happens
with the model they already selected.

## Phase 1 — Report only (default; stop here)

**READ-ONLY:** do not edit the plan file or any other repo file in this phase. Deliver a findings
report in `tmp/` plus a chat summary, then stop and wait.

1. Resolve the target: the plan/WP path the user names, otherwise the single file in
   `docs/projects/<project>/plan/active/`. If neither exists, fail loud — do not review a plan
   you cannot identify.
2. Read the target in full, plus the governing sources: the Tier-1 spec, the project
   `WORKING_MODEL.md` Gate 1 checklist, `AGENTS.md`, and `DECISIONS.md`/ADRs referenced by the
   plan.
3. **Verify the plan's claims against the live code.** Paths, env vars, class and function names,
   status codes, and existing helpers named in the plan must be checked in the repo. A finding
   asserts "X exists"; a plan that names something absent is a finding in itself.
4. Emit a labeled `VERDICT: APPROVED` / `VERDICT: REJECTED` and **stop**. Wait for the user to
   triage (confirm, reject, or add findings) before editing anything. State plainly in the report
   and in chat that this is a **main-session audit** — not an independent third-party review — and
   therefore carries no independence guarantee.

## Phase 2 — Fix only after explicit alignment

Only after the user responds to the Phase 1 report: apply the confirmed findings, skip any the
user rejected, and ask about anything flagged as user-decision-needed. Keep edits scoped to exactly
the agreed items; raise a new ADR before committing a plan edit that changes architecture. Then
re-run the Phase 1 audit over the revised plan and emit a fresh verdict. **User silence is not
alignment** — if findings were surfaced and no triage came back, the review stays at Phase 1.

## Review round

Audit the plan and report, in severity order with section/file references:

1. **Contract gaps:** missing or non-literal interfaces, route schemas, HTTP status codes, data
   shapes — anything a bounded worker would have to guess.
2. **Concurrency & lifecycle holes:** un-stated abort handling, timer/listener cleanup,
   stale-state guards, flush/double-count semantics, iteration caps.
3. **Failure-mode omissions:** unhandled error paths, silent fallbacks, missing IAM grants,
   region/environment assumptions, first-run/bootstrap behavior.
4. **Rule violations:** offline drive-loop constraints, strict-TypeScript policy, distraction
   limits, prompt purity, $0-idle cost discipline, "no hardcoded region fallback" rules (and
   whether legitimate global-service endpoints are called out as explicit exceptions), directory
   -layout and living-doc obligations.
5. **Decomposition defects:** open-ended or unbounded worker tasks, premature micro-tasks for
   future milestones, acceptance criteria that cannot be mechanically verified.

Write findings to a unique report path such as `tmp/plan-review-<slug>-<timestamp>.md`. Note which
assumptions you verified as correct — a review that only lists defects hides the spot-checks that
passed.

## Confirm and revise (Phase 2 continuation)

- Cross-check every finding against the sources of truth before acting. Classify each as
  confirmed, rejected (with reason), or user-decision-needed. Unresolved confirmed findings block
  progress.
- Fix the WP in place (without appending "amendment" narratives) — the same session both finds and
  fixes, so state that explicitly.
- Reserve ADRs strictly for lasting system-architecture changes (with user alignment), never for
  specification tightenings or module-level details, and keep ADRs/permanent docs free of
  step/gate/milestone references (AGENTS.md Rule 13).
- Record the round (findings, verdict, resolutions) in the `tmp/` report.

## Exit

- Emit `VERDICT: APPROVED` or `VERDICT: REJECTED` with a one-line justification, labeled as a
  main-session verdict.
- Approval passes the gate only when every Gate 1 checklist item is verifiably covered by the
  revised plan. State any live-verification assumptions that remain deferred.
- Recommend `/implement`. Do not write product code in this skill.

## Optional independent review

Only when the user explicitly requests it: dispatch a `plan-reviewer` subagent with a **neutral**
prompt — plan path, pointers to the Tier-1 spec, `WORKING_MODEL.md` Gate 1 checklist, `AGENTS.md`,
`DECISIONS.md`, and a unique `tmp/` findings path, plus read-only/no-nesting boundaries. Never
prime it with suspected gaps or an expected-findings list. Model resolution follows the harness
Subagent Model Registry; the reviewer's underlying model must differ from the plan author's, so if
the registry default equals the current session's model, surface that collision loudly and let the
user choose among the sanctioned alternatives rather than switching silently.
