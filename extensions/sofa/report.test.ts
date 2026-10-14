// node --test extensions/sofa/report.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractReportText, SUMMARY_MAX, summaryLine } from "./report.ts";

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
