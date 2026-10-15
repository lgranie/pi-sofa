// B004 repro: tests-changed note is wiped before notify; reviewer prompt loses it on resume;
// renamed/copied test files not flagged; quoted paths.
// Tests execute the ACTUAL code from pipeline.ts (extracted from source), report.ts and tests.ts
// so the fix step makes them pass without rewriting them. Do NOT fix pipeline.ts / report.ts / tests.ts here.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { summaryLine } from "./report.ts";
import { changedTestFiles } from "./tests.ts";

const src = fs.readFileSync(new URL("./pipeline.ts", import.meta.url), "utf8");
const T = "\t";

// --- Extract actual helpers from pipeline.ts source (same technique as b003-repro) ---

// line: `const line = (t: Task) => <expr>;` — capture the RHS expression (template literal).
const lineMatch = src.match(/const line = \(t[^)]*\) => (`[\s\S]*?`);/);
assert.ok(lineMatch, "could not extract line from pipeline.ts");
const line = new Function("t", `return (${lineMatch[1]});`) as (t: any) => string;

// summaryLine now lives in report.ts (extracted from pipeline.ts so it can be
// unit-tested); notify() in pipeline.ts imports it from there, and notifyContent
// below passes the imported function in.

// update body: (t, status, note) + save stub. Persists whatever fields it doesn't touch.
const updateMatch = src.match(/const update = \(t[^)]*\) => \{([\s\S]*?)\n\t\};/);
assert.ok(updateMatch, "could not extract update from pipeline.ts");
const updateBody = updateMatch[1];
const update = (t: any, status: string, note?: string) => {
	const save = (_t: any) => {};
	new Function("t", "status", "note", "save", updateBody)(t, status, note, save);
};

// notify body: needs (t, line, summaryLine, pi). Captures pi.sendMessage content.
const notifyMatch = src.match(/const notify = \(t[^)]*\) => \{([\s\S]*?)\n\t\};/);
assert.ok(notifyMatch, "could not extract notify from pipeline.ts");
const notifyBody = notifyMatch[1];
function notifyContent(t: any): string {
	let captured = "";
	const pi = {
		sendMessage: (msg: any) => {
			captured = msg.content;
		},
	};
	new Function("t", "line", "summaryLine", "pi", notifyBody)(t, line, summaryLine, pi);
	return captured;
}

// rolePrompt body: needs (t, role, s).
const rolePromptMatch = src.match(/const rolePrompt = \(t[^)]*\) => \{([\s\S]*?)\n\t\};/);
assert.ok(rolePromptMatch, "could not extract rolePrompt from pipeline.ts");
const rolePromptBody = rolePromptMatch[1];
function reviewerPrompt(t: any): string {
	const s = { agents: { roles: { reviewer: { prompt: "Review base {base}." } } } };
	// Strip TS non-null assertions (e.g. `s.agents!.roles`, `t.base!`) so the
	// extracted body runs under plain `new Function`.
	const jsBody = rolePromptBody.replace(/!(?=[.,)\];])/g, "");
	const fn = new Function("t", "role", "s", jsBody) as (t: any, role: string, s: any) => string;
	return fn({ base: "abc123", ...t }, "reviewer", s);
}

function checkStageTask() {
	return {
		id: "F999",
		kind: "feature",
		title: "Some feature",
		status: "running",
		branch: "sofa/F999",
		file: ".sofa/F999/task.md",
		reports: { builder: "Summary: built it" },
	};
}

// HIGH — orchestrator message includes the file list even after the final update(t, "ready").
// The list must live in its own persistent field (e.g. t.testsChanged), not piggyback on t.note.
test("B004 HIGH: orchestrator message contains changed-test list after final update to ready", () => {
	const t: any = { ...checkStageTask(), testsChanged: ["tests/foo.test.ts", "spec/bar.spec.ts"] };
	update(t, "ready"); // final stage-end update wipes t.note — the list must survive this
	const msg = notifyContent(t);
	assert.ok(
		msg.includes("tests/foo.test.ts") && msg.includes("spec/bar.spec.ts"),
		`orchestrator message lost the changed-test list after update(t, "ready"). Got:\n${msg}`,
	);
});

// MEDIUM — reviewer prompt includes the Changed tests section even after a resume at review stage.
// resume() runs update(t, "running", "resumed"), which clears the transient note.
test("B004 MEDIUM: reviewer prompt keeps Changed tests section after resume", () => {
	const t: any = { ...checkStageTask(), testsChanged: ["tests/foo.test.ts"] };
	update(t, "running", "resumed"); // what resume() does before re-entering the review stage
	const prompt = reviewerPrompt(t);
	assert.ok(
		prompt.includes("## Changed tests") && prompt.includes("tests/foo.test.ts"),
		`reviewer prompt lost the Changed tests section after resume (note="resumed"). Got:\n${prompt}`,
	);
});

// MEDIUM — prompt embeds a clean file list, not the raw "tests changed: " prefix text.
test("B004 MEDIUM: reviewer prompt embeds clean file list without raw prefix", () => {
	const t: any = { ...checkStageTask(), testsChanged: ["tests/foo.test.ts"] };
	const prompt = reviewerPrompt(t);
	assert.ok(prompt.includes("tests/foo.test.ts"), `prompt missing file list. Got:\n${prompt}`);
	assert.ok(
		!prompt.includes("tests changed:"),
		`prompt leaks the raw "tests changed: " prefix instead of a clean file list. Got:\n${prompt}`,
	);
});

// LOW — renamed test files are flagged (old path: the old file was removed).
test("B004 LOW: renamed test file flags the old path", () => {
	const diff = [["R100", "tests/old.test.ts", "tests/new.test.ts"].join(T)].join("\n");
	assert.deepEqual(
		changedTestFiles(diff),
		["tests/old.test.ts"],
		`renamed test file not flagged (expected old path). Got: ${JSON.stringify(changedTestFiles(diff))}`,
	);
});

// LOW — copied test files are flagged (old path).
test("B004 LOW: copied test file flags the old path", () => {
	const diff = [["C100", "tests/orig.test.ts", "tests/copy.test.ts"].join(T)].join("\n");
	assert.deepEqual(
		changedTestFiles(diff),
		["tests/orig.test.ts"],
		`copied test file not flagged (expected old path). Got: ${JSON.stringify(changedTestFiles(diff))}`,
	);
});

// LOW — quoted paths (core.quotePath): the diff invocation must avoid them via -z or quotePath=false.
test("B004 LOW: pipeline diff avoids quoted paths (-z or core.quotePath=false)", () => {
	const diffCalls = [...src.matchAll(/git\(t\.worktree![\s\S]*?"diff"([\s\S]*?)\);/g)].map((m) => m[0]);
	const hasUnquotedHandling = diffCalls.some((c) => c.includes('"-z"') || c.includes("'-z'") || c.includes("quotePath"));
	assert.ok(
		hasUnquotedHandling,
		`pipeline "git diff --name-status" has no -z / core.quotePath=false handling; quoted paths pass through and can mismatch. Calls found:\n${diffCalls.join("\n") || "(none)"}`,
	);
});

// NIT — tests.ts and tests.test.ts end with a trailing newline.
test("B004 NIT: tests.ts and tests.test.ts end with trailing newline", () => {
	for (const f of ["tests.ts", "tests.test.ts"]) {
		const content = fs.readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
		assert.ok(content.endsWith("\n"), `${f} lacks a trailing newline`);
	}
});
