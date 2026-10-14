// node --test extensions/sofa/tests.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { changedTestFiles, looksLikeTestFile, parseNameStatus } from "./tests.ts";

const T = "\t";

test("looksLikeTestFile: directories named test/tests/spec/specs/__tests__", () => {
	assert.equal(looksLikeTestFile("src/foo.test.ts"), true);
	assert.equal(looksLikeTestFile("tests/foo.ts"), true);
	assert.equal(looksLikeTestFile("test/foo.ts"), true);
	assert.equal(looksLikeTestFile("spec/foo.ts"), true);
	assert.equal(looksLikeTestFile("specs/foo.ts"), true);
	assert.equal(looksLikeTestFile("app/__tests__/foo.ts"), true);
	assert.equal(looksLikeTestFile("app/__tests__/nested/bar.ts"), true);
});

test("looksLikeTestFile: file names like .test. / .spec. / test. / spec.", () => {
	assert.equal(looksLikeTestFile("foo.test.ts"), true);
	assert.equal(looksLikeTestFile("foo.spec.js"), true);
	assert.equal(looksLikeTestFile("test.ts"), true);
	assert.equal(looksLikeTestFile("spec.ts"), true);
	assert.equal(looksLikeTestFile("TEST.TS"), true);
});

test("looksLikeTestFile: non-test files are not flagged", () => {
	assert.equal(looksLikeTestFile("src/index.ts"), false);
	assert.equal(looksLikeTestFile("README.md"), false);
	assert.equal(looksLikeTestFile("package.json"), false);
	assert.equal(looksLikeTestFile("tests.json"), false); // no extension match, not a dir segment
});

test("parseNameStatus: simple M/A/D entries", () => {
	assert.deepEqual(parseNameStatus(["M", "src/a.ts"].join(T) + "\n" + ["A", "src/b.ts"].join(T) + "\n" + ["D", "src/c.ts"].join(T)), [
		{ status: "M", path: "src/a.ts" },
		{ status: "A", path: "src/b.ts" },
		{ status: "D", path: "src/c.ts" },
	]);
});

test("parseNameStatus: renames keep the old path", () => {
	assert.deepEqual(parseNameStatus(["R100", "old/a.ts", "new/a.ts"].join(T)), [{ status: "R100", path: "old/a.ts" }]);
});

test("parseNameStatus: copies keep the old path", () => {
	assert.deepEqual(parseNameStatus(["C100", "old/a.ts", "new/a.ts"].join(T)), [{ status: "C100", path: "old/a.ts" }]);
});

test("parseNameStatus: empty input", () => {
	assert.deepEqual(parseNameStatus(""), []);
});

test("changedTestFiles: flags modified and deleted tests, ignores added ones", () => {
	const diff = [
		["M", "src/index.ts"].join(T),
		["M", "tests/foo.test.ts"].join(T),
		["D", "spec/bar.spec.ts"].join(T),
		["A", "tests/new.test.ts"].join(T),
		["M", "src/__tests__/helper.ts"].join(T),
		["A", "src/__tests__/added.ts"].join(T),
		["M", "src/not-a-test.ts"].join(T),
	].join("\n");
	assert.deepEqual(changedTestFiles(diff), ["tests/foo.test.ts", "spec/bar.spec.ts", "src/__tests__/helper.ts"]);
});

test("changedTestFiles: renamed and copied tests flag the old path", () => {
	const diff = [
		["R100", "tests/old.test.ts", "tests/new.test.ts"].join(T),
		["C100", "spec/orig.spec.ts", "spec/copy.spec.ts"].join(T),
		["R100", "src/index.ts", "src/renamed.ts"].join(T),
	].join("\n");
	assert.deepEqual(changedTestFiles(diff), ["tests/old.test.ts", "spec/orig.spec.ts"]);
});

test("changedTestFiles: no test changes returns empty", () => {
	assert.deepEqual(changedTestFiles(["M", "src/index.ts"].join(T) + "\n" + ["M", "README.md"].join(T)), []);
});

test("changedTestFiles: empty diff returns empty", () => {
	assert.deepEqual(changedTestFiles(""), []);
});
