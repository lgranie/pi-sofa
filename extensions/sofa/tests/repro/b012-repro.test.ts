// B012 repro: cur-not-into rollback resets the wrong branch + unguarded cur read.
// Source-shape tests over core/finish.ts: they FAIL on pre-fix code and PASS after the fix.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const finishSrc = fs.readFileSync(new URL("../../core/finish.ts", import.meta.url), "utf8");

function finishBlock(): string {
	const start = finishSrc.indexOf("export async function finish");
	assert.ok(start >= 0, "could not find finish() in finish.ts");
	return finishSrc.slice(start);
}

function curNotIntoSlice(): string {
	const f = finishBlock();
	const curIdx = f.indexOf("cur !== into");
	assert.ok(curIdx >= 0, "could not find cur !== into branch check in finish()");
	// End at the "merger left repo on" error (thrown at the end of the branch),
	// so the slice covers the whole rollback handling, not just the first throw.
	const endMarker = f.indexOf("merger left repo on", curIdx);
	assert.ok(endMarker > curIdx, "could not find merger-left-repo error in cur !== into path");
	return f.slice(curIdx, endMarker + 200);
}

// 1. HIGH — cur !== into path must move the `into` branch ref (branch -f),
// never reset --hard the current checkout (which is on cur, not into).
test("B012-1: cur !== into path rolls into back via branch -f, not reset --hard", () => {
	const s = curNotIntoSlice();
	assert.ok(
		s.includes('"branch"') && s.includes('"-f"') && s.includes("before"),
		"BUG B012-1: cur !== into path does not move the into ref. Expected git(t.repo!, \"branch\", \"-f\", into, before) to roll into back to the pre-merge HEAD.",
	);
	assert.ok(
		!s.includes('"reset"'),
		"BUG B012-1: cur !== into path uses reset --hard, which moves the CURRENT checkout (on cur) to into's old HEAD — discarding cur's commits while into keeps the bad merge. Do NOT reset the checkout here.",
	);
	assert.ok(
		s.includes("treeClean"),
		"BUG B012-1: cur !== into rollback lacks the dirty-tree guard (treeClean). Refuse with manual rollback required when dirty.",
	);
	assert.ok(
		/manual rollback required/i.test(s) && /failed/.test(s) && /throw/.test(s),
		"BUG B012-1: cur !== into rollback failure must set update(t, \"failed\", \"manual rollback required …\") and throw (branch -f refuses if into is checked out elsewhere).",
	);
});

// 2. LOW — reading cur after the merger can throw; it must restore ready, not
// leave the task stuck running/merging.
test("B012-2: cur read after merger is guarded (failure restores ready)", () => {
	const f = finishBlock();
	const askIdx = f.indexOf('ask(t, "merger"');
	assert.ok(askIdx >= 0, "could not find merger ask() in finish()");
	const afterSlice = f.slice(askIdx);
	const showIdx = afterSlice.indexOf('"branch", "--show-current"');
	assert.ok(showIdx >= 0, "could not find branch --show-current (cur read) after the merger");
	const window = afterSlice.slice(Math.max(0, showIdx - 600), showIdx + 400);
	assert.ok(
		window.includes("try"),
		"BUG B012-2: const cur = await git(t.repo!, \"branch\", \"--show-current\") after the merger is not try/catch wrapped. On throw the task stays running/merging with no recovery. Expected catch → update(t, \"ready\", msg) → throw.",
	);
	assert.ok(
		/update\(t,\s*"ready"/.test(window),
		"BUG B012-2: cur-read failure must restore update(t, \"ready\", msg) before throwing.",
	);
});
