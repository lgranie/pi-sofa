// node --test extensions/sofa/tests/board.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { boardView, nextId, readBoard, render, type Task, writeTask } from "../core/board.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sofa-board-"));

test("nextId: per-prefix 3-digit sequence", () => {
	assert.equal(nextId([], "feature"), "F001");
	assert.equal(nextId([{ id: "F001" }, { id: "F002" }, { id: "B001" }, { id: "" }], "feature"), "F003");
	assert.equal(nextId([{ id: "F001" }], "bug"), "B001");
	assert.equal(nextId([{ id: "F999" }], "feature"), "F1000");
});

test("task round-trips through board/<column>/<id>/task.md; status change moves the dir with its sidecars", () => {
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
	assert.equal(first, path.join(dir, "board", "running", "B007", "task.md"));
	assert.ok(!fs.readFileSync(first, "utf8").match(/^status: /m), "no status in front matter (the column is the status)");
	// A sidecar travels with the task on status change.
	fs.writeFileSync(path.join(dir, "board", "running", "B007", "builder.md"), "role prompt");
	t.status = "ready";
	writeTask(dir, t);
	const moved = path.join(dir, "board", "ready", "B007", "task.md");
	assert.equal(t.file, moved);
	assert.ok(!fs.existsSync(path.join(dir, "board", "running", "B007")), "old task dir gone");
	assert.ok(fs.existsSync(path.join(dir, "board", "ready", "B007", "builder.md")), "sidecar traveled");
	assert.ok(fs.existsSync(path.join(dir, "board", "ready", "B007", "builder.report.md")), "report written next to task.md");

	const [r] = readBoard(dir);
	assert.equal(r.status, "ready");
	for (const k of ["id", "kind", "title", "task", "check", "review", "repo", "level", "levelWhy", "base", "branch", "stage"] as const) assert.deepEqual(r[k], t[k], k);
	assert.deepEqual(r.panes, t.panes);
	assert.deepEqual(r.log, t.log);
	assert.deepEqual(r.reports, t.reports);
});

test("legacy loose board/<column> files migrate into task dirs with history, reports and prompts intact", () => {
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
	// Legacy layout: loose board file under the status column, sidecars in a top-level dir.
	const legacy = path.join(dir, "board", "ready", "F001-live-task.md");
	fs.mkdirSync(path.dirname(legacy), { recursive: true });
	fs.writeFileSync(legacy, render(t));
	fs.mkdirSync(path.join(dir, "F001"), { recursive: true });
	fs.writeFileSync(path.join(dir, "F001", "builder.report.md"), "# Done");
	fs.writeFileSync(path.join(dir, "F001", "builder.md"), "role prompt");

	const [r] = readBoard(dir);
	assert.equal(r.id, "F001");
	assert.equal(r.status, "ready");
	assert.equal(r.file, path.join(dir, "board", "ready", "F001", "task.md"));
	assert.deepEqual(r.reports, { builder: "# Done" });
	assert.deepEqual(r.log, t.log);
	assert.ok(!fs.existsSync(legacy), "legacy column file removed");
	assert.ok(fs.existsSync(path.join(dir, "board", "ready", "F001", "builder.md")), "prompt moved next to task.md");
	assert.ok(!fs.existsSync(path.join(dir, "F001")), "top-level sidecar dir removed");
});

test("todo chute is dir-only: todo/<name>/task.md without front matter", () => {
	const dir = tmp();
	fs.mkdirSync(path.join(dir, "board", "todo", "dark-mode"), { recursive: true });
	fs.writeFileSync(path.join(dir, "board", "todo", "dark-mode", "task.md"), "---\nkind: bug\n---\n# Dark mode flickers\n\nIt flickers on load.\n");
	fs.mkdirSync(path.join(dir, "board", "todo", "export-idea"), { recursive: true });
	fs.writeFileSync(path.join(dir, "board", "todo", "export-idea", "task.md"), "# Add export\n");
	const ts = readBoard(dir);
	const bug = ts.find((t) => t.title === "Dark mode flickers")!;
	assert.equal(bug.kind, "bug");
	assert.equal(bug.id, "");
	assert.equal(bug.status, "todo");
	assert.equal(bug.task, "It flickers on load.");
	const idea = ts.find((t) => t.title === "Add export")!;
	assert.equal(idea.kind, "feature");
	assert.equal(idea.task, "Add export"); // no brief: the title is the brief
});

test("boardView sorts tasks within a column by date desc (latest log finished first)", () => {
	const t = (id: string, finished?: string): Task => ({
		id,
		kind: "feature",
		title: `task ${id}`,
		task: "brief",
		status: "ready",
		review: false,
		branch: `sofa/${id}`,
		stage: "end",
		panes: {},
		log: finished ? [{ finished, role: "builder", agent: "pi", session: "s" }] : [],
		reports: {},
	});
	const view = boardView([t("F001", "2026-10-08 10:02"), t("F003", "2026-10-10 09:00"), t("F002", "2026-10-09 12:00"), t("F004"), t("F005", "2026-10-09 12:00")]);
	const ids = view
		.split("\n")
		.filter((l) => l.startsWith("  "))
		.map((l) => l.trim().split(" ")[0]);
	assert.deepEqual(ids, ["F003", "F005", "F002", "F001", "F004"]);
});

test("todo chute: loose .md files become todo/<stem>/task.md dirs", () => {
	const dir = tmp();
	fs.mkdirSync(path.join(dir, "board", "todo"), { recursive: true });
	fs.writeFileSync(path.join(dir, "board", "todo", "idea.md"), "# Add export\n");
	const ts = readBoard(dir);
	assert.equal(ts.length, 1);
	assert.equal(ts[0].title, "Add export");
	assert.equal(ts[0].file, path.join(dir, "board", "todo", "idea", "task.md"));
	assert.ok(!fs.existsSync(path.join(dir, "board", "todo", "idea.md")), "loose file moved into dir");
});
