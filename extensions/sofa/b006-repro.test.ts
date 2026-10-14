// B006 repro: F009 merger review findings.
// These tests inspect the ACTUAL source (config.ts / pipeline.ts / index.ts)
// and execute mergerFollowUp() so the fix step makes them pass without
// rewriting them. Do NOT fix the source here — make the check fail.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { mergerFollowUp } from "./merge.ts";

const configSrc = fs.readFileSync(new URL("./config.ts", import.meta.url), "utf8");
const pipelineSrc = fs.readFileSync(new URL("./pipeline.ts", import.meta.url), "utf8");
const indexSrc = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const mergeSrc = fs.readFileSync(new URL("./merge.ts", import.meta.url), "utf8");

function finishBlock(): string {
	const start = pipelineSrc.indexOf("async function finish");
	assert.ok(start >= 0, "could not find finish() in pipeline.ts");
	return pipelineSrc.slice(start, pipelineSrc.indexOf("return { s, save", start));
}

function askBlock(): string {
	const start = pipelineSrc.indexOf("async function ask");
	assert.ok(start >= 0, "could not find ask() in pipeline.ts");
	const end = pipelineSrc.indexOf("// Stage machine", start);
	return pipelineSrc.slice(start, end > start ? end : start + 3000);
}

function briefBlock(): string {
	const start = pipelineSrc.indexOf("const briefParts");
	assert.ok(start >= 0, "could not find briefParts() in pipeline.ts");
	return pipelineSrc.slice(start, pipelineSrc.indexOf("async function ask", start));
}

// 1. MEDIUM — merger must be optional: existing sofa-agents.json without it
// must not make loadAgents throw; fall back to the packaged default's merger.
test("B006-1: loadAgents does not require merger role (falls back to packaged default)", () => {
	const m = configSrc.match(/for \(const role of \[(.*?)\]\)/s);
	assert.ok(m, "could not find required-roles loop in config.ts");
	const requiresMerger = m![1].includes("merger");
	// Fallback = actual code that fills a.roles.merger from the packaged
	// default (or otherwise skips validation for it) — not just a comment
	// mentioning "packaged default".
	const hasFallback =
		/a\.roles\.merger\s*=/.test(configSrc) ||
		/roles\[.merger.\]\s*=/.test(configSrc) ||
		/merger.*fallback|fallback.*merger/i.test(configSrc);
	assert.ok(
		!requiresMerger || hasFallback,
		`BUG B006-1: config.ts requires "merger" in loadAgents, so any existing sofa-agents.json without it throws on startup and on every finish()/resume(). Expected merger to be optional with fallback to the packaged default's merger role. Required roles: [${m![1].trim()}]`,
	);
});

// 2. MEDIUM — merger must not see t.task: ask() sends briefParts() which
// includes the task description before the merge instruction.
test("B006-2: merger brief skips t.task (only merge instruction + standing orders)", () => {
	const brief = briefBlock();
	const ask = askBlock();
	const handlesMerger = brief.includes("merger") || ask.includes("merger");
	assert.ok(
		handlesMerger,
		"BUG B006-2: pipeline.ts ask()/briefParts() has no merger-specific path: " +
			"the merger gets the full task brief via briefParts() including t.task before the merge instruction " +
			"and may re-implement task work instead of merging. Expected briefParts()/ask() to skip t.task for the merger role " +
			"(send only mergerFollowUp(t, into) + merger standing orders).",
	);
});

