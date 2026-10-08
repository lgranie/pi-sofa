---
id: "F002"
kind: "feature"
check: "npm run check"
review: true
---

# F002 Flag changed test files

An agent can make `check` pass by editing the tests it runs. Agent-written tests are weak proof, so changes to existing tests must be visible.

After the commit in the `check` stage (`extensions/sofa/pipeline.ts`), list files the task modified or deleted (not added) since `t.base` that look like tests: `git diff --name-status <base>..HEAD`, filtered on paths matching `test`, `spec` or `__tests__`.

If any:
- set `t.note` to `tests changed: <files>`;
- add a "Changed tests" section to the reviewer's prompt, asking it to judge whether the change weakens the test;
- include the list in the message sent to the orchestrator.

Acceptance:
- Added test files are not flagged; modified or deleted ones are.
- The path-matching logic is a pure function with a unit test.
- `npm run check` passes.
