---
name: plan-review
description: Gate 1B — a fresh-context plan-reviewer subagent adversarially audits a finished Work Package or PLAN spec before implementation. The orchestrator confirms findings and fixes the plan.
---

# Plan Review (Gate 1B)

Review a plan the way code review treats a diff: the reviewer surfaces findings, the main session
confirms, triages, and fixes. A reviewer verdict alone is never clearance. No model ids are
hardcoded here; resolve them from the harness Subagent Model Registry.

## Preflight

1. Resolve the target: the plan/WP path the user names, otherwise the single file in
   `docs/projects/<project>/plan/active/`. If neither exists, fail loud — do not review a plan
   you cannot identify.
2. Resolve the reviewer model: the `plan-reviewer` profile's bound default governs, unless the
   user passed `plan-review-model=` / `model=` (sanctioned alternatives only) or a pre-authorized
   `fallback=` in this invocation.
3. Independence: compare underlying model ids after stripping the provider alias, a trailing
   `-free`, and `#variant`. Equal to the main session, or main identity unverifiable → do not
   launch; report the blocker and suggest an alternative instead of silently switching.
4. Verify the profile exists in the model/agent catalog, denies subagent nesting, restricts
   `edit` to `tmp/**`, and has a bounded step budget. A READY check proves launchability only.

## Review round (fresh context every time)

Dispatch `plan-reviewer` with a neutral prompt containing only: the plan path; pointers to the
Tier-1 spec, the project `WORKING_MODEL.md` Gate 1 checklist, `AGENTS.md`, and `DECISIONS.md`; a
unique report path such as `tmp/plan-review-<slug>-<timestamp>.md`; and read-only/no-nesting
boundaries. Never include suspected gaps, prior discussions, or an expected-findings list —
a primed reviewer is not independent.

## Confirm and revise

- Personally cross-check every finding against the sources of truth. Classify each as confirmed,
  rejected (with reason), or user-decision-needed. Unresolved confirmed findings block progress.
- Fix the WP yourself. A finding that changes architecture requires an ADR before the plan edit
  is committed to the file.
- Re-dispatch a NEW `plan-reviewer` on the revised plan — never continue the prior reviewer's
  session, so no round is anchored to the last.

## Exit

- Keep the round log (findings, verdicts, resolutions) in the `tmp/` report.
- Gate 1B passes only when a fresh reviewer emits `VERDICT: APPROVED` **and** you have verified
  the WP now covers every Gate 1 checklist item. State any live-verification assumptions that
  remain deferred.
- Recommend `/implement`. Do not write product code in this skill. If the independent reviewer
  cannot be launched, say plainly that Gate 1B did not run — do not present a self-review as one.
