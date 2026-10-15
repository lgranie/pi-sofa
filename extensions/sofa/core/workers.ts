/**
 * Worker tabs: one herdr tab per role in the task's worktree.
 *
 * Each role gets a tab running its exec at the task's level; the harness
 * takes the role description as its system prompt, so messages carry only
 * the task. Workers are supervised through herdr agent state (idle / working
 * / blocked), then settle: their report is collected and their cost logged.
 * Pure pipeline state (save/update/line/notify, bound ask/launch) arrives as
 * an explicit ctx instead of closure scope; see pipeline.ts (factory).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Status, type Task } from "./board.ts";
import { herdr } from "../infra/cli.ts";
import { extractReportText } from "../infra/report.ts";
import { harnessFor, type Launch } from "../agents/harness.ts";
import { skillsForRole } from "../agents/skills.ts";
import type { State } from "./pipeline.ts";

// Factory scope shared by the extracted core modules (workers, tasks,
// finish): session state, board persistence, and the bound stage drivers.
// tasks.ts receives launch through this ctx, finish.ts receives ask.
export interface Ctx {
	s: State;
	pi: ExtensionAPI;
	save: (t: Task) => void;
	sync: () => void;
	line: (t: Task) => string;
	update: (t: Task, status: Status, note?: string) => void;
	notify: (t: Task) => void;
	ask: (t: Task, role: string, followUp?: string) => Promise<void>;
	launch: (t: Task, resume: boolean) => Promise<void>;
}

export const reportFile = (t: Task, role: string) => path.join(t.worktree!, `.sofa-${role}.md`);
// Sidecars (role prompts, error markers) live next to task.md in the task dir.
export const taskDir = (ctx: Ctx, t: Task) => (t.file ? path.dirname(t.file) : path.join(ctx.s.dir, "board", t.status, t.id));
export const rolePrompt = (ctx: Ctx, t: Task, role: string) => {
	const prompt = ctx.s.agents!.roles[role].prompt.replaceAll("{base}", t.base!);
	if (role === "reviewer" && t.testsChanged?.length)
		return `${prompt}\n\n## Changed tests\n${t.testsChanged.join(", ")}\n\nSome existing test files were modified or deleted by the builder after the check passed. Judge whether the change weakens the test (e.g. relaxes an assertion, removes coverage, or makes the check pass without fixing the underlying behaviour) and say so in your report.`;
	return prompt;
};
export const alive = async (pane?: string) => !!pane && !!(await herdr("agent", "get", pane).catch(() => undefined))?.agent;

// Read and remove the role's report so it never ends up in a commit; fall back to the pane's screen.
export async function collect(t: Task, role: string, pane: string) {
	const file = reportFile(t, role);
	if (fs.existsSync(file)) {
		t.reports[role] = fs.readFileSync(file, "utf8");
		fs.rmSync(file);
	} else {
		const r = await herdr("agent", "read", pane, "--source", "recent-unwrapped", "--lines", "80");
		t.reports[role] = extractReportText(r);
	}
}

// Log one row per worker session with what it cost, read from the harness's own session log.
export async function record(ctx: Ctx, t: Task, role: string, pane: string) {
	const session: string = (await herdr("agent", "get", pane).catch(() => undefined))?.agent?.agent_session?.value ?? "?";
	const level = ctx.s.agents!.roles[role].levels[t.level!];
	const usage = session === "?" ? undefined : harnessFor(ctx.s.agents!.execs[level.exec].cmd)?.usage?.(session);
	const row = {
		finished: new Date().toISOString().slice(0, 16).replace("T", " "),
		role,
		agent: [level.exec, level.args].filter(Boolean).join(" "),
		session,
		input: usage?.input,
		output: usage?.output,
		cost: usage?.cost,
	};
	const i = t.log.findIndex((r) => r.role === role && r.session === session);
	// F012: every reviewer settle is a review round, even when the reviewer
	// pane (and its session) is reused — rounds count rows, not sessions.
	if (role === "reviewer" || i < 0) t.log.push(row);
	else t.log[i] = row;
}

// Marker row for non-worker events (repro gate, check pass) so the board log shows the bug was reproduced / fixed.
export const logEvent = (ctx: Ctx, t: Task, role: string) => {
	// Skip if a row with the same role already exists: on resume the repro/check stages re-run and would push a duplicate.
	if (t.log.some((r) => r.role === role)) return;
	t.log.push({
		finished: new Date().toISOString().slice(0, 16).replace("T", " "),
		role,
		agent: "-",
		session: "-",
	});
	ctx.save(t);
};

// Open a tab for the role in the task's worktree and start its exec at the task's level; herdr tells us when it is ready.
// briefed: the harness took the role description as its system prompt, so messages carry only the task.
export async function startWorker(ctx: Ctx, t: Task, role: string): Promise<{ pane: string; briefed: boolean }> {
	const level = ctx.s.agents!.roles[role].levels[t.level!];
	const exec = ctx.s.agents!.execs[level.exec];
	const harness = harnessFor(exec.cmd);
	// Resolved skill dirs for this role (empty when skill-less). A missing
	// clone means the session_start auto-clone has not run or failed:
	// fail fast and point at the manual refresh.
	const skillDirs = skillsForRole(ctx.s.agents!, role);
	const missing = skillDirs.filter((p) => !fs.existsSync(p));
	if (missing.length)
		throw new Error(`skills not cloned for role "${role}" (missing ${missing.join(", ")}); run /sofa update_skills in the orchestrator session`);
	let launch: Launch = { args: [], env: {} };
	if (harness) {
		const file = path.join(taskDir(ctx, t), `${role}.md`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, rolePrompt(ctx, t, role));
		launch = harness.launch(file, role, skillDirs);
	}
	const env = Object.entries({ SOFA_WORKER: "1", ...launch.env }).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
	const tab = await herdr(
		"tab", "create", "--workspace", t.workspace!, "--cwd", t.worktree!, "--label", `${role}:${t.level}`, ...env, "--no-focus",
	);
	const pane: string = tab.root_pane.pane_id;
	// B002/B005: record the pane right after the tab is created (unprompted for now) so a stop
	// before the first prompt never orphans the tab, and resume can tell it apart from a dead one.
	t.panes[role] = pane;
	if (!t.prompted) t.prompted = {};
	t.prompted[role] = false;
	ctx.save(t);
	await herdr("pane", "run", pane, [`mise x ${exec.tool} --`, exec.cmd, level.args, ...launch.args].filter(Boolean).join(" "));
	let told = false;
	// ponytail: 5 min covers a first-time mise install; raise it for slow networks
	for (let i = 0; i < 300; i++) {
		const status = (await herdr("agent", "get", pane).catch(() => undefined))?.agent?.agent_status;
		if (status === "idle" || status === "done") return { pane, briefed: !!harness };
		if (status === "blocked" && !told) {
			told = true;
			ctx.update(t, "blocked", `${role} needs you at startup in herdr pane ${pane}`);
			ctx.notify(t);
		}
		await sleep(1000);
	}
	throw new Error(`herdr never saw ${level.exec} become ready in pane ${pane} (tab "${role}")`);
}

// Wait for the worker to settle, then collect its report and cost. A blocked worker is escalated to the user, then awaited.
export async function settle(ctx: Ctx, t: Task, pane: string, role: string) {
	ctx.update(t, "running");
	for (;;) {
		const status = (await herdr("agent", "get", pane)).agent?.agent_status;
		if (status === "idle" || status === "done") break;
		if (status === "blocked") {
			ctx.update(t, "blocked", `${role} is waiting on you in herdr pane ${pane}`);
			ctx.notify(t);
			await herdr("agent", "wait", pane, "--until", "idle", "--until", "done");
			ctx.update(t, "running");
		} else {
			await herdr("agent", "wait", pane);
			await sleep(1000); // ponytail: guards a hot loop if herdr keeps reporting "unknown"
		}
	}
	await collect(t, role, pane);
	await record(ctx, t, role, pane);
	ctx.save(t);
}

// The heading + brief parts prepended when a worker is first (re)briefed. Extracted so the
// dead-tab and unprompted-tab branches cannot drift from each other.
// B006: the merger must not see t.task — it gets only the merge instruction
// (mergerFollowUp, passed as followUp) plus its standing orders, so it merges
// instead of re-implementing task work.
// B007: the merger brief is a single block (standing orders + merge
// instruction combined); every other role gets standing orders + t.task.
// briefParts never includes t.task for the merger.
export const briefParts = (ctx: Ctx, t: Task, role: string, followUp?: string): (string | undefined)[] => {
	const level = ctx.s.agents!.roles[role].levels[t.level!];
	const briefed = !!harnessFor(ctx.s.agents!.execs[level.exec].cmd);
	if (role === "merger") return [[briefed ? undefined : rolePrompt(ctx, t, role), followUp].filter(Boolean).join("\n\n")];
	const heading = `${t.kind[0].toUpperCase()}${t.kind.slice(1)} ${t.id}: ${t.title}`;
	return [briefed ? undefined : rolePrompt(ctx, t, role), `# ${heading}\n\n${t.task}`];
};

// Prompt the role in its pane while its agent is alive, else in a new worker tab that first gets the brief.
// B005: an alive-but-unprompted pane (pi stopped between tab creation and the prompt) gets the brief
// in its own tab instead of a second tab being opened. prompted[role] is set true BEFORE awaiting
// --wait, so a stop mid-prompt resumes without re-briefing. A missing prompted entry is treated as
// prompted (only explicit false means unprompted), so old task files survive a resume.
// B007: single needBrief branch — the merger's single-block brief already
// contains followUp, other roles append followUp after the brief.
export async function ask(ctx: Ctx, t: Task, role: string, followUp?: string) {
	let pane = t.panes[role];
	const isAlive = await alive(pane);
	let needBrief = false;
	if (!isAlive) {
		const w = await startWorker(ctx, t, role);
		pane = w.pane;
		needBrief = true;
	} else if (t.prompted?.[role] === false) {
		needBrief = true;
	}
	const parts: (string | undefined)[] = [];
	if (needBrief) {
		parts.push(...briefParts(ctx, t, role, followUp));
		if (role !== "merger" && followUp) parts.push(followUp);
	} else if (followUp) {
		parts.push(followUp);
	}
	parts.push(`When finished, write your final report as markdown to ${reportFile(t, role)} and stop.`);
	t.panes[role] = pane;
	ctx.update(t, "running");
	// Mark prompted before awaiting: --wait blocks until the worker finishes, so a pi stop here
	// would otherwise leave prompted[role] false and resume would re-brief a busy/finished worker.
	if (!t.prompted) t.prompted = {};
	t.prompted[role] = true;
	ctx.save(t);
	await herdr("agent", "prompt", pane, parts.filter(Boolean).join("\n\n"), "--wait");
	await settle(ctx, t, pane, role);
}
