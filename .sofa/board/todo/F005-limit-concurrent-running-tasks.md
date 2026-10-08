---
id: "F005"
kind: "feature"
check: "npm run check"
review: true
---

# F005 Limit concurrent running tasks

Nothing stops the orchestrator from starting ten tasks at once: ten worktrees, tabs and paid agents.

Add an optional `maxRunning` to `sofa-agents.json` (default 3). `start()` in `extensions/sofa/pipeline.ts` refuses to start a task when `maxRunning` tasks are already running or blocked, with a clear message (the task stays in `todo/`). Automatic queueing is out of scope.

Acceptance:
- Validated in `loadAgents()` (positive integer, or absent).
- Shown in `/sofa help`, documented in the README's Customize section.
- `npm run check` passes.
