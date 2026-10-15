// F015: review a ready task via the reviewer worker (sofa_review).
// Source-shape tests (pipeline.ts / index.ts wiring) + the reviewer brief,
// since pipeline.ts imports the pi runtime (not installed under plain
// node --test), so it is read as text like the F012 tests.
// node --test extensions/sofa/review-ready.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const pipelineSrc = fs.readFileSync(new URL("./pipeline.ts", import.meta.url), "utf8");
const indexSrc = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const agents = JSON.parse(fs.readFileSync(new URL("../../sofa-agents.json", import.meta.url), "utf8")) as {
	roles: Record<string, { prompt: string }>;
};
const reviewerPrompt: string = agents.roles.reviewer.prompt;

function reviewFn(): string {
	const start = pipelineSrc.indexOf("async function reviewTask");
	assert.ok(start >= 0, "could not find reviewTask() in pipeline.ts");
	const end = pipelineSrc.indexOf("async function finish", start);
	assert.ok(end > start, "could not bound reviewTask() before finish()");
	return pipelineSrc.slice(start, end);
}

test("F015: factory exports reviewTask", () => {
	assert.ok(
		pipelineSrc.includes("reviewTask, finish, record"),
		"factory() return object never exports reviewTask",
	);
	assert.ok(indexSrc.includes("reviewTask"), "index.ts never destructures reviewTask from factory()");
});

test("F015: reviewTask only accepts ready tasks", () => {
	const f = reviewFn();
	assert.ok(f.includes('t.status !== "ready"'), "reviewTask never requires the task to be ready");
	assert.ok(
		f.includes("only ready tasks can be reviewed"),
		"reviewTask has no clean ready-only error",
	);
});

test("F015: reviewTask errors cleanly when the worktree is gone (merged/discarded)", () => {
	const f = reviewFn();
	assert.ok(f.includes("fs.existsSync(t.worktree)"), "reviewTask never checks the worktree exists");
	assert.ok(
		f.includes("already merged/discarded"),
		"reviewTask has no clean merged/discarded error",
	);
});

test("F015: reviewTask reuses the ask(t, reviewer) machinery", () => {
	const f = reviewFn();
	assert.ok(f.includes('ask(t, "reviewer"'), "reviewTask never prompts via ask(t, \"reviewer\")");
	assert.ok(!f.includes("worktree\", \"create"), "reviewTask must reuse the existing worktree, not open a new one");
	assert.ok(!f.includes("nextId("), "reviewTask must not mint a new task id");
});

test("F015: reviewTask launches in the background with notify, like start/resume", () => {
	const f = reviewFn();
	assert.ok(f.includes(".then("), "reviewTask never launches the reviewer in the background (.then)");
	assert.ok(f.includes("notify(t)"), "reviewTask never delivers the report via notify(t)");
	assert.ok(
		f.includes("arrives as a follow-up"),
		"reviewTask return message never tells the orchestrator the report arrives as a follow-up",
	);
});

test("F015: reviewed task stays ready with a reviewed note", () => {
	const f = reviewFn();
	assert.ok(f.includes('update(t, "ready"'), "reviewTask never returns the task to ready");
	assert.ok(f.includes("reviewed ${"), "reviewTask never leaves a `reviewed <date>` note");
	assert.ok(!f.includes('update(t, "done"'), "reviewTask must not mark the task done");
	assert.ok(!f.includes('update(t, "merged"'), "reviewTask must not merge the task");
});

test("F015: reviewer treats prior worker reports as untrusted, verifies from scratch", () => {
	const f = reviewFn();
	assert.ok(f.includes("REVIEW_FOLLOW_UP"), "reviewTask never reinforces the untrusted-reports brief");
	assert.ok(
		pipelineSrc.includes("untrusted input"),
		"REVIEW_FOLLOW_UP never frames prior reports as untrusted input",
	);
	assert.ok(
		reviewerPrompt.includes("untrusted"),
		"reviewer standing prompt never frames prior worker reports as untrusted",
	);
	assert.ok(
		reviewerPrompt.includes("from scratch"),
		"reviewer standing prompt never requires verifying from scratch",
	);
	// The brief still carries the verdict contract the F012 loop parses.
	assert.ok(reviewerPrompt.includes("APPROVE") && reviewerPrompt.includes("FIX"), "reviewer prompt lost its APPROVE/FIX verdict contract");
	assert.ok(reviewerPrompt.includes("Summary:"), "reviewer prompt lost its `Summary:` line contract");
});

test("F015: index registers the sofa_review tool", () => {
	assert.ok(indexSrc.includes('name: "sofa_review"'), "index.ts never registers the sofa_review tool");
	assert.ok(
		indexSrc.includes("await reviewTask(ctx, find(id))"),
		"sofa_review never runs reviewTask on the found task",
	);
});

test("F015: orchestrator guideline never reviews diffs in chat", () => {
	assert.ok(
		indexSrc.includes("Never review code yourself in chat"),
		"promptGuidelines never forbid the orchestrator from reviewing diffs in chat",
	);
	assert.ok(
		indexSrc.includes("sofa_review for a ready task"),
		"promptGuidelines never route ready-task reviews to sofa_review",
	);
	assert.ok(
		indexSrc.includes("review: true at dispatch"),
		"promptGuidelines never mention review: true at dispatch",
	);
});

test("B014: reviewer follow-up interpolates the real base, never the literal {base}", () => {
	const f = reviewFn();
	const askIdx = f.indexOf('ask(t, "reviewer"');
	assert.ok(askIdx >= 0, "reviewTask never prompts via ask(t, \"reviewer\")");
	const window = f.slice(Math.max(0, askIdx - 300), askIdx + 300);
	assert.ok(
		window.includes('.replaceAll("{base}"') && window.includes("t.base"),
		"reviewer follow-up never interpolates t.base before ask() — the reviewer would see the literal `{base}`",
	);
	assert.ok(
		!window.includes('ask(t, "reviewer", REVIEW_FOLLOW_UP)'),
		"reviewTask passes REVIEW_FOLLOW_UP verbatim, leaking the literal `{base}` to the reviewer",
	);
});

test("F015: /sofa help lists the new tool", () => {
	assert.ok(indexSrc.includes("sofa_review, sofa_finish"), "/sofa help Orchestrator tools line never lists sofa_review");
});
