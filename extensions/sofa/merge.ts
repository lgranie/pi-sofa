/**
 * Pure merge helpers for the merger role, so the worker brief is unit-testable
 * without git or herdr. The runtime (pipeline.ts) prompts the merger worker
 * with mergerFollowUp() and verifies the merge landed before cleaning up.
 * See merge.test.ts.
 */

export interface MergeTask {
	id: string;
	title: string;
	branch: string;
	repo?: string;
	check?: string;
}

// Task-specific brief for the merger worker: which branch to merge into what,
// where, and what to do when the merge or the check fails. The role's standing
// orders (merge with --no-ff, conflict policy, no push, Summary: report line)
// come from the merger prompt in sofa-agents.json.
export function mergerFollowUp(t: MergeTask, into: string): string {
	const repo = t.repo ?? ".";
	// B006: single-quote for the shell so a title/branch with `"`, `$()` or
	// backticks cannot break out of the command.
	const sq = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
	const lines = [
		`Merge task ${t.id} branch \`${t.branch}\` ("${t.title}") into \`${into}\` in the repo at \`${repo}\`. The repo is already on \`${into}\`; do not switch branches and do not push.`,
		`Run \`git -C ${sq(repo)} merge --no-ff ${sq(t.branch)} -m ${sq(t.title)}\`. If there are conflicts, resolve them preferring the task branch unless it clearly breaks behaviour; if the merge cannot be completed cleanly, run \`git -C ${sq(repo)} merge --abort\` and report why.`,
	];
	if (t.check) lines.push(`Then run the check \`${t.check}\` in \`${repo}\` on the merged result and fix merge-induced failures (do not reimplement the task).`);
	return lines.join("\n\n");
}
