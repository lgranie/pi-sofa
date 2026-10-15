/**
 * Merge a ready task: a merger worker merges the branch, the orchestrator
 * verifies the result landed, then cleans up the worktree and branch.
 *
 * The merge stays idempotent: an already-merged branch verifies and cleans
 * up, so a retry after an interruption just finishes. When a post-merge
 * failure left the merger's result committed, the pre-merge HEAD is
 * restored; the human confirmation dialog stays with the caller (index.ts
 * sofa_finish). Factory scope arrives as an explicit ctx holding the bound
 * ask driver; see pipeline.ts (factory).
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Task } from "./board.ts";
import { git, herdr, run, tail } from "../infra/cli.ts";
import { loadAgents } from "../agents/config.ts";
import { mergerFollowUp } from "./merge.ts";
import { summaryLine } from "../infra/report.ts";
import type { Ctx } from "./workers.ts";

// Finish a ready task by delegating the merge to a merger worker. The worker merges the
// task branch into the repo's current branch (resolving conflicts, running the check);
// the orchestrator only verifies the merge landed, then removes the worktree, deletes
// the branch and marks the task merged. The merge stays idempotent: an already-merged
// branch verifies and cleans up, so a retry after an interruption just finishes.
// The human confirmation dialog stays with the caller (index.ts sofa_finish).
// B006: idempotent (skip worker when already an ancestor) and strictly verified
// (still on `into`, real merge commit present).
// B007: strong verification — capture `into` HEAD before the merge, then
// require the branch tip to be an ancestor of `into` AND `into` HEAD to have
// moved. Re-run t.check on the merged result; close the stale merger pane
// on the idempotent path.
// B008: roll `into` back to the pre-merge HEAD when a post-merge failure
// left the merger's result committed (guarded to the merger's result);
// walk back through recent merge commits instead of trusting the latest one.
export async function finish(ctx: Ctx, ext: ExtensionContext, t: Task) {
	// The transitional merging state is set by sofa_finish (index.ts) before
	// calling finish(): the ready check there runs before the guard flip, so
	// by the time finish() runs the task is running/merging. Reject anything else.
	const merging = t.status === "running" && t.note?.startsWith("merging");
	if (t.status !== "ready" && !merging) throw new Error(`task ${t.id} is ${t.status}, only ready feature/bug tasks merge`);
	// B011-7: a throw before the merge would leave the task stuck in
	// running/"merging" (set in index.ts before finish()) with no retry
	// path. Each setup step below restores ready (nothing merged yet, so a
	// retry is safe) instead of escaping.
	try {
		ctx.s.agents = loadAgents(ext);
	} catch (e) {
		ctx.update(t, "ready", (e as Error).message.split("\n")[0]);
		throw e;
	}
	let into: string;
	try {
		into = await git(t.repo!, "branch", "--show-current");
	} catch (e) {
		const msg = `cannot read current branch: ${(e as Error).message.split("\n")[0]}`;
		ctx.update(t, "ready", msg);
		throw new Error(msg);
	}
	// B006 idempotent: branch already an ancestor => skip the merger worker,
	// just clean up (safe resume after interruption with a stale pane).
	const alreadyMerged = await git(t.repo!, "merge-base", "--is-ancestor", t.branch, into)
		.then(() => true)
		.catch(() => false);
	if (alreadyMerged) {
		// B007: close the stale merger pane left by the interrupted merge (best-effort).
		const mergerPane = t.panes.merger;
		if (mergerPane) await herdr("pane", "close", mergerPane).catch(() => {});
		// B011-1: even on the idempotent shortcut, re-run the task check
		// on the merged result. The branch may have been merged by hand or
		// by an earlier attempt the check never ran on. On failure the task
		// goes to failed (never merged, worktree and branch kept for
		// inspection): there is no `before` HEAD to roll a possibly foreign
		// merge back to.
		if (t.check) {
			let c: { code: number; out: string };
			try {
				c = await run(t.check, [], t.repo!, true);
			} catch (e) {
				const err = `check \`${t.check}\` could not run after merge: ${(e as Error).message.split("\n")[0]}`;
				ctx.update(t, "failed", err);
				ctx.notify(t);
				throw new Error(err);
			}
			if (c.code !== 0) {
				const err = `check \`${t.check}\` failed after merge (exit ${c.code}):\n${tail(c.out)}`;
				ctx.update(t, "failed", err.split("\n")[0]);
				ctx.notify(t);
				throw new Error(err);
			}
		}
		try {
			await herdr("worktree", "remove", "--workspace", t.workspace!);
			await git(t.repo!, "branch", "-d", t.branch);
			// F013: belt-and-braces — close any leftover tabs best-effort so a half-failed remove cannot orphan a workspace.
			for (const pane of Object.values(t.panes)) {
				if (pane) await herdr("pane", "close", pane).catch(() => {});
			}
		} catch (e) {
			ctx.update(t, "ready", (e as Error).message.split("\n")[0]);
			throw e;
		}
		ctx.update(t, "merged", `into ${into}`);
		ctx.notify(t);
		return ctx.line(t);
	}
	// B007: capture `into` HEAD and the branch tip before the merger runs —
	// rev-parse alone proves nothing unless compared to the post-merge state.
	let before: string;
	try {
		before = await git(t.repo!, "rev-parse", into);
	} catch (e) {
		const msg = `cannot read HEAD of ${into}: ${(e as Error).message.split("\n")[0]}`;
		ctx.update(t, "ready", msg);
		throw new Error(msg);
	}
	const branchTip = await git(t.repo!, "rev-parse", t.branch).catch(() => "");
	// B011-2: record whether the main checkout's working tree is clean
	// BEFORE the merge, so rollback() never destroys uncommitted work with
	// `reset --hard`. Unknown (status itself failed) counts as dirty:
	// fail-closed, refuse the reset and ask a human instead.
	let treeClean = false;
	try {
		treeClean = (await git(t.repo!, "status", "--porcelain")) === "";
	} catch {
		treeClean = false;
	}
	// B008: roll `into` back to the pre-merge HEAD when a post-merge
	// failure left the merger's result committed. `git merge --abort` is a
	// no-op once the merge is committed, so reset --hard is required;
	// guarded to the case where HEAD is still the merger's result (after),
	// never over an unrelated later commit. No reset when HEAD did not move.
	// (Defined below, after the merger prompt, so verification can use it.)
	try {
		await ctx.ask(t, "merger", mergerFollowUp(t, into));
	} catch (e) {
		// The merger may have died mid-merge (conflicts): abort best-effort
		// so the repo is not left in MERGING state for the retry.
		await git(t.repo!, "merge", "--abort").catch(() => {});
		ctx.update(t, "ready", (e as Error).message.split("\n")[0]);
		throw e;
	}
	// B011-3: every failure inside rollback() moves the task OUT of ready
	// (failed, with a manual-rollback note) before raising. Staying ready
	// with a bad merge on `into` would let the next finish() take the
	// alreadyMerged path and mark the task merged without the check passing.
	const rollback = async (after: string) => {
		try {
			await git(t.repo!, "merge", "--abort");
		} catch {}
		if (after && after !== before) {
			let curHead: string;
			try {
				curHead = await git(t.repo!, "rev-parse", into);
			} catch (e) {
				const msg = `manual rollback required: cannot verify HEAD of ${into} (${(e as Error).message.split("\n")[0]}); the merge may still be on ${into}`;
				ctx.update(t, "failed", msg);
				ctx.notify(t);
				throw new Error(msg);
			}
			if (curHead && curHead === after) {
				if (!treeClean) {
					const msg = `manual rollback required: working tree dirty, refusing to reset --hard; the merge is still on ${into}`;
					ctx.update(t, "failed", msg);
					ctx.notify(t);
					throw new Error(msg);
				}
				try {
					await git(t.repo!, "reset", "--hard", before);
				} catch {
					const msg = `manual rollback required: git reset --hard ${before} failed; the merge is still on ${into}`;
					ctx.update(t, "failed", msg);
					ctx.notify(t);
					throw new Error(msg);
				}
			}
		}
	};
	// B006 verification: the worker must not have left the repo on another branch.
	// B012: reading cur can throw; restore ready so the task is retryable
	// instead of stuck running/merging.
	let cur: string;
	try {
		cur = await git(t.repo!, "branch", "--show-current");
	} catch (e) {
		const msg = `cannot read current branch after merge: ${(e as Error).message.split("\n")[0]}`;
		ctx.update(t, "ready", msg);
		throw new Error(msg);
	}
	if (cur !== into) {
		// B012: the checkout is on cur, not into — a `reset --hard` here
		// would move cur to into's old HEAD (discarding cur's commits)
		// while into keeps the bad merge. Roll into back by moving the
		// branch ref instead, never touching the current checkout.
		// Guarded like rollback(): only when HEAD of into still equals
		// the merger result; dirty-tree refuses; a branch -f failure
		// (it refuses if into is checked out elsewhere) goes failed
		// loudly with a manual-rollback message.
		let afterCur: string;
		try {
			afterCur = await git(t.repo!, "rev-parse", into);
		} catch (e) {
			const msg = `manual rollback required: cannot read HEAD of ${into} after merge (${(e as Error).message.split("\n")[0]}); the merge may still be on ${into}`;
			ctx.update(t, "failed", msg);
			ctx.notify(t);
			throw new Error(msg);
		}
		if (afterCur && afterCur !== before) {
			let curHead: string;
			try {
				curHead = await git(t.repo!, "rev-parse", into);
			} catch (e) {
				const msg = `manual rollback required: cannot verify HEAD of ${into} (${(e as Error).message.split("\n")[0]}); the merge may still be on ${into}`;
				ctx.update(t, "failed", msg);
				ctx.notify(t);
				throw new Error(msg);
			}
			if (curHead && curHead === afterCur) {
				if (!treeClean) {
					const msg = `manual rollback required: working tree dirty, refusing to move ${into}; the merge is still on ${into}`;
					ctx.update(t, "failed", msg);
					ctx.notify(t);
					throw new Error(msg);
				}
				try {
					await git(t.repo!, "branch", "-f", into, before);
				} catch {
					const msg = `manual rollback required: git branch -f ${into} ${before} failed; the merge is still on ${into}`;
					ctx.update(t, "failed", msg);
					ctx.notify(t);
					throw new Error(msg);
				}
			}
		}
		await git(t.repo!, "merge", "--abort").catch(() => {});
		const err = `merger left repo on ${cur}, expected ${into}`;
		ctx.update(t, "ready", err);
		throw new Error(err);
	}
	// B007 strong verification: the branch tip must now be an ancestor of
	// `into` AND `into` HEAD must have moved. A bare rev-parse or any
	// recent --merges entry proves nothing (fast-forward, rebase, or an
	// unrelated merge all pass those); HEAD movement plus ancestry proves
	// a merge commit was created on `into` with the branch in its history.
	let ancestor = true;
	try {
		await git(t.repo!, "merge-base", "--is-ancestor", t.branch, into);
	} catch {
		ancestor = false;
	}
	// B011-5: this rev-parse runs after the merge committed. If it fails we
	// cannot verify (or roll back) anything, so fail loudly out of ready
	// instead of leaving a possible bad merge on `into`.
	// const after = rev-parse(into), guarded: no silent catch to empty.
	let after: string;
	try {
		after = await git(t.repo!, "rev-parse", into);
	} catch (e) {
		const msg = `manual rollback required: cannot read HEAD of ${into} after merge (${(e as Error).message.split("\n")[0]}); the merge may still be on ${into}`;
		ctx.update(t, "failed", msg);
		ctx.notify(t);
		throw new Error(msg);
	}
	if (!ancestor || !after || after === before) {
		await rollback(after);
		// The merger report is only parsed when there is no check to re-run.
		const detail = t.check ? "" : `: ${summaryLine(t.reports.merger ?? "")}`;
		const err = `merger did not merge ${t.branch} into ${into}${detail}`;
		ctx.update(t, "ready", err);
		throw new Error(err);
	}
	// Stricter: a merge commit (merger uses --no-ff) bringing in the
	// captured branch tip must exist on `into`. B008: walk back through
	// recent merge commits instead of trusting only the latest one — the
	// merger may have added a later merge (e.g. merging `into` back).
	const merges = await git(t.repo!, "log", into, "--merges", "-n", "20", "--format=%H %P").catch(() => "");
	const landed = merges
		.trim()
		.split("\n")
		.filter(Boolean)
		.some((l) => !branchTip || l.trim().split(/\s+/).slice(1).includes(branchTip));
	if (!landed) {
		await rollback(after);
		const err = `merger did not create a merge commit bringing ${t.branch} into ${into}`;
		ctx.update(t, "ready", err);
		throw new Error(err);
	}
	// B007: a failing check after the merge is not ignored — re-run the
	// task check on the merged result and require exit 0.
	// B011-4: run() can reject (spawn error), not just exit non-zero.
	// Catch it, roll back, record the error out of ready, throw. A throwing
	// rollback() already moved the task to failed, so the update below only
	// runs when the tree is clean again.
	if (t.check) {
		let c: { code: number; out: string };
		try {
			c = await run(t.check, [], t.repo!, true);
		} catch (e) {
			await rollback(after);
			const err = `check \`${t.check}\` could not run after merge: ${(e as Error).message.split("\n")[0]}`;
			ctx.update(t, "failed", err);
			ctx.notify(t);
			throw new Error(err);
		}
		if (c.code !== 0) {
			await rollback(after);
			const err = `check \`${t.check}\` failed after merge (exit ${c.code}):\n${tail(c.out)}`;
			ctx.update(t, "ready", err.split("\n")[0]);
			t.reports.error = err;
			ctx.save(t);
			throw new Error(err);
		}
	}
	// B011-7: the merge is valid and stays in the repo; a cleanup throw must
	// restore ready (not stay running/merging). The retry hits the
	// alreadyMerged path, which re-runs the check per finding 1.
	try {
		await herdr("worktree", "remove", "--workspace", t.workspace!); // fail-closed: refuses a dirty worktree
		await git(t.repo!, "branch", "-d", t.branch);
		// F013: belt-and-braces — close any leftover tabs best-effort so a half-failed remove cannot orphan a workspace.
		for (const pane of Object.values(t.panes)) {
			if (pane) await herdr("pane", "close", pane).catch(() => {});
		}
	} catch (e) {
		ctx.update(t, "ready", (e as Error).message.split("\n")[0]);
		throw e;
	}
	ctx.update(t, "merged", `into ${into}`);
	ctx.notify(t);
	return ctx.line(t);
}
