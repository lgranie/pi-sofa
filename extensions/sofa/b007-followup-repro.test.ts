// B007 follow-up repro: remaining gaps in finish() vs the B007 spec.
// These tests inspect the ACTUAL source (pipeline.ts) and FAIL against the
// current code, demonstrating the bugs. Do NOT fix the source here — the fix
// comes later, in a separate step.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const pipelineSrc = fs.readFileSync(new URL("./pipeline.ts", import.meta.url), "utf8");

function finishBlock(): string {
	const start = pipelineSrc.indexOf("async function finish");
	assert.ok(start >= 0, "could not find finish() in pipeline.ts");
	return pipelineSrc.slice(start, pipelineSrc.indexOf("return { s, save", start));
}

// Finding 1 requires: "capture `into`'s HEAD (and the branch tip) BEFORE
// prompting the merger worker". The current code captures only `into` HEAD
// (`before`); the branch tip is never recorded, so a worker that moves the
// branch ref (rebase) cannot be detected and the stricter second-parent
// check has nothing captured to compare against.
test("B007-F1: finish() captures the branch tip BEFORE prompting the merger worker", () => {
	const f = finishBlock();
	const askIdx = f.indexOf('ask(t, "merger"');
	assert.ok(askIdx >= 0, "could not find merger ask() in finish()");
	const preSlice = f.slice(0, askIdx);
	// The branch tip must be captured by its own rev-parse of the branch ref
	// in the same git call (a bare `t.branch` elsewhere, e.g. the pre-merge
	// is-ancestor check, plus an unrelated `rev-parse into` does NOT count).
	const capturesBranchTip =
		/rev-parse[^;(\n]*t\.branch|t\.branch[^;(\n]*rev-parse/.test(preSlice) || /branchTip/.test(preSlice);
	assert.ok(
		capturesBranchTip,
		"BUG: finish() never captures the branch tip (e.g. `git rev-parse <branch>`) BEFORE prompting the merger worker. " +
			"Only `into` HEAD (`before`) is recorded, so a merger that rebases/moves the branch ref goes undetected. " +
			"Expected the branch tip to be recorded before ask() alongside `into` HEAD.",
	);
});

// If the merger worker itself fails (ask throws) after starting a merge with
// conflicts, the repo is left in MERGING state, but the catch only resets the
// task to ready without `git merge --abort`. The next finish() retry then runs
// `git merge` while a merge is still in progress ("you have not concluded
// your merge") instead of starting clean.
test("B007-F2: finish() aborts an in-progress merge when the merger worker fails", () => {
	const f = finishBlock();
	const askIdx = f.indexOf('ask(t, "merger"');
	assert.ok(askIdx >= 0, "could not find merger ask() in finish()");
	const recheckIdx = f.indexOf('--show-current', askIdx);
	assert.ok(recheckIdx > askIdx, "could not find post-merge branch recheck in finish()");
	const askFailureSlice = f.slice(askIdx, recheckIdx);
	assert.ok(
		askFailureSlice.includes("--abort"),
		"BUG: the ask(t, \"merger\") failure path resets the task to ready without `git merge --abort`. " +
			"A merger that dies mid-merge (conflicts) leaves the repo in MERGING state and the retry fails. " +
			"Expected `merge --abort` (best-effort) in the merger-failure catch.",
	);
});
