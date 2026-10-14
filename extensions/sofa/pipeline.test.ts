// node --test extensions/sofa/pipeline.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

// Pure logic extracted from pipeline.ts for testability

type Kind = "feature" | "bug" | "research";
type Stage = "lead" | "repro" | "check" | "review" | "end";

function nextStageAfterLead(kind: Kind, hasCheck: boolean): Stage {
	if (kind === "research") return "end";
	if (kind === "bug" && hasCheck) return "repro";
	return "check";
}

function isBugReproduced(checkExitCode: number): boolean {
	return checkExitCode !== 0;
}

test("nextStageAfterLead: research tasks go to end", () => {
	assert.equal(nextStageAfterLead("research", true), "end");
	assert.equal(nextStageAfterLead("research", false), "end");
});

test("nextStageAfterLead: bug tasks with check go to repro", () => {
	assert.equal(nextStageAfterLead("bug", true), "repro");
});

test("nextStageAfterLead: bug tasks without check go to check", () => {
	assert.equal(nextStageAfterLead("bug", false), "check");
});

test("nextStageAfterLead: feature tasks go to check", () => {
	assert.equal(nextStageAfterLead("feature", true), "check");
	assert.equal(nextStageAfterLead("feature", false), "check");
});

test("isBugReproduced: non-zero exit code means bug reproduced", () => {
	assert.equal(isBugReproduced(1), true);
	assert.equal(isBugReproduced(2), true);
	assert.equal(isBugReproduced(127), true);
});

test("isBugReproduced: zero exit code means bug NOT reproduced", () => {
	assert.equal(isBugReproduced(0), false);
});