// 3. MEDIUM — finish guard must be atomic: flip to transitional status in
// index.ts BEFORE the confirm dialog, so concurrent merges reject.
test("B006-3: index.ts flips task to transitional status before confirm dialog", () => {
	const anchor = indexSrc.indexOf('if (action === "merge")');
	assert.ok(anchor >= 0, "could not find merge path in index.ts");
	const end = indexSrc.indexOf("await finish(ctx, t)", anchor);
	assert.ok(end > anchor, "could not find finish() call in index.ts merge path");
	const pre = indexSrc.slice(anchor, end);
	const confirmIdx = pre.indexOf("confirm");
	assert.ok(confirmIdx >= 0, "could not find confirm dialog in merge path");
	const beforeConfirm = pre.slice(0, confirmIdx);
	const flipsEarly =
		beforeConfirm.includes('update(t, "running"') ||
		beforeConfirm.includes("update(t, 'running'") ||
		beforeConfirm.includes('"blocked"') ||
		/merging|running/.test(beforeConfirm) && beforeConfirm.includes("update(t,");
	assert.ok(
		flipsEarly,
		"BUG B006-3: index.ts merge path does not flip the task to a transitional status before the confirm dialog: " +
			"two concurrent sofa_finish merge calls can both pass the ready check and prompt the merger twice. " +
			"Expected check-and-set (e.g. update to running) before prompting.",
	);
});

// 4. LOW — merge verification must confirm repo still on `into` and that an
// actual merge commit landed, not just merge-base --is-ancestor.
test("B006-4: finish() verifies repo still on into and merge commit exists", () => {
	const f = finishBlock();
	assert.ok(f.includes("is-ancestor"), "precondition: finish() should check is-ancestor");
	const checksBranch =
		f.includes("branch\", \"--show-current") ||
		f.includes("branch', '--show-current") ||
		f.includes("--show-current") ||
		f.includes("abbrev-ref") ||
		f.includes("rev-parse --abbrev-ref");
	// Must re-check current branch AFTER the merge (not just the `into` read before ask).
	const intoRead = f.indexOf("branch\", \"--show-current");
	const ancestorCheck = f.indexOf("is-ancestor");
	const branchRecheckAfterMerge = checksBranch && f.lastIndexOf("--show-current") > ancestorCheck;
	const checksMergeCommit =
		f.includes("^{commit}") || f.includes("--merges") || (f.includes("rev-parse") && f.includes("log"));
	assert.ok(
		branchRecheckAfterMerge && checksMergeCommit,
		"BUG B006-4: finish() only runs `git merge-base --is-ancestor <branch> <into>`: " +
			"it does not verify the repo is still on `into`, nor that an actual merge commit exists, " +
			"nor that the check ran. A failing check after the merge goes unnoticed. " +
			"Expected: confirm repo still on `into` after the worker, and that the branch landed via a merge commit.",
	);
});

// 5. LOW — merge.ts interpolates title/branch into shell without escaping.
test("B006-5: mergerFollowUp shell-escapes title and branch (single-quote)", () => {
	const evilTitle = 'Fix "quoted" $(evil) `back`';
	const m = mergerFollowUp({ id: "F001", title: evilTitle, branch: "sofa/F001", repo: "/repo" }, "main");
	const sq = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
	assert.ok(
		!m.includes(`-m "${evilTitle}"`),
		`BUG B006-5: mergerFollowUp interpolates title into shell double-quotes without escaping: a title containing " or $() produces a broken/unsafe command. Got:\n${m}`,
	);
	assert.ok(
		m.includes(sq(evilTitle)) || m.includes(sq("sofa/F001")),
		`BUG B006-5: expected title/branch single-quote escaped for the shell. Got:\n${m}`,
	);
});

// 6. LOW — finish() must be idempotent: branch already ancestor => skip
// merger worker, just clean up (safe resume after interruption).
test("B006-6: finish() skips merger worker when branch already merged (idempotent)", () => {
	const f = finishBlock();
	const askIdx = f.indexOf('ask(t, "merger"');
	assert.ok(askIdx >= 0, "could not find merger ask() in finish()");
	const ancestorIdx = f.indexOf("is-ancestor");
	assert.ok(ancestorIdx >= 0, "could not find is-ancestor check in finish()");
	assert.ok(
		ancestorIdx < askIdx,
		"BUG B006-6: finish() asks the merger worker BEFORE checking whether the branch is already an ancestor of `into`: " +
			"a resume after interruption (task running mid-merge, stale pane, half-done merge) re-prompts instead of just cleaning up. " +
			"Expected: if the branch is already an ancestor when finish() starts, skip the worker and clean up (remove worktree, delete branch, mark merged).",
	);
});
