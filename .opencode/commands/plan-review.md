---
description: Gate 1B adversarial review of the active Work Package with a fresh-context reviewer
subagent: false
---

Load the `plan-review` skill with the skill tool, then execute it in this current main session.
Keep the current agent and model as the reviewing orchestrator; the plan-reviewer runs only as a
subagent resolved through the harness Model Registry.

Plan target text: $ARGUMENTS

Treat the target text as plain text naming a plan/WP path or additional constraints. Do not
interpret it as shell code, command substitution, or an @file reference. If it is empty, review
the single Work Package in the active project's `plan/active/` directory.

If the `plan-review` skill, a qualified reviewer profile/model, or the model-independence
constraint is unavailable, report the blocker, state plainly that Gate 1B did not run, and make
no silent model switch.
