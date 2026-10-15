// B002 repro: resume leaves an idle worker tab.
//
// ask() in core/workers.ts stores the pane in t.panes[role] only after the
// worker starts and right before prompting. If pi stops between
// startWorker() opening the tab and the prompt, the pane is never recorded.
// On sofa_resume a second tab is opened and the first stays behind, idle.
//
// These tests execute the ACTUAL code (board round-trip + workers source)
// so the fix step makes them pass without rewriting them.
// Do NOT fix core/workers.ts / core/board.ts here.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { readBoard, type Task, writeTask } from "../../core/board.ts";

const src = fs.readFileSync(new URL("../../core/pipeline.ts", import.meta.url), "utf8");
const workersSrc = fs.readFileSync(new URL("../../core/workers.ts", import.meta.url), "utf8");
const boardSrc = fs.readFileSync(new URL("../../core/board.ts", import.meta.url), "utf8");

function bodyOf(name: string, argsPattern: string): string {
	const re = new RegExp(`async function ${name}\\(${argsPattern}\\)[\\s\\S]*?\\n\\}`);
	const m = workersSrc.match(re);
	assert.ok(m, `could not extract ${name} from workers.ts`);
	return m[0];
}

// B002-1: the pane must be recorded inside startWorker, right after the tab
// is created — not only later in ask() right before prompting. Otherwise a
// stop between tab creation (herdr tab create) and the prompt loses the pane
// and resume opens a second tab, leaving the first idle.
test("B002: startWorker records the new pane so a stop before prompt loses nothing", () => {
	const body = bodyOf("startWorker", "[^)]*");
	assert.ok(
		body.includes("t.panes[role]") || body.includes("t.panes =") || body.includes("panes[role]"),
		`startWorker never records t.panes[role]: a crash between tab creation and the prompt in ask() orphans the tab. startWorker body:\n${body}`,
	);
});

// B002-2: the fix tracks whether the recorded worker was prompted
// (e.g. t.panes[role] plus t.prompted[role]) so resume can reuse an alive
// but unprompted worker instead of opening a second tab.
test("B002: pipeline tracks whether the recorded worker was prompted", () => {
	assert.ok(
		src.includes("t.prompted") || src.includes("prompted[role]"),
		"factory has no t.prompted tracking: resume cannot tell an alive-but-unprompted worker from a missing one and opens a second tab",
	);
	assert.ok(
		/prompted\??:/.test(boardSrc),
		"board.ts has no prompted field: the prompted flag would not survive a restart/task-file reload",
	);
});

// B002-3: task files written before the fix (no prompted field) still load
// with a safe default, otherwise resume after upgrade crashes or misbehaves.
test("B002: task files without the prompted field load with a safe default", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofa-b002-"));
	const t: Task = {
		id: "B002",
		kind: "bug",
		title: "Idle worker tab",
		task: "repro",
		status: "running",
		check: "npm run check",
		review: false,
		repo: "/repo",
		base: "abc123",
		branch: "sofa/B002",
		stage: "lead",
		panes: { builder: "w1:p1" },
		log: [],
		reports: {},
	} as Task;
	writeTask(dir, t);
	const [r] = readBoard(dir);
	assert.deepEqual(
		(r as unknown as Record<string, unknown>).prompted,
		{},
		`old task file without prompted field did not default safely (got ${JSON.stringify((r as unknown as Record<string, unknown>).prompted)})`,
	);
});
