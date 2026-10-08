---
id: "F001"
kind: "feature"
check: "npm run check"
review: true
---

# F001 Reproduce-first gate for bug tasks

Bug tasks must prove the bug before fixing it (Kun Chen: "reproduce the bug end to end before fixing it"; requirements and tests are the bottleneck).

In `extensions/sofa/pipeline.ts`, add a `repro` stage for `kind: "bug"` tasks that have a `check`, before the fix:

1. Prompt the builder to add a test (or script) that reproduces the bug, without fixing it.
2. Run `check`: it must FAIL (non-zero). If it passes, re-prompt: "the check passes, so the bug is not reproduced". Up to MAX_ATTEMPTS, then fail the task.
3. Then the existing fix loop: `check` must PASS.

Acceptance:
- `Task["stage"]` gains `"repro"`; resume works from it (same pattern as the other stages).
- Feature and research tasks are unchanged.
- The task log or report says the bug was reproduced (check failed at repro, passed after the fix).
- Unit test for any new pure logic; `npm run check` passes.
