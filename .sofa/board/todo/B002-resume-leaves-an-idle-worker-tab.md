---
id: "B002"
kind: "bug"
check: "npm run check"
review: true
---

# B002 Resume leaves an idle worker tab

`ask()` in `extensions/sofa/pipeline.ts` stores the pane in `t.panes[role]` only after the worker starts and right before prompting. If pi stops between `startWorker()` opening the tab and the prompt, the pane is never recorded. On `sofa_resume`, a second tab is opened and the first stays behind, idle, in the worktree's herdr workspace.

Expected: resume reuses the started worker, or closes it.

Fix suggestion: record the pane right after the tab is created, with a flag saying whether it was prompted (e.g. `t.panes[role]` plus `t.prompted[role]`). On resume, an alive but unprompted worker gets the brief instead of a new tab being opened.

Acceptance:
- Resume never leaves two tabs for one role.
- Task files written before the change still load (missing fields default safely).
- `npm run check` passes.
