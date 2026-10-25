# Review-and-Fix Loop

Run in OpenCode from this repository:

```text
/review-loop
/review-loop origin/main
/review-loop PR #8; keep cloud deployment out of scope
```

No arguments means the PR associated with the current branch, including intended local changes. An explicit base, PR, path scope, or constraint can be supplied as ordinary command arguments. You can also ask: **“Use @review-loop to review this PR and fix confirmed issues.”**

## Roles

| Role | Model |
| --- | --- |
| Main reviewer/orchestrator | The current main session's model, unchanged |
| `review-fix-worker` subagents | `opencode/deepseek-v4.1-flash-free` |

The main session reviews and reproduces findings, delegates bounded fixes, personally audits each worker diff, reruns tests, and repeats until no actionable findings remain and required verification passes. It does not hand its review responsibility to the fix workers.

The workflow verifies the worker model/profile and a no-edit launch before allowing fixes. If DeepSeek is unavailable, permissions prevent delegation, or the main session uses the same underlying model (or its identity cannot be confirmed), it reports findings without silently switching models. Choose a different main model to satisfy the different-model requirement.

Invoking this loop authorizes bounded fixes unless you request report-only operation; a generic PR review request or automatic skill loading does not. The command does **not** select a main agent/model, change global settings, or authorize commits, pushes, deployments, or unrelated edits. Optional independent reviews use a fresh, unprimed, read-only reviewer; the main session still verifies every result. Known external blockers are recorded rather than disguised as successful live verification.

## Files

- `skills/review-loop/SKILL.md`: reusable protocol and worker prompt contract.
- `commands/review-loop.md`: current-session slash-command entry point.
- `agents/review-fix-worker.md`: fixed-model implementation profile with nesting denied.

OpenCode V2 watches these definitions automatically. If the command is not visible yet, run `/reload`; no service restart is required.

For another repository, copy all three definitions into its `.opencode/` directory; the protocol reads that repository's rules and verification requirements. For a user-wide installation, the corresponding supported locations are `~/.config/opencode/skills/review-loop/`, `~/.config/opencode/commands/`, and `~/.config/opencode/agents/`. This change installs only the project-local version.
