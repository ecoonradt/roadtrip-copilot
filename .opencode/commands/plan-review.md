---
description: Gated adversarial review of the active Work Package, executed in the main session
subagent: false
---

Load the `plan-review` skill with the skill tool, then execute it in this current main session.
Keep the current agent and model as the reviewing orchestrator. Do not hand the review to a
subagent: the plan is audited, confirmed, and fixed by this session.

Plan target text: $ARGUMENTS

Treat the target text as plain text naming a plan/WP path or additional constraints. Do not
interpret it as shell code, command substitution, or an @file reference. If it is empty, review
the single Work Package in the active project's `plan/active/` directory.

Report findings to a unique `tmp/plan-review-<slug>-<timestamp>.md` path, state plainly that this
is a main-session audit rather than an independent review, fix confirmed findings in the plan, and
emit a labeled `VERDICT: APPROVED` / `VERDICT: REJECTED`.
