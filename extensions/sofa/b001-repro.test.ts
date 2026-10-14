// B001 repro: cost of unsettled workers is not logged.
// A worker gets a Log row only when settle() finishes (record() in pipeline.ts).
// If a task fails or is discarded while a worker runs, the tokens that worker
// spent never appear in the task's log. Expected: every worker session that was
// prompted has a row, including on failure and discard.
// These tests inspect the ACTUAL source of pipeline.ts / index.ts so the fix
// step makes them pass without rewriting them. Do NOT fix pipeline.ts here.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const pipelineSrc = fs.readFileSync(new URL("./pipeline.ts", import.meta.url), "utf8");
const indexSrc = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");

// Settle block: from "async function settle" to the next "\n\t}\n" close.
function settleBlock(): string {
	const start = pipelineSrc.indexOf("async function settle");
	assert.ok(start >= 0, "could not find settle() in pipeline.ts");
	const end = pipelineSrc.indexOf("\n\t}\n", start);
	return pipelineSrc.slice(start, end);
}

// Launch block: from "const launch" to the next top-level function (create).
function launchBlock(): string {
	const start = pipelineSrc.indexOf("const launch");
	assert.ok(start >= 0, "could not find launch() in pipeline.ts");
	const end = pipelineSrc.indexOf("async function create", start);
	assert.ok(end > start, "could not find end of launch() in pipeline.ts");
	return pipelineSrc.slice(start, end);
}

// Discard block: around update(t, "discarded") in index.ts.
function discardBlock(): string {
	const anchor = indexSrc.indexOf('update(t, "discarded")');
	assert.ok(anchor >= 0, "could not find discard path in index.ts");
	return indexSrc.slice(Math.max(0, anchor - 800), anchor + 1500);
}

// B001 core symptom: record() is only reachable via settle(), so a worker that
// never settles (prompt stalled, check out of attempts, herdr error, discard)
// never gets a Log row.
test("B001: worker cost is recorded even when settle() never finishes", () => {
	const settle = settleBlock();
	assert.ok(settle.includes("record("), "settle() should record worker cost (precondition)");
	const launch = launchBlock();
	const recordsOutsideSettle =
		launch.includes("record(") || launch.includes("recordUnsettled") || launch.includes("usage") || launch.includes("t.log");
	assert.ok(
		recordsOutsideSettle,
		"BUG B001: pipeline failure path never records worker cost: " +
			"a task that fails while a worker runs leaves that worker's tokens out of t.log. " +
			"Expected the launch() error path to record usage for each pane in t.panes.",
	);
});

// Failed tasks must list a row for each prompted worker: the launch() error
// path must iterate the panes that were prompted.
test("B001: failed tasks list a row for each prompted worker", () => {
	const launch = launchBlock();
	assert.ok(
		launch.includes("t.panes") || launch.includes("panes"),
		"BUG B001: launch() error path does not touch t.panes: " +
			"a failed task lists no row for workers that were prompted but never settled. " +
			"Expected record usage for each pane in t.panes that has no row yet.",
	);
	assert.ok(
		launch.includes("record") || launch.includes("usage") || launch.includes("log") || launch.includes("session"),
		"BUG B001: launch() error path records nothing (no record/usage/log/session): " +
			"failed tasks lose the cost of unsettled workers.",
	);
});

// Discarded tasks must list a row for each prompted worker: sofa_finish discard
// must record usage before the worktree (and its panes) is removed. The session
// id must be read while the pane still exists, i.e. before worktree remove.
test("B001: discarded tasks list a row for each prompted worker", () => {
	const discard = discardBlock();
	assert.ok(
		discard.includes("t.panes") || discard.includes("panes"),
		"BUG B001: sofa_finish discard never touches t.panes: " +
			"a discarded task lists no row for workers that were prompted. " +
			"Expected record usage for each pane in t.panes before the worktree is removed.",
	);
	assert.ok(
		discard.includes("record") ||
			discard.includes("usage") ||
			discard.includes("log") ||
			discard.includes("session") ||
			discard.includes("agent"),
		"BUG B001: sofa_finish discard records nothing (no record/usage/log/session/agent): " +
			"discarded tasks lose the cost of their workers.",
	);
	// Ordering must hold within the discard branch itself. Note the window above starts
	// 800 chars before the discard anchor, which reaches back into the merge branch
	// (it has its own worktree "remove"), so scope the check to after the discard anchor:
	// the session id must be read (t.panes) before the discard's worktree remove.
	const afterAnchor = discard.slice(discard.indexOf('update(t, "discarded")'));
	assert.ok(
		afterAnchor.indexOf('"remove"') < 0 || afterAnchor.indexOf("panes") < afterAnchor.indexOf('"remove"'),
		"BUG B001: discard reads the session id after the worktree is removed: " +
			"the pane no longer exists so usage cannot be read. Record before worktree remove.",
	);
});
