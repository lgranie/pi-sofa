// B008 repro: B007 review findings — rollback on post-merge failure, decline
// note, unreachable merging branch, fragile merge-commit check.
// Source-shape tests over core/finish.ts and index.ts: they fail against B007
// code and pass after the B008 fix.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const finishSrc = fs.readFileSync(new URL("../../core/finish.ts", import.meta.url), "utf8");
const indexSrc = fs.readFileSync(new URL("../../index.ts", import.meta.url), "utf8");

function finishBlock(): string {
	const start = finishSrc.indexOf("export async function finish");
	assert.ok(start >= 0, "could not find finish() in finish.ts");
	return finishSrc.slice(start);
}

// 1. HIGH — post-merge check failure must roll `into` back to the captured
// pre-merge HEAD. `git merge --abort` is a no-op once committed.
test("B008-1: finish() rolls back into on post-merge check failure (reset --hard before)", () => {
	const f = finishBlock();
	const askIdx = f.indexOf('ask(t, "merger"');
	assert.ok(askIdx >= 0, "could not find merger ask() in finish()");
	const afterSlice = f.slice(askIdx);
	assert.ok(afterSlice.includes("run(t.check"), "precondition: finish() must re-run t.check after the merge");
	assert.ok(
		afterSlice.includes("reset") && afterSlice.includes("--hard") && afterSlice.includes("before"),
		"BUG B008-1: finish() does not roll back the merge commit on post-merge failure. Expected `git reset --hard <before>` (captured pre-merge HEAD) when the check fails, not just `merge --abort` (a no-op once committed).",
	);
	// Guarded: only reset when HEAD is still the merger's result.
	assert.ok(
		/curHead\s*===\s*after|after\s*===\s*curHead|=== after/.test(afterSlice),
		"BUG B008-1: reset must be guarded to the merger's result (only reset if current into HEAD is still the post-merge HEAD, not an unrelated later commit).",
	);
});

// 1b. HIGH — the other post-merge failure paths must also roll back when
// HEAD moved (not just the check-failure path).
test("B008-1b: finish() rolls back on merge-verification failures with moved HEAD", () => {
	const f = finishBlock();
	const askIdx = f.indexOf('ask(t, "merger"');
	const afterSlice = f.slice(askIdx);
	const resetCount = (afterSlice.match(/reset.*--hard|"--hard"/g) ?? []).length;
	// rollback helper called from 3 failure paths, or at least 2 distinct
	// rollback call sites (verification + check). A single reset only in the
	// check path leaves "no merge commit" / "did not merge" with moved HEAD unrolled.
	const rollbackCalls = (afterSlice.match(/rollback\(/g) ?? []).length;
	assert.ok(
		rollbackCalls >= 3 || resetCount >= 2 || (afterSlice.includes("rollback") && resetCount >= 1),
		`BUG B008-1b: only the check-failure path rolls back; the "no merge commit" and "did not merge" paths with a moved HEAD leave the merge on into. Expected rollback (reset --hard before) on all post-merge failures. Found ${rollbackCalls} rollback() calls.`,
	);
});

// 2. LOW — decline must restore the pre-merge note, not the stale merging note.
test("B008-2: index.ts decline restores the previous note", () => {
	const anchor = indexSrc.indexOf('if (action === "merge")');
	assert.ok(anchor >= 0, "could not find merge path in index.ts");
	const end = indexSrc.indexOf("await finish(ctx, t)", anchor);
	const pre = indexSrc.slice(anchor, end > anchor ? end : anchor + 2000);
	assert.ok(pre.includes("User declined the merge"), "could not find decline path");
	assert.ok(/const prev = t\.note/.test(pre), 'BUG B008-2: decline path must capture `const prev = t.note` before the "merging …" update');
	const declineIdx = pre.indexOf("User declined the merge");
	const declineSlice = pre.slice(Math.max(0, declineIdx - 300), declineIdx);
	assert.ok(/update\(t,\s*"ready",\s*prev/.test(declineSlice), 'BUG B008-2: decline must call update(t, "ready", prev), not update(t, "ready", t.note) (stale "merging …" note)');
	assert.ok(!/update\(t,\s*"ready",\s*t\.note/.test(declineSlice), 'BUG B008-2: decline still restores t.note (stale "merging …" note)');
});

// 3. finish() must accept the transitional merging state set by sofa_finish
// (index.ts flips to running/merging BEFORE calling finish(), so the branch
// is reachable — removing it rejected every merge).
test("B008-3: finish() accepts the transitional merging state", () => {
	const f = finishBlock();
	assert.ok(f.includes('startsWith("merging")') || f.includes("startsWith('merging')"), 'BUG B008-3: finish() must accept status === "running" with a "merging" note set by sofa_finish before the call.');
	assert.ok(/t\.status !== "ready"/.test(f), "precondition: finish() must still guard on ready tasks");
});

// 4. LOW — strict merge-commit check must not trust only the latest merge.
test("B008-4: finish() does not rely on the latest merge commit alone", () => {
	const f = finishBlock();
	const askIdx = f.indexOf('ask(t, "merger"');
	const afterSlice = f.slice(askIdx);
	// The fragile shape is exactly: log --merges -n 1 … then parents.includes(branchTip).
	const fragile = /--merges.*-n",\s*"1"/.test(afterSlice) || /--merges",\s*"-n",\s*"1"/.test(afterSlice);
	assert.ok(!fragile, "BUG B008-4: finish() checks only the latest merge commit (`git log --merges -n 1` + parents.includes(branchTip)); a later unrelated merge breaks it. Walk back through recent merges (-n 20) or rely on ancestor + HEAD-moved.");
	assert.ok(afterSlice.includes("--merges"), "precondition: expected a --merges check to remain (robust walk)");
});
