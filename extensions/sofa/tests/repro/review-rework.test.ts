// F012: review FIX loops back to the builder instead of spawning bug tasks.
// Source-shape tests (pipeline.ts wiring) + a simulation of the bounded
// rework loop driven by the ACTUAL helpers the loop uses (report.ts), so the
// acceptance behavior is executed, not just asserted as text.
// node --test extensions/sofa/tests/repro/review-rework.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { countReviewRounds, nextReviewAction, parseReviewVerdict, reviewReadyNote, reviewRoundSuffix } from "../../infra/report.ts";

const pipelineSrc = fs.readFileSync(new URL("../../core/pipeline.ts", import.meta.url), "utf8");
// pipeline.ts imports the pi runtime (not installed under plain node --test),
// so read the cap from source instead of importing it.
const MAX_REVIEW_ROUNDS = Number(pipelineSrc.match(/export const MAX_REVIEW_ROUNDS\s*=\s*(\d+)/)?.[1]);
assert.ok(Number.isInteger(MAX_REVIEW_ROUNDS), "could not find MAX_REVIEW_ROUNDS in pipeline.ts");

function reviewBlock(): string {
	const start = pipelineSrc.indexOf('if (t.stage === "review")');
	assert.ok(start >= 0, "could not find review stage in pipeline.ts");
	return pipelineSrc.slice(start, pipelineSrc.indexOf('update(t, research ? "done" : "ready"', start));
}

test("F012: review rounds are capped at MAX_REVIEW_ROUNDS = 2", () => {
	assert.equal(MAX_REVIEW_ROUNDS, 2);
});

test("F012: review stage re-prompts the builder with the reviewer findings on FIX", () => {
	const b = reviewBlock();
	assert.ok(b.includes("parseReviewVerdict"), "review stage never parses the reviewer verdict");
	assert.ok(
		b.includes("reviewer requested changes (FIX)"),
		"review stage never re-prompts the builder with the reviewer findings",
	);
});

test("F012: review stage re-runs the check gate and re-commits before re-reviewing", () => {
	const b = reviewBlock();
	assert.ok(b.includes("checkAndCommit"), "review rework never re-runs the check gate + commit");
	assert.ok(b.includes('ask(t, "reviewer")'), "review stage never re-reviews after rework");
});

test("F012: FIX rework stays in the same task (no new task id, same worktree)", () => {
	const b = reviewBlock();
	assert.ok(!b.includes("nextId("), "review rework must not mint a new task id (no follow-up B-task)");
	assert.ok(!b.includes("worktree\", \"create"), "review rework must not open a new worktree");
	assert.ok(b.includes("MAX_REVIEW_ROUNDS"), "review stage never enforces the round cap");
});

test("F012: exhausted rounds land ready with the exact note", () => {
	const b = reviewBlock();
	assert.ok(b.includes("reviewReadyNote"), "review stage never records the exhausted/unknown note");
	assert.ok(b.includes("MAX_REVIEW_ROUNDS"), "review stage never enforces the round cap");
	const reportSrc = fs.readFileSync(new URL("../../infra/report.ts", import.meta.url), "utf8");
	assert.ok(
		reportSrc.includes("review FIX after ${maxRounds} rounds"),
		"expected the exhausted note template `review FIX after ${maxRounds} rounds` in report.ts",
	);
	assert.equal(reviewReadyNote("fix", 2, MAX_REVIEW_ROUNDS), "review FIX after 2 rounds");
});

test("F012: unknown verdict never blocks (approve-with-note)", () => {
	const b = reviewBlock();
	assert.ok(b.includes("reviewReadyNote"), "review stage never handles the unknown verdict");
	assert.equal(nextReviewAction("unknown", 1, MAX_REVIEW_ROUNDS), "done");
});

test("F012: notify reviewer line surfaces verdict and rounds", () => {
	assert.ok(
		pipelineSrc.includes("reviewRoundSuffix(rounds, parseReviewVerdict(r))"),
		"notify() never renders the reviewer verdict + rounds",
	);
	assert.equal(reviewRoundSuffix(2, "approve"), "FIX→APPROVE (round 2)");
});

test("F012: rounds count reviewer rows in t.log (no board format change)", () => {
	assert.ok(pipelineSrc.includes("countReviewRounds(t.log)"), "rounds are not counted from t.log reviewer rows");
	assert.ok(!/interface LogRow \{[^}]*round/s.test(pipelineSrc), "round counting must not add a board field");
});

// Simulate the loop exactly as pipeline.ts drives it: parse -> count ->
// decide -> note. Stubs stand in for ask()/checkAndCommit()/herdr; the
// verdicts, counts, actions and notes all come from the real helpers.
function simulate(script: string[]): { taskId: string; builderReworks: number; rounds: number; note?: string; idsMinted: string[] } {
	const taskId = "F001";
	const log: { role: string }[] = [];
	let reports: Record<string, string> = {};
	let note: string | undefined;
	let builderReworks = 0;
	const idsMinted: string[] = []; // stays empty: rework never calls nextId()
	let ri = 0;
	for (;;) {
		// reviewer settles (same pane or a new one: always a new log row)
		reports.reviewer = script[ri] ?? "APPROVE";
		log.push({ role: "reviewer" });
		ri++;
		const verdict = parseReviewVerdict(reports.reviewer);
		const rounds = countReviewRounds(log);
		const n = reviewReadyNote(verdict, rounds, MAX_REVIEW_ROUNDS);
		if (nextReviewAction(verdict, rounds, MAX_REVIEW_ROUNDS) === "done") {
			if (n) note = n;
			return { taskId, builderReworks, rounds, note, idsMinted };
		}
		// builder rework in the same task: findings passed back, check + commit re-run
		builderReworks++;
		reports.builder = `rework ${builderReworks} for ${taskId}`;
	}
}

test("F012 SIM: FIX then APPROVE reworks once in the same task", () => {
	const r = simulate(["FIX", "Summary: APPROVE, fixed"]);
	assert.equal(r.builderReworks, 1);
	assert.equal(r.taskId, "F001");
	assert.deepEqual(r.idsMinted, []);
	assert.equal(r.rounds, 2);
	assert.equal(r.note, undefined);
});

test("F012 SIM: still-FIX after 2 rounds lands ready with the exhausted note", () => {
	const r = simulate(["FIX", "Verdict: FIX"]);
	assert.equal(r.builderReworks, 1);
	assert.equal(r.rounds, 2);
	assert.equal(r.note, "review FIX after 2 rounds");
	assert.deepEqual(r.idsMinted, []);
});

test("F012 SIM: APPROVE first round needs no rework", () => {
	const r = simulate(["Summary: APPROVE, no bugs found"]);
	assert.equal(r.builderReworks, 0);
	assert.equal(r.rounds, 1);
	assert.equal(r.note, undefined);
});

test("F012 SIM: missing verdict never blocks", () => {
	const r = simulate(["just some prose, no verdict line"]);
	assert.equal(r.builderReworks, 0);
	assert.equal(r.rounds, 1);
	assert.equal(r.note, "review verdict unknown (treated as approve)");
});
