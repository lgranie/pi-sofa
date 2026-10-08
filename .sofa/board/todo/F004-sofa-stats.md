---
id: "F004"
kind: "feature"
check: "npm run check"
review: true
---

# F004 /sofa stats

Judge agents by useful work, and pick models by task shape: show what the factory costs and delivers.

Add `/sofa stats` (and the same text in a `sofa_stats` tool) computed from the board (`readBoard` in `extensions/sofa/board.ts`):
- task counts per column and kind;
- merge rate: merged / (merged + discarded + failed) for features and bugs;
- per level and per agent (`LogRow.agent`): sessions, tokens in/out, cost, with cost per merged task;
- `-` where the cost is unknown (claude records tokens but no cost).

Acceptance:
- The computation is a pure function over `Task[]` with a unit test.
- Listed in `/sofa help` and the README.
- `npm run check` passes.
