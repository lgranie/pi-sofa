/**
 * Task intake: add a todo task, start it, or resume it after a stop.
 *
 * create() files a task at todo status; start() rates its level, pins its
 * base commit and runs the stage machine in the background; resume()
 * continues an interrupted or failed task from its stage. Factory scope
 * (board state plus the bound launch driver) arrives as an explicit ctx
 * instead of closure scope; see pipeline.ts (factory).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Kind, nextId, type Task } from "./board.ts";
import { git } from "../infra/cli.ts";
import { type Level, loadAgents, rate } from "../agents/config.ts";
import { canStart, resolveMaxRunning } from "../infra/concurrency.ts";
import { taskDir, type Ctx } from "./workers.ts";

export interface NewTask {
	kind: Kind;
	title: string;
	task: string;
	check?: string;
	review?: boolean;
	level?: Level;
	repo?: string;
	base?: string;
}

// Add a task at todo status.
export async function create(ctx: Ctx, ext: ExtensionContext, p: NewTask) {
	ctx.sync();
	const repo = await git(path.resolve(ext.cwd, p.repo ?? "."), "rev-parse", "--show-toplevel");
	const id = nextId(ctx.s.tasks, p.kind); // after the await, so concurrent adds get distinct ids
	const t: Task = {
		id,
		kind: p.kind,
		title: p.title,
		task: p.task,
		status: "todo",
		check: p.check,
		review: p.review ?? false,
		repo,
		level: p.level,
		levelWhy: p.level ? "set explicitly" : undefined,
		base: p.base,
		branch: `sofa/${id}`,
		stage: "lead",
		panes: {},
		prompted: {},
		log: [],
		reports: {},
	};
	ctx.s.tasks.push(t);
	ctx.save(t);
	return t;
}

// Start a todo task: rate its level (unless set), pin its base commit, run the pipeline in the background.
export async function start(ctx: Ctx, ext: ExtensionContext, t: Task) {
	if (t.status !== "todo") throw new Error(`task ${t.id} is ${t.status}, only todo tasks start`);
	ctx.s.agents = loadAgents(ext);
	const max = resolveMaxRunning(ctx.s.agents.maxRunning);
	if (!canStart(ctx.s.tasks, max)) throw new Error(`max ${max} tasks already running/blocked; start fewer or wait`);
	t.repo = await git(path.resolve(ext.cwd, t.repo ?? "."), "rev-parse", "--show-toplevel");
	t.base = await git(t.repo, "rev-parse", t.base ?? "HEAD");
	if (!t.level) Object.assign(t, await rate(ext, ctx.s.agents.classifier, t.kind, t.title, t.task).then(({ level, why }) => ({ level, levelWhy: why })));
	ctx.update(t, "running");
	ctx.launch(t, false);
	return `Started ${ctx.line(t)} on ${t.branch}; level ${t.level} (${t.levelWhy})`;
}

// Continue an interrupted or failed task from its stage.
export function resume(ctx: Ctx, ext: ExtensionContext, t: Task) {
	if (t.status !== "interrupted" && t.status !== "failed") throw new Error(`task ${t.id} is ${t.status}, only interrupted or failed tasks resume`);
	ctx.s.agents = loadAgents(ext);
	delete t.reports.error;
	fs.rmSync(path.join(taskDir(ctx, t), "error.report.md"), { force: true });
	ctx.update(t, "running", "resumed");
	// ponytail: after an in-process /reload the old runtime may still supervise this task; resume only after a pi restart then
	ctx.launch(t, true);
	return `Resumed ${ctx.line(t)} at stage ${t.stage}`;
}
