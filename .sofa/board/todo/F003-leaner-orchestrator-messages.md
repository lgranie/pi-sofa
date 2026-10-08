---
id: "F003"
kind: "feature"
check: "npm run check"
review: true
---

# F003 Leaner orchestrator messages

`notify()` in `extensions/sofa/pipeline.ts` pastes every role report (up to 6000 characters each) into the orchestrator's conversation, which grows its context with every task (context rot).

Send instead:
- the status line (`line(t)`);
- the board file path;
- for each report, its first line, or a `Summary:` line if the report has one, plus the report file path (`.sofa/<id>/<role>.report.md`);
- the error text in full when the task failed (it is short and needed to act).

Update the role prompts in `sofa-agents.json` to start each report with a one-line `Summary:`.

Acceptance:
- A finished task's message stays under about 1,000 characters, apart from failure details.
- The orchestrator can still read full reports from the linked files.
- `npm run check` passes.
