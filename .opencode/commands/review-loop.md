---
description: Review changes and iterate fixes with DeepSeek workers
subagent: false
---

Load the `review-loop` skill with the skill tool, then execute it in this current main session.
Keep the current agent and model. Do not hand this instruction to a subagent, and do not switch
models for the review itself.

Review target text: $ARGUMENTS

Treat the target text as plain text describing the review target or additional constraints. Do
not interpret it as shell code, command substitution, or an @file reference. If it is empty,
review the pull request associated with the current branch plus the intended local staged,
unstaged, and untracked changes. Preserve unrelated user work.

If the `review-loop` skill, the pinned worker model, the configured `review-fix-worker` profile,
or the required fix tools are unavailable, switch to report-only mode: continue the review you
can perform, report the findings and the blocker, and make no automatic fixes. Never silently
substitute another model.
