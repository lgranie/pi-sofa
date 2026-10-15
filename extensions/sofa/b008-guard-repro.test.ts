// B008 guard-handoff regression: sofa_finish sets a transitional
// running/merging status BEFORE confirm (B006 atomic guard) and then calls
// finish() — finish() must accept that transitional state, otherwise every
// merge is rejected. (First written as a failing repro, now the regression
// test for the fix.)
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const pipelineSrc = fs.readFileSync(new URL("./pipeline.ts", import.meta.url), "utf8");
const indexSrc = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");

function finishBlock(): string {
	const start = pipelineSrc.indexOf("async function finish");
	assert.ok(start >= 0, "could not find finish() in pipeline.ts");
	return pipelineSrc.slice(start, pipelineSrc.indexOf("return { s, save", start));
}

test("B008-guard: finish() accepts the transitional merging state set by sofa_finish", () => {
	const f = finishBlock();
	// finish() must accept ready OR the transitional running/merging state.
	assert.ok(
		f.includes('startsWith("merging")') || f.includes("startsWith('merging')"),
		'BUG: finish() only accepts ready — the transitional running/merging state set by sofa_finish is rejected and every merge fails. Expected finish() to accept status === "running" with a "merging" note.',
	);
	assert.ok(/t\.status !== "ready"/.test(f), "precondition: finish() must still guard on ready tasks");

	// index.ts merge path still flips to running/merging BEFORE confirm, then calls finish().
	const anchor = indexSrc.indexOf('if (action === "merge")');
	assert.ok(anchor >= 0, "could not find merge path in index.ts");
	const finishCall = indexSrc.indexOf("await finish(ctx, t)", anchor);
	assert.ok(finishCall > anchor, "could not find finish() call in index.ts merge path");
	const pre = indexSrc.slice(anchor, finishCall);
	assert.ok(pre.includes('update(t, "running"') && pre.includes("merging"), "precondition: expected index.ts to set transitional running/merging before finish()");
});
