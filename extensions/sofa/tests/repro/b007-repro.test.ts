// B007 repro: B006 merger review findings.
// These tests inspect the ACTUAL source (core/finish.ts, core/workers.ts,
// index.ts) so the fix step makes them pass without rewriting them.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const pipelineSrc = fs.readFileSync(new URL("../../core/pipeline.ts", import.meta.url), "utf8");
const finishSrc = fs.readFileSync(new URL("../../core/finish.ts", import.meta.url), "utf8");
const workersSrc = fs.readFileSync(new URL("../../core/workers.ts", import.meta.url), "utf8");
const indexSrc = fs.readFileSync(new URL("../../index.ts", import.meta.url), "utf8");

function finishBlock(): string {
	const start = finishSrc.indexOf("export async function finish");
	assert.ok(start >= 0, "could not find finish() in finish.ts");
	return finishSrc.slice(start);
}

function askBlock(): string {
	const start = workersSrc.indexOf("async function ask");
	assert.ok(start >= 0, "could not find ask() in workers.ts");
	const end = workersSrc.indexOf("// Stage machine", start);
	return workersSrc.slice(start, end > start ? end : start + 4000);
}

function briefBlock(): string {
	const start = workersSrc.indexOf("const briefParts");
	assert.ok(start >= 0, "could not find briefParts() in workers.ts");
	return workersSrc.slice(start, workersSrc.indexOf("async function ask", start));
}

// 1. MEDIUM — merge verification must prove the branch merged: capture into
// HEAD before the merger, then require ancestor AND HEAD-moved after.
test("B007-1: finish() captures into HEAD before merge and requires ancestor + HEAD-moved", () => {
	const f = finishBlock();
	const askIdx = f.indexOf('ask(t, "merger"');
	assert.ok(askIdx >= 0, "could not find merger ask() in finish()");
	const beforeIdx = f.indexOf("rev-parse");
	assert.ok(beforeIdx >= 0 && beforeIdx < askIdx, "BUG B007-1: finish() does not capture into HEAD (rev-parse) BEFORE prompting the merger worker");
	const afterSlice = f.slice(askIdx);
	assert.ok(afterSlice.includes("is-ancestor"), "BUG B007-1: finish() must require merge-base --is-ancestor after the merge");
	const headMoved = /after\s*===\s*before|before\s*===\s*after|after\s*!==?\s*before|before\s*!==?\s*after/.test(afterSlice);
	assert.ok(headMoved, "BUG B007-1: finish() must compare post-merge into HEAD against the captured pre-merge HEAD (HEAD must have moved)");
});

// 2. MEDIUM — a failing check after the merge must abort: re-run t.check.
test("B007-2: finish() re-runs t.check after the merge and aborts on failure", () => {
	const f = finishBlock();
	const askIdx = f.indexOf('ask(t, "merger"');
	assert.ok(askIdx >= 0, "could not find merger ask() in finish()");
	const afterSlice = f.slice(askIdx);
	assert.ok(afterSlice.includes("run(t.check"), "BUG B007-2: finish() does not re-run t.check after the merge lands");
	assert.ok(afterSlice.includes('merge", "--abort'), "BUG B007-2: finish() must abort the merge when the post-merge check fails");
	assert.ok(/ready.*failed after merge|failed after merge/.test(afterSlice), "BUG B007-2: finish() must restore the task to ready with the check failure");
});

// 3. LOW — idempotent path must close the stale merger pane.
test("B007-3: finish() idempotent path closes the stale merger pane", () => {
	const f = finishBlock();
	const askIdx = f.indexOf('ask(t, "merger"');
	assert.ok(askIdx >= 0, "could not find merger ask() in finish()");
	const idemSlice = f.slice(0, askIdx);
	assert.ok(idemSlice.includes("alreadyMerged"), "precondition: expected alreadyMerged idempotent branch");
	assert.ok(idemSlice.includes("merger") && idemSlice.includes("close"), "BUG B007-3: idempotent (already-merged) branch does not close the stale merger pane via herdr pane close");
});

// 4. LOW — declining the confirm must restore the pre-merge note.
// B008: the "merging …" note is stale by decline time, so the previous
// note is captured before the guard update and restored on decline.
test("B007-4: index.ts decline preserves the existing note", () => {
	const anchor = indexSrc.indexOf('if (action === "merge")');
	assert.ok(anchor >= 0, "could not find merge path in index.ts");
	const end = indexSrc.indexOf("await finish(ctx, t)", anchor);
	assert.ok(end > anchor, "could not find finish() call in index.ts merge path");
	const pre = indexSrc.slice(anchor, end);
	assert.ok(pre.includes("User declined the merge"), "could not find decline path in index.ts merge path");
	const declineIdx = pre.indexOf("User declined the merge");
	const declineSlice = pre.slice(Math.max(0, declineIdx - 300), declineIdx);
	assert.ok(
		/update\(t,\s*"ready",\s*prev/.test(declineSlice) || /const prev = t\.note/.test(pre),
		'BUG B007-4: declining the confirm must restore the previous note (const prev = t.note … update(t, "ready", prev)), not drop it or restore the stale "merging …" note',
	);
});

// 5. LOW — merger brief consolidated: single block, no t.task, no duplicated branches.
test("B007-5: merger brief is a single block without t.task (no duplicated merger branches in ask)", () => {
	const brief = briefBlock();
	const ask = askBlock();
	const mergerIdx = brief.indexOf('role === "merger"');
	assert.ok(mergerIdx >= 0, "could not find merger path in briefParts()");
	const mergerEnd = brief.indexOf("];", mergerIdx);
	assert.ok(mergerEnd > mergerIdx, "could not find end of merger return in briefParts()");
	const mergerSlice = brief.slice(mergerIdx, mergerEnd);
	assert.ok(!mergerSlice.includes("t.task"), `BUG B007-5: briefParts() merger path must not send t.task. Got:\n${mergerSlice}`);
	assert.ok(mergerSlice.includes("followUp"), "BUG B007-5: briefParts() merger path should combine standing orders + mergerFollowUp (followUp) into a single block");
	assert.ok(!ask.includes("isMerger"), "BUG B007-5: ask() still has the duplicated isMerger special case in two branches; consolidate to a single needBrief branch");
});
