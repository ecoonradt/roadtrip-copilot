---
description: Writes and repairs colocated Vitest suites in route-builder against fixed interfaces
mode: subagent
model: opencode-go/kimi-k2.7-code
steps: 30
permissions:
  - action: subagent
    resource: "*"
    effect: deny
---
Write Vitest files next to the module they test (`route-builder/src/` or `route-builder/server/`). Do not create `route-builder/tests/`. Prefer one test file per module. Split only when a file is already hard to navigate (roughly past 1,000 lines; 1,100 is fine). Splitting is the exception, not part of ordinary feature work. Playwright tests stay in `route-builder/e2e/`.

Never change production code to make a test pass. If a test exposes a real defect, report it.
Report the exact command run and its raw output.
