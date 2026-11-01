---
name: planning
description: Adversarial main-session planning workflow that produces or revises a Gate 1 Contract-First Work Package. The current session authors the plan; subagents are used for research only.
---

# Planning ("Grill Me" → Work Package)

Runs in the current main session (model chosen by the user). The main session owns every plan
file; workers never author plans or touch product code. No model ids are hardcoded here —
defaults and override tokens live in the harness Subagent Model Registry.

## Preflight

1. Read the governing inputs: the project Tier-1 architecture spec, `plan/ROADMAP.md`,
   `DECISIONS.md` plus the ADR index, the active Work Package if one exists, and AGENTS.md
   Sections 5–6.
2. Verify live assumptions with read-only checks before questioning (project Region resolution,
   AWS credential chain, OSRM/Nominatim reachability, npm/gradle availability) — whatever is
   relevant to the initiative. Record findings; never assume a cloud contract from memory.
3. When repo-wide evidence is needed for a design question, delegate a read-only scout (built-in
   `explore`, registry scout row, model passed explicitly) with a bounded search task. Scouts
   gather facts; they never decide architecture.

## Interrogation loop

- Challenge the premises before writing anything: implicit state dependencies, unhandled failure
  modes, data-integrity windows, concurrency and cleanup ownership, API contract drift, offline
  constraints, and quota/cost impact.
- Ask direct, pointed questions in small batches; get answers before assuming. Do not validate
  the user — stress-test the proposal.
- Refuse to produce boilerplate or code while material ambiguity remains. Every resolved ambiguity
  becomes either a literal contract in the WP or an ADR.
- If the interrogation exposes a decision that changes architecture, record it in `decisions/` and
  `DECISIONS.md` before continuing.

## Output

Author or revise exactly one Tier-3 Work Package at
`docs/projects/<project>/plan/active/WP-XX-<slug>.md` containing:

1. Objective & explicit non-goals.
2. Affected files & interfaces — literal contracts per the Gate 1 checklist in the project
   `WORKING_MODEL.md`: exact interfaces and HTTP status codes, abort/timer/concurrency
   invariants, region/environment resolution rules, boundary validation, UI geometry and browser
   test constraints, and the zero-silent-fallback negatives.
3. Ordered tactical steps, each sized for one bounded worker dispatch.
4. Verification plan — the exact commands that must pass, including this repository's
   `./scripts/ci_check.sh` and `cd route-builder && npm run test:browser` where applicable.
5. Discoveries & Deviations log (empty template) and Next Session Handoff.
6. Definition of Done mirroring the ROADMAP milestone.

Never break milestone N+1 into micro-tasks, and never modify product code during planning.

## Model tokens

`model=` / `fallback=` tokens in the invocation affect scout delegation only. Scout failures are
reported loudly; never substitute a model the user did not pre-authorize in this invocation.

## End

Summarize the WP scope to the user, recommend `/plan-review` as the next step (Gate 1B must pass
before `/implement`), and stop for approval.
