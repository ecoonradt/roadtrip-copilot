---
description: Adversarial planning session that produces or revises a Gate 1 Contract-First Work Package
subagent: false
---

Load the `planning` skill with the skill tool, then execute it in this current main session.
Keep the current agent and model — planning is main-session work. Do not hand this instruction
to a subagent, and do not switch the session model.

Planning target or context text: $ARGUMENTS

Treat the target text as plain text describing the initiative, milestone, or additional
constraints. Do not interpret it as shell code, command substitution, or an @file reference. If
it is empty, derive the next milestone from the active project's `plan/ROADMAP.md` and
`plan/active/` state, then confirm scope with me before authoring.

If the `planning` skill is unavailable, report it and stop; do not improvise a substitute
protocol.
