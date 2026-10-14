// node --test extensions/sofa/stats.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "./board.ts";
import { computeStats, statsView } from "./stats.ts";

const t = (p: Partial<Task>): Task =>
	({
		title: "t",
		task: "t",
		status: "todo",
		review: false,
		branch: "sofa/X",
		stage: "lead",
		panes: {},
		log: [],
		reports: {},
		...p,
	}) as Task;

const tasks: Task[] = [
	t({ id: "F001", kind: "feature", status: "merged", level: "medium", log: [{ finished: "2026-10-08 10:02", role: "builder", agent: "pi --thinking medium", session: "s-1", input: 1000, output: 200, cost: 0.05 }, { finished: "2026-10-08 10:03", role: "reviewer", agent: "claude --model opus", session: "s-2", input: 500, output: 100 }] }),
	t({ id: "F002", kind: "feature", status: "discarded", level: "low", log: [{ finished: "2026-10-08 10:04", role: "builder", agent: "pi --thinking low", session: "s-3", input: 200, output: 50, cost: 0.01 }] }),
	t({ id: "B001", kind: "bug", status: "failed", level: "high", log: [{ finished: "2026-10-08 10:05", role: "builder", agent: "claude --model opus", session: "s-4", input: 300, output: 60 }] }),
	t({ id: "B002", kind: "bug", status: "merged", level: "high", log: [{ finished: "2026-10-08 10:06", role: "builder", agent: "pi --thinking high", session: "s-5", input: 2000, output: 400, cost: 0.1 }] }),
	t({ id: "R001", kind: "research", status: "done", level: "medium", log: [{ finished: "2026-10-08 10:07", role: "repro", agent: "-", session: "-" }] }),
];

test("computeStats counts tasks per column and kind", () => {
	const s = computeStats(tasks);
	assert.equal(s.total, 5);
	assert.equal(s.counts.merged.feature, 1);
	assert.equal(s.counts.merged.bug, 1);
	assert.equal(s.counts.discarded.feature, 1);
	assert.equal(s.counts.failed.bug, 1);
	assert.equal(s.counts.done.research, 1);
	assert.equal(s.counts.todo.feature, 0);
});

test("computeStats merge rate is merged / merged+discarded+failed for features and bugs", () => {
	const s = computeStats(tasks);
	assert.deepEqual(s.mergeRate.feature, { merged: 1, discarded: 1, failed: 0, rate: 0.5 });
	assert.deepEqual(s.mergeRate.bug, { merged: 1, discarded: 0, failed: 1, rate: 0.5 });
	assert.equal(computeStats([]).mergeRate.feature.rate, undefined);
});

test("computeStats usage per level skips marker rows", () => {
	const s = computeStats(tasks);
	assert.deepEqual(s.byLevel.medium, { sessions: 2, input: 1500, output: 300, cost: 0.05, merged: 1, costPerMerged: 0.05 });
	assert.deepEqual(s.byLevel.low, { sessions: 1, input: 200, output: 50, cost: 0.01, merged: 0, costPerMerged: undefined });
	assert.deepEqual(s.byLevel.high, { sessions: 2, input: 2300, output: 460, cost: 0.1, merged: 1, costPerMerged: 0.1 });
});

test("computeStats usage per agent leaves cost unknown when no session recorded one", () => {
	const s = computeStats(tasks);
	assert.equal(s.byAgent["pi --thinking medium"].sessions, 1);
	assert.equal(s.byAgent["pi --thinking medium"].cost, 0.05);
	assert.equal(s.byAgent["claude --model opus"].sessions, 2);
	assert.equal(s.byAgent["claude --model opus"].input, 800);
	assert.equal(s.byAgent["claude --model opus"].cost, undefined);
	assert.equal(s.byAgent["claude --model opus"].costPerMerged, undefined);
	assert.equal(s.byAgent["claude --model opus"].merged, 1); // F001 merged with a claude session
	assert.deepEqual(s.totals, { sessions: 5, input: 4000, output: 810, cost: 0.16, merged: 2, costPerMerged: 0.08 });
});

test("statsView shows - where the cost is unknown", () => {
	const view = statsView(computeStats(tasks));
	assert.match(view, /Tasks by column and kind:/);
	assert.match(view, /Merge rate/);
	assert.match(view, /Usage by level/);
	assert.match(view, /Usage by agent/);
	assert.match(view, /claude --model opus: 2 sessions, 800 in, 160 out, -, -\/merged \(1 merged\)/);
	assert.match(view, /Totals: 5 sessions, 4000 in, 810 out, \$0\.1600, \$0\.0800\/merged \(2 merged\)/);
	assert.equal(statsView(computeStats([])), "No tasks on the board.");
});
