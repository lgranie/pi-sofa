// Pure helpers for flagging changed test files, so an agent can't quietly weaken the tests it runs.
// Kept separate from the pipeline runtime (pipeline.ts) so the matching logic is unit-testable without git.
// See tests.test.ts.

export type NameStatusEntry = { status: string; path: string };

// Parse `git diff --name-status` output into {status, path} entries. Simple entries are "M\tpath";
// renames/copies are "R100\told\tnew" and we keep the new path (what exists now).
export function parseNameStatus(output: string): NameStatusEntry[] {
	const entries: NameStatusEntry[] = [];
	for (const line of output.split("\n")) {
		if (!line) continue;
		const parts = line.split("\t");
		const status = parts[0];
		const path = parts[parts.length - 1];
		if (status && path) entries.push({ status, path });
	}
	return entries;
}

// A path "looks like a test" when any directory segment is test/tests/spec/specs/__tests__,
// or the file name is like foo.test.ts / foo.spec.js / test.ts / spec.ts.
const TEST_DIR_SEGMENTS = new Set(["test", "tests", "spec", "specs", "__tests__"]);
const TEST_FILE_RE = /\.(test|spec)\.[a-z0-9]+$/i;
const BARE_TEST_RE = /^(test|spec)\.[a-z0-9]+$/i;

export function looksLikeTestFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/").toLowerCase();
	const segments = normalized.split("/");
	if (segments.some((s) => TEST_DIR_SEGMENTS.has(s))) return true;
	const file = segments[segments.length - 1] ?? "";
	return TEST_FILE_RE.test(file) || BARE_TEST_RE.test(file);
}

// From a `git diff --name-status` output, return test files that were modified (M) or deleted (D).
// Added (A) test files are NOT flagged: the agent writing them is the proof, not a weakening of one.
export function changedTestFiles(diff: string): string[] {
	return parseNameStatus(diff)
		.filter((e) => (e.status === "M" || e.status === "D") && looksLikeTestFile(e.path))
		.map((e) => e.path);
}