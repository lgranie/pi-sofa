// B011 repro: merge-rollback holes in pipeline.ts finish().
// Source-shape tests: they FAIL on current code (repro gate) and PASS after the fix.
// Do NOT fix the source here — make the check fail.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const pipelineSrc = fs.readFileSync(new URL("./pipeline.ts", import.meta.url), "utf8");

function finishBlock(): string {
	const start = pipelineSrc.indexOf("async function finish");
	assert.ok(start >= 0, "could not find finish() in pipeline.ts");
	return pipelineSrc.slice(start, pipelineSrc.indexOf("return { s, save", start));
}

// 1. MEDIUM — alreadyMerged idempotent path must re-run the task check before
// marking merged; otherwise a hand-merged branch bypasses the check gate.
test("B011-1: alreadyMerged path re-runs t.check before marking merged", () => {
	const f = finishBlock();
	const askIdx = f.indexOf('ask(t, "merger"');
	assert.ok(askIdx >= 0, "could not find merger ask() in finish()");
	const idemSlice = f.slice(0, askIdx);
	assert.ok(idemSlice.includes("alreadyMerged"), "precondition: expected alreadyMerged idempotent branch");
	assert.ok(
		idemSlice.includes("run(t.check"),
		"BUG B011-1: alreadyMerged path marks merged without re-running t.check. Expected run(t.check) in t.repo before marking merged; on failure update(t, \"failed\") (not merged) and keep worktree/branch.",
	);
	assert.ok(
		/failed/.test(idemSlice),
		"BUG B011-1: alreadyMerged check failure must set update(t, \"failed\") (no pre-merge HEAD to roll back to), not merged/ready.",
	);
});

// 2. MEDIUM — treeClean captured BEFORE the merger prompt so rollback() never
// destroys uncommitted work with reset --hard.
test("B011-2: finish() captures treeClean before the merger prompt and guards rollback", () => {
	const f = finishBlock();
	const askIdx = f.indexOf('ask(t, "merger"');
	assert.ok(askIdx >= 0, "could not find merger ask() in finish()");
	const beforeSlice = f.slice(0, askIdx);
	assert.ok(
		beforeSlice.includes("treeClean") && beforeSlice.includes("status") && beforeSlice.includes("--porcelain"),
		"BUG B011-2: finish() does not capture treeClean (git status --porcelain on t.repo) BEFORE prompting the merger worker. Expected a fail-closed clean check so rollback() can refuse reset --hard on a dirty tree.",
	);
	const afterSlice = f.slice(askIdx);
	assert.ok(
		/treeClean/.test(afterSlice) && /refusing to reset|working tree dirty|manual rollback required/i.test(afterSlice),
		"BUG B011-2: rollback() does not refuse reset --hard when the tree is dirty. Expected update(t, \"failed\", \"manual rollback required: working tree dirty, refusing to reset --hard …\") and throw.",
	);
});

// 3. HIGH — rollback() must fail loudly: rev-parse and reset failures set
// failed with manual-rollback message and throw, never swallow.
test("B011-3: rollback() fails loudly on rev-parse / reset failure", () => {
	const f = finishBlock();
	const rbIdx = f.indexOf("const rollback");
	assert.ok(rbIdx >= 0, "could not find rollback helper in finish()");
	const rbEnd = f.indexOf("};", rbIdx);
	const rb = f.slice(rbIdx, rbEnd > rbIdx ? rbEnd : rbIdx + 1500);
	assert.ok(
		!/\.catch\(\(\) => \{\}\)/.test(rb),
		"BUG B011-3: rollback() swallows failures (.catch(() => {}) on rev-parse / reset --hard). A failed reset leaves the merge on into while the task goes ready and the next finish() marks it merged. Expected update(t, \"failed\", \"manual rollback required …\") and throw.",
	);
	assert.ok(
		/manual rollback required/i.test(rb) && /failed/.test(rb) && /throw/.test(rb),
		"BUG B011-3: rollback() must set update(t, \"failed\", \"manual rollback required …\") and throw when it cannot verify HEAD or the reset fails.",
	);
});

