// node --test extensions/sofa/tests/report.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { countReviewRounds, extractReportText, nextReviewAction, parseReviewVerdict, reviewReadyNote, reviewRoundSuffix, SUMMARY_MAX, summaryLine } from "../infra/report.ts";

test("summaryLine prefers the Summary: line", () => {
	assert.equal(summaryLine("# Title\n\nSummary: did the thing\n\nbody"), "did the thing");
});

test("summaryLine falls back to the first non-empty line", () => {
	assert.equal(summaryLine("\n\nhello\nworld\n"), "hello");
});

test("summaryLine caps a very long first line at ~200 chars with an ellipsis", () => {
	const out = summaryLine("x".repeat(500));
	assert.ok(out.length <= SUMMARY_MAX + 3, `not capped: length ${out.length}`);
	assert.match(out, /(\.\.\.|…)$/);
});

test("summaryLine caps a very long Summary: line too", () => {
	const out = summaryLine(`Summary: ${"y".repeat(500)}`);
	assert.ok(out.length <= SUMMARY_MAX + 3, `not capped: length ${out.length}`);
	assert.match(out, /(\.\.\.|…)$/);
});

test("summaryLine leaves short lines alone", () => {
	assert.equal(summaryLine("short line"), "short line");
});

test("extractReportText reads r.read.text", () => {
	assert.equal(extractReportText({ read: { text: "the review text" } }), "the review text");
});

test("extractReportText reads r.text", () => {
	assert.equal(extractReportText({ text: "the review text" }), "the review text");
});

test("extractReportText keeps a plain string as-is", () => {
	assert.equal(extractReportText("the review text"), "the review text");
});

test("extractReportText unpacks a JSON-envelope string", () => {
	assert.equal(extractReportText(JSON.stringify({ read: { text: "the review text" } })), "the review text");
});

test("extractReportText never stores a raw JSON object", () => {
	const out = extractReportText({});
	assert.equal(typeof out, "string");
	assert.notEqual(out, "{}");
});

test("parseReviewVerdict reads a bare APPROVE verdict line", () => {
	assert.equal(parseReviewVerdict("Looks good.\n\nAPPROVE"), "approve");
});

test("parseReviewVerdict reads a bare FIX verdict line", () => {
	assert.equal(parseReviewVerdict("Found a bug.\n\nFIX"), "fix");
});

test("parseReviewVerdict returns unknown when no verdict line exists", () => {
	assert.equal(parseReviewVerdict("Looks good overall, please fix the typo."), "unknown");
	assert.equal(parseReviewVerdict(""), "unknown");
});

test("parseReviewVerdict finds the verdict buried in prose", () => {
	const report = [
		"# Review",
		"",
		"Summary: FIX, null check missing",
		"",
		"## Findings",
		"- HIGH src/a.ts:12: missing null check",
		"",
		"Discussion of the diff and why it matters.",
		"",
		"Verdict: FIX",
	].join("\n");
	assert.equal(parseReviewVerdict(report), "fix");
});

test("parseReviewVerdict lets the last verdict line win", () => {
	assert.equal(parseReviewVerdict("FIX\nmore analysis\nAPPROVE"), "approve");
	assert.equal(parseReviewVerdict("APPROVE\nmore analysis\nFIX"), "fix");
});

test("parseReviewVerdict ignores prose that merely mentions fixing", () => {
	assert.equal(parseReviewVerdict("Fix the login bug before merging."), "unknown");
});

test("countReviewRounds counts reviewer rows in t.log", () => {
	const log = [
		{ finished: "2026-10-08 10:02", role: "builder", agent: "pi", session: "s-1" },
		{ finished: "2026-10-08 10:03", role: "reviewer", agent: "claude", session: "s-2" },
		{ finished: "2026-10-08 10:04", role: "reviewer", agent: "claude", session: "s-3" },
	];
	assert.equal(countReviewRounds(log), 2);
	assert.equal(countReviewRounds([]), 0);
});

test("reviewRoundSuffix surfaces verdict and rounds", () => {
	assert.equal(reviewRoundSuffix(1, "approve"), "APPROVE (round 1)");
	assert.equal(reviewRoundSuffix(2, "approve"), "FIX\u2192APPROVE (round 2)");
	assert.equal(reviewRoundSuffix(2, "fix"), "FIX\u2192FIX (round 2)");
});

test("nextReviewAction reworks FIX with rounds left, else finishes", () => {
	assert.equal(nextReviewAction("fix", 1, 2), "rework");
	assert.equal(nextReviewAction("fix", 2, 2), "done");
	assert.equal(nextReviewAction("approve", 1, 2), "done");
	assert.equal(nextReviewAction("unknown", 1, 2), "done");
});

test("reviewReadyNote names the exhausted cap and marks unknown", () => {
	assert.equal(reviewReadyNote("fix", 2, 2), "review FIX after 2 rounds");
	assert.equal(reviewReadyNote("fix", 1, 2), undefined);
	assert.equal(reviewReadyNote("unknown", 1, 2), "review verdict unknown (treated as approve)");
	assert.equal(reviewReadyNote("approve", 2, 2), undefined);
});
