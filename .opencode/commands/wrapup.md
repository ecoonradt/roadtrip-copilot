---
description: Close a Route Scout Cloud session per the project working model
---
1. Run the verification suites (`./scripts/ci_check.sh` when present, `npm test`).
2. Sync the living docs: AGENTS.md, README.md, route-builder/AGENTS.md, route-builder/README.md,
   docs/README.md — but keep AGENTS.md under 24,000 bytes.
3. Update the active Work Package: check off steps, write "Where We Stopped" and "Next Step".
4. If the Definition of Done is fully satisfied (including live AWS verification), move the WP to
   `plan/archive/` and update `ROADMAP.md`.