// 4. HIGH — post-merge run(t.check) can reject (spawn error), not just exit
// non-zero; it must be try/catch wrapped with rollback + failed.
test("B011-4: post-merge check re-run is try/catch wrapped (spawn errors roll back)", () => {
	const f = finishBlock();
	const askIdx = f.indexOf('ask(t, "merger"');
	assert.ok(askIdx >= 0, "could not find merger ask() in finish()");
	const afterSlice = f.slice(askIdx);
	const runIdx = afterSlice.indexOf("run(t.check");
	assert.ok(runIdx >= 0, "precondition: finish() must re-run t.check after the merge");
	const window = afterSlice.slice(Math.max(0, runIdx - 600), runIdx + 800);
	assert.ok(
		window.includes("try"),
		"BUG B011-4: run(t.check) after the merge is not try/catch wrapped. A spawn rejection escapes without rollback or record. Expected try/catch: on reject await rollback(after), update(t, \"failed\"), throw.",
	);
	assert.ok(
		/rollback\(/.test(afterSlice.slice(runIdx - 200, runIdx + 800)),
		"BUG B011-4: check-spawn failure path does not roll back the merge.",
	);
});

// 5. MEDIUM — post-merge rev-parse (after) caught to "" hides verification and
// rollback; it must be guarded explicitly with failed + throw.
test("B011-5: post-merge rev-parse is guarded (no silent catch to empty)", () => {
	const f = finishBlock();
	const askIdx = f.indexOf('ask(t, "merger"');
	const afterSlice = f.slice(askIdx);
	assert.ok(afterSlice.includes("const after"), "precondition: expected const after = rev-parse(into)");
	assert.ok(
		!/const after = await git\(t\.repo!,\s*"rev-parse",\s*into\)\.catch\(\(\) => ""\)/.test(afterSlice),
		"BUG B011-5: const after swallows rev-parse failure (.catch(() => \"\")) and flows into the did-not-merge branch with no way to verify or roll back. Expected an explicit guard: on failure update(t, \"failed\", \"manual rollback required: cannot read HEAD of <into> …\") and throw.",
	);
	assert.ok(
		/manual rollback required/i.test(afterSlice),
		"BUG B011-5: expected a \"manual rollback required: cannot read HEAD …\" guard when post-merge rev-parse fails.",
	);
});

// 6. LOW — cur !== into path must apply the same guarded rollback (merger may
// have committed then switched branch), not just merge --abort.
test("B011-6: cur !== into path rolls back the committed merge, not just abort", () => {
	const f = finishBlock();
	const curIdx = f.indexOf("cur !== into");
	assert.ok(curIdx >= 0, "could not find cur !== into branch check in finish()");
	// Isolate the if-body: up to its throw (before the rollback helper defined later).
	const throwIdx = f.indexOf("throw", curIdx);
	assert.ok(throwIdx > curIdx, "could not find throw in cur !== into path");
	const curSlice = f.slice(curIdx, throwIdx);
	assert.ok(
		curSlice.includes("rollback(") || (curSlice.includes("reset") && curSlice.includes("--hard")),
		"BUG B011-6: cur !== into path only runs git merge --abort. If the merger committed the merge then switched branch, into keeps the merge commit. Expected the same guarded rollback (reset to before) before failing.",
	);
});

// 7. MEDIUM — final cleanup (worktree remove + branch -d) can throw and leaves
// the task stuck in running/merging; it must restore ready for retry.
test("B011-7: post-merge cleanup failure restores ready (retry hits alreadyMerged)", () => {
	const f = finishBlock();
	const askIdx = f.indexOf('ask(t, "merger"');
	const afterSlice = f.slice(askIdx);
	const cleanupIdx = afterSlice.indexOf("worktree\", \"remove\"");
	assert.ok(cleanupIdx >= 0, "could not find post-merge worktree-remove cleanup in finish()");
	const cleanupSlice = afterSlice.slice(Math.max(0, cleanupIdx - 600), cleanupIdx + 800);
	assert.ok(
		cleanupSlice.includes("try") && /update\(t,\s*"ready"/.test(cleanupSlice),
		"BUG B011-7: post-merge cleanup (worktree remove + branch -d) is not try/catch wrapped with update(t, \"ready\"). On throw the task stays running/merging with no retry path. Expected catch → update(t, \"ready\", msg) → rethrow (merge stays; retry takes the alreadyMerged path which re-runs the check).",
	);
});
