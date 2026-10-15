// node --test extensions/sofa/tests/merge.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergerFollowUp } from "../core/merge.ts";

test("mergerFollowUp: names the branch, target, title and repo", () => {
	const m = mergerFollowUp({ id: "F001", title: "Add merger role", branch: "sofa/F001", repo: "/repo" }, "main");
	assert.ok(m.includes("sofa/F001"), `missing branch. Got:\n${m}`);
	assert.ok(m.includes("main"), `missing target. Got:\n${m}`);
	assert.ok(m.includes("Add merger role"), `missing title. Got:\n${m}`);
	assert.ok(m.includes("/repo"), `missing repo. Got:\n${m}`);
	assert.ok(m.includes("--no-ff"), `missing --no-ff merge. Got:\n${m}`);
	assert.ok(m.includes("do not push"), `missing no-push guard. Got:\n${m}`);
});

test("mergerFollowUp: check runs on the merged result when the task has one", () => {
	const m = mergerFollowUp({ id: "F001", title: "T", branch: "sofa/F001", repo: "/repo", check: "npm run check" }, "main");
	assert.ok(m.includes("npm run check"), `missing check. Got:\n${m}`);
});

test("mergerFollowUp: no check line when the task has none", () => {
	const m = mergerFollowUp({ id: "F001", title: "T", branch: "sofa/F001", repo: "/repo" }, "main");
	assert.ok(!m.includes("Then run the check"), `unexpected check line. Got:\n${m}`);
});

test("mergerFollowUp: conflicts abort cleanly when unresolvable", () => {
	const m = mergerFollowUp({ id: "B002", title: "T", branch: "sofa/B002" }, "dev");
	assert.ok(m.includes("merge --abort"), `missing abort fallback. Got:\n${m}`);
	assert.ok(m.includes("dev"), `missing target. Got:\n${m}`);
});
