---
id: "B001"
kind: "bug"
check: "npm run check"
review: true
---

# B001 Cost of unsettled workers is not logged

A worker gets a Log row only when `settle()` finishes (`record()` in `extensions/sofa/pipeline.ts`). If a task fails or is discarded while a worker runs (prompt stalled, check out of attempts, herdr error, discard), the tokens that worker spent never appear in the task's log.

Expected: every worker session that was prompted has a row, including on failure and discard.

Fix: record usage for each pane in `t.panes` that has no row yet when the pipeline fails (the `launch()` error path) and in `sofa_finish discard` before the worktree is removed. The session id must be read while the pane still exists.

Acceptance:
- Failed and discarded tasks list a row for each prompted worker.
- Reproduce first: a unit test or a scripted scenario showing the missing row before the fix.
- `npm run check` passes.
