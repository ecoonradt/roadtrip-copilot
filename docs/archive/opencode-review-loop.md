# Reusable OpenCode Review Loop

Status: Completed (2026-10-25). Scope: harness instructions/configuration only; no application changes or cloud deployment. Live invocation guide: [`.opencode/README.md`](../../.opencode/README.md).

## Contract

- Add project skill `review-loop`, command `/review-loop [target/constraints]`, and subagent profile `review-fix-worker`.
- The current main session is the reviewer/orchestrator, regardless of provider/model. Command frontmatter must not set `agent` or `model`; `subagent: false` keeps execution in that session.
- Only fix workers are pinned: `opencode/deepseek-v4.1-flash-free`, `mode: subagent`, `steps: 40`, nesting denied. Discover/verify availability and perform a no-edit launch check before fixes. No silent model fallback. If the current main model is the same underlying model, or identity/capability cannot be confirmed, report findings without automatic fixes until the constraint is resolved.
- Main session reads governing rules/WP/ADRs, confirms PR/base and user changes, personally reviews/reproduces findings, writes bounded Contract-First prompts, audits every worker diff, and runs final verification itself. Iterate through worker regressions until no actionable findings remain; pause/report blockers or non-convergence honestly.
- Preserve project verification requirements, strict test compilation outside production roots, unique scratch findings reports, safe parallel ownership, optional unprimed read-only reviews, and explicit authorization boundaries (no automatic commit/push/deployment).
- Generic review requests and automatic skill loading do not authorize source fixes; explicit loop/fix requests do. Reporting-only constraints always suppress fix delegation.
- Keep skill text portable; provide this repository's verification commands as an explicit specialization. Temporary AWS account limitations are not permanent skill policy.

## Files / Ownership

- Worker: `.opencode/skills/review-loop/SKILL.md`, `.opencode/commands/review-loop.md`, `.opencode/agents/review-fix-worker.md`.
- Orchestrator: this plan, `.opencode/README.md`, `.opencode/rules/harness.md`, and `docs/reference/directory-layout.md`; review all worker output before commit.

## Steps & Verification

- [x] Commit/push the prior verified M4 follow-up (`806cf5b`).
- [x] Verify current OpenCode V2 skill, command, agent and model-selection contracts against official docs.
- [x] Delegate bounded instruction/config creation; audit for model independence, fixed worker identity, fail-closed behavior, convergence and safety.
- [x] Verify OpenCode discovers the skill/command/profile using its read-only API; confirm command has no agent/model override and worker profile has the fixed model/no nesting.
- [x] Launch the configured worker for a no-edit capability check; inspect main session model remains unchanged.
- [x] Run repository verification, sync invocation/layout docs, and archive this completed tactical plan for separately scoped commit/push delivery.

Sources: OpenCode V2 `/docs/skills/`, `/docs/commands/`, `/docs/agents/`; installed CLI reports `v2.1.4`. V2 automatically reloads these project definitions; `/reload` is the documented manual refresh if needed. No global configuration is changed.

## Validation Notes

- OpenCode CLI API calls without `location[directory]` resolve to the service's default location (`/home/eric` here), not necessarily the shell working directory. Validate this project with the documented deep-object location query.
- `/api/command` intentionally returns only command name/description, not model/routing fields. Validate those against parsed Markdown frontmatter and the documented command-selection rules; validate the worker's actual model using registered agent and successful child-session metadata, not self-identification.

## Verified Outcome

- Skill `review-loop`, slash command `review-loop`, and profile `review-fix-worker` are registered for this repository. Parsed frontmatter confirms no main agent/model override and `subagent: false`.
- A no-edit invocation of `review-fix-worker` with **no model override** returned READY. The API confirmed the child session used `opencode/deepseek-v4.1-flash-free`, succeeded, and left the parent session's selected model unchanged. Registered permissions deny child delegation; the worker has a 40-step budget.
- `./scripts/ci_check.sh`: 551 Route Builder tests, 22 CDK tests/synthesis, builds, and Android verification passed. `cd route-builder && npm run test:browser`: 22 passed. `git diff --check` and YAML/frontmatter/registry assertions passed.
- No global OpenCode settings, application code, or cloud resources were changed. Future invocation uses the current main model; temporary model/account limitations are checked at invocation, not hardcoded.
