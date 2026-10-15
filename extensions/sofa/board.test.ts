// node --test extensions/sofa/board.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { nextId, readBoard, render, type Task, writeTask } from "./board.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sofa-board-"));

test("nextId: per-prefix 3-digit sequence", () => {
	assert.equal(nextId([], "feature"), "F001");
	assert.equal(nextId([{ id: "F001" }, { id: "F002" }, { id: "B001" }, { id: "" }], "feature"), "F003");
	assert.equal(nextId([{ id: "F001" }], "bug"), "B001");
	assert.equal(nextId([{ id: "F999" }], "feature"), "F1000");
});

test("task round-trips through its task.md with status in front matter, in place", () => {
	const dir = tmp();
	const t: Task = {
		id: "B007",
		kind: "bug",
		title: "Fix crash on empty input",
		task: "Steps:\n1. run with ''\n\n## Acceptance\nno crash",
		status: "running",
		check: "npm test",
		review: true,
		repo: "C:/repo",
		level: "high",
		levelWhy: "jev 91%",
		base: "abc123",
		branch: "sofa/B007",
		stage: "check",
		panes: { builder: "w1:p2" },
		log: [{ finished: "2026-10-08 10:02", role: "builder", agent: "pi --thinking high", session: "s-1", input: 12400, output: 1800, cost: 0.031 }],
		reports: { builder: "# Done\n### Changes\n- fixed" },
	};
	writeTask(dir, t);
	const first = t.file!;
	assert.equal(first, path.join(dir, "B007", "task.md"));
	t.status = "ready";
	writeTask(dir, t);
	assert.equal(t.file, first, "status change stays in place (no moves across column dirs)");
	assert.ok(fs.readFileSync(first, "utf8").includes('status: "ready"'), "status persisted in front matter");
	assert.ok(!fs.existsSync(path.join(dir, "board", "running")), "no board/<column>/ dirs except todo/");

	const [r] = readBoard(dir);
	assert.equal(r.status, "ready");
	for (const k of ["id", "kind", "title", "task", "check", "review", "repo", "level", "levelWhy", "base", "branch", "stage"] as const) assert.deepEqual(r[k], t[k], k);
	assert.deepEqual(r.panes, t.panes);
	assert.deepEqual(r.log, t.log);
	assert.deepEqual(r.reports, t.reports);
});

test("legacy board/<column> files migrate into task dirs with history and reports intact", () => {
	const dir = tmp();
	const t: Task = {
		id: "F001",
		kind: "feature",
		title: "Live task",
		task: "brief",
		status: "ready",
		review: false,
		branch: "sofa/F001",
		stage: "end",
		panes: {},
		log: [{ finished: "2026-10-08 10:02", role: "builder", agent: "pi", session: "s-1", input: undefined, output: undefined, cost: undefined }],
		reports: { builder: "# Done" },
	};
	// Legacy layout: board file under the status column, reports already in the task dir, no status in front matter.
	const legacy = path.join(dir, "board", "ready", "F001-live-task.md");
	fs.mkdirSync(path.dirname(legacy), { recursive: true });
	const { status: _drop, ...legacyTask } = t;
	fs.writeFileSync(legacy, render({ ...legacyTask, status: "ready" } as Task).replace(/^status: .*$\n/m, ""));
	fs.mkdirSync(path.join(dir, "F001"), { recursive: true });
	fs.writeFileSync(path.join(dir, "F001", "builder.report.md"), "# Done");

	const [r] = readBoard(dir);
	assert.equal(r.id, "F001");
	assert.equal(r.status, "ready");
	assert.equal(r.file, path.join(dir, "F001", "task.md"));
	assert.deepEqual(r.reports, { builder: "# Done" });
	assert.deepEqual(r.log, t.log);
	assert.ok(!fs.existsSync(legacy), "legacy column file removed");
	assert.ok(!fs.existsSync(path.join(dir, "board", "ready")), "empty column dir removed");
	assert.ok(fs.existsSync(path.join(dir, "board", "todo")), "todo/ chute survives");
});

test("hand-written todo file without front matter", () => {
	const dir = tmp();
	fs.mkdirSync(path.join(dir, "board", "todo"), { recursive: true });
	fs.writeFileSync(path.join(dir, "board", "todo", "dark mode.md"), "---\nkind: bug\n---\n# Dark mode flickers\n\nIt flickers on load.\n");
	fs.writeFileSync(path.join(dir, "board", "todo", "idea.md"), "# Add export\n");
	const ts = readBoard(dir);
	const bug = ts.find((t) => t.title === "Dark mode flickers")!;
	assert.equal(bug.kind, "bug");
	assert.equal(bug.id, "");
	assert.equal(bug.task, "It flickers on load.");
	const idea = ts.find((t) => t.title === "Add export")!;
	assert.equal(idea.kind, "feature");
	assert.equal(idea.task, "Add export"); // no brief: the title is the brief
});
