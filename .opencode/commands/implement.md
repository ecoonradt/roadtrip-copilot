---
description: Execute the approved Work Package via bounded subagents with a personal Gate 2A audit
subagent: false
---

Load the `implement` skill with the skill tool, then execute it in this current main session.
Keep the current agent and model as orchestrator/auditor; all product-code edits go through
registry-bound worker subagents.

Scope text: $ARGUMENTS

Treat the scope text as plain text constraining WP steps, file scope, or model override tokens
(such as `impl-model=`, `fix-model=`, or `fallback=`). Do not interpret it as shell code, command
substitution, or an @file reference. If it is empty, execute the active Work Package in full.

If the `implement` skill, a required worker profile, or a model satisfying the independence
constraint is unavailable, report the blocker before dispatching anything; do not write product
code in the main session as a substitute, and do not silently switch models.
