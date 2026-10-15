// B014 repro: REVIEW_FOLLOW_UP leaks the literal `{base}` to the reviewer.
// Source-shape tests: they FAIL on current code (repro gate) and PASS after the fix.
// Do NOT fix the source here — make the check fail.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const pipelineSrc = fs.readFileSync(new URL("../../core/pipeline.ts", import.meta.url), "utf8");

function reviewFn(): string {
	const start = pipelineSrc.indexOf("async function reviewTask");
	assert.ok(start >= 0, "could not find reviewTask() in pipeline.ts");
	const end = pipelineSrc.indexOf("const finish = ", start);
	assert.ok(end > start, "could not bound reviewTask() before finish()");
	return pipelineSrc.slice(start, end);
}

// Precondition: the template really carries the placeholder (the leak source).
test("B014-0: REVIEW_FOLLOW_UP carries the {base} placeholder (precondition)", () => {
	assert.ok(
		pipelineSrc.includes("const REVIEW_FOLLOW_UP"),
		"precondition: could not find REVIEW_FOLLOW_UP in pipeline.ts",
	);
	assert.ok(
		pipelineSrc.includes("git diff {base}...HEAD"),
		"precondition: REVIEW_FOLLOW_UP no longer contains `git diff {base}...HEAD`; bug location moved",
	);
});

// 1. The follow-up must be interpolated with the real base before it reaches
// the reviewer — the same way the check-failure follow-up interpolates values.
// Currently reviewTask does `ask(t, "reviewer", REVIEW_FOLLOW_UP)` verbatim,
// and ask() appends the follow-up verbatim (both the needBrief branch and the
// alive-pane branch), while only rolePrompt/briefParts substitute {base} in
// the standing prompt. On a re-prompted (alive) reviewer pane only the
// follow-up is sent, so the reviewer sees the literal `{base}`.
test("B014-1: reviewTask does not send REVIEW_FOLLOW_UP verbatim (must substitute {base})", () => {
	const f = reviewFn();
	assert.ok(f.includes("REVIEW_FOLLOW_UP"), "precondition: reviewTask never uses REVIEW_FOLLOW_UP");
	assert.ok(
		!f.includes('ask(t, "reviewer", REVIEW_FOLLOW_UP)'),
		"BUG B014-1: reviewTask passes REVIEW_FOLLOW_UP verbatim to ask(t, \"reviewer\", …), so the reviewer sees the literal `{base}` (ask() sends the follow-up verbatim; only the standing prompt gets {base} substituted). Expected e.g. ask(t, \"reviewer\", REVIEW_FOLLOW_UP.replaceAll(\"{base}\", t.base!)).",
	);
});

// 2. Stronger: the substitution itself must be present at the send site.
test("B014-2: reviewer follow-up interpolates t.base before ask()", () => {
	const f = reviewFn();
	const askIdx = f.indexOf('ask(t, "reviewer"');
	assert.ok(askIdx >= 0, "precondition: could not find ask(t, \"reviewer\") in reviewTask()");
	const window = f.slice(Math.max(0, askIdx - 300), askIdx + 300);
	assert.ok(
		window.includes('.replaceAll("{base}"') && window.includes("t.base"),
		"BUG B014-2: no {base} → t.base substitution at the reviewer follow-up send site. The follow-up sent to the reviewer still contains the literal `{base}` instead of the task's real base. Expected REVIEW_FOLLOW_UP.replaceAll(\"{base}\", t.base!) (or equivalent) where the follow-up is sent.",
	);
});
