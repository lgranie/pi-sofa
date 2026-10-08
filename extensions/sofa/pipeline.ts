/**
 * The factory line for one task, as a stage machine:
 *   herdr worktree (branch sofa/<id>) -> one herdr tab per role -> agent exec via `mise x` (installs it if missing)
 *   -> prompt, supervised through herdr agent state (idle / working / blocked)
 *   -> check gate (exit code) -> re-prompt on failure -> commit -> optional review tab -> report back.
 * Tasks live on the board (board.ts); every change is written to the task's markdown file.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Kind, nextId, readBoard, type Status, type Task, writeTask } from "./board.ts";
import { git, herdr, run, tail } from "./cli.ts";
import { type Agents, type Level, loadAgents, rate } from "./config.ts";
import { harnessFor, type Launch } from "./harness.ts";

export const MAX_ATTEMPTS = 3;
const REPORT_CAP = 6000;

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

// Session state, set by index.ts on session_start. agents is reloaded on every start, so edits apply without /reload.
export interface State {
	tasks: Task[];
	dir: string; // .sofa
	ui?: ExtensionContext;
	agents?: Agents;
}

export function factory(pi: ExtensionAPI) {
	const s: State = { tasks: [], dir: "" };
	const active = (t: Task) => t.status === "running" || t.status === "blocked";

	const save = (t: Task) => {
		writeTask(s.dir, t);
		const count = (st: Status) => s.tasks.filter((x) => x.status === st).length;
		const parts = (["running", "blocked", "ready"] as const).filter(count).map((st) => `${count(st)} ${st}`);
		s.ui?.ui.setStatus("sofa", parts.length ? `🛋 ${parts.join(" · ")}` : undefined);
	};

	// Pick up the board from disk: new files, hand edits and moves. Tasks sofa is running keep their in-memory state.
	const sync = () => {
		for (const d of readBoard(s.dir)) {
			const i = s.tasks.findIndex((t) => (d.id ? t.id === d.id : t.file === d.file));
			if (i < 0) s.tasks.push(d);
			else if (!active(s.tasks[i])) s.tasks[i] = d;
		}
		s.tasks = s.tasks.filter((t) => active(t) || (t.file && fs.existsSync(t.file)));
		for (const t of s.tasks.filter((x) => !x.id)) {
			// hand-written file: give it an id and rewrite it in board format
			t.id = nextId(s.tasks, t.kind);
			t.branch = `sofa/${t.id}`;
			save(t);
		}
	};

	const find = (id: string) => {
		sync();
		const t = s.tasks.find((x) => x.id === id);
		if (!t) throw new Error(`no task ${id}`);
		return t;
	};

	const line = (t: Task) => `${t.id} [${t.kind}${t.level ? ` ${t.level}` : ""}] ${t.status}: ${t.title}${t.note ? ` (${t.note})` : ""}`;

	const notify = (t: Task) => {
		const reports = Object.entries(t.reports)
			.map(([role, r]) => `## ${role}\n${tail(r, REPORT_CAP)}`)
			.join("\n\n");
		pi.sendMessage(
			{ customType: "sofa", content: `sofa ${line(t)}\nbranch ${t.branch} · board ${t.file}\n\n${reports}`, display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	};

	const update = (t: Task, status: Status, note?: string) => {
		t.status = status;
		t.note = note;
		save(t);
	};

	const reportFile = (t: Task, role: string) => path.join(t.worktree!, `.sofa-${role}.md`);
	const rolePrompt = (t: Task, role: string) => s.agents!.roles[role].prompt.replaceAll("{base}", t.base!);
	const alive = async (pane?: string) => !!pane && !!(await herdr("agent", "get", pane).catch(() => undefined))?.agent;

	// Read and remove the role's report so it never ends up in a commit; fall back to the pane's screen.
	async function collect(t: Task, role: string, pane: string) {
		const file = reportFile(t, role);
		if (fs.existsSync(file)) {
			t.reports[role] = fs.readFileSync(file, "utf8");
			fs.rmSync(file);
		} else {
			const r = await herdr("agent", "read", pane, "--source", "recent-unwrapped", "--lines", "80");
			t.reports[role] = r.read?.text ?? r.text ?? JSON.stringify(r);
		}
	}

	// Log one row per worker session with what it cost, read from the harness's own session log.
	async function record(t: Task, role: string, pane: string) {
		const session: string = (await herdr("agent", "get", pane).catch(() => undefined))?.agent?.agent_session?.value ?? "?";
		const level = s.agents!.roles[role].levels[t.level!];
		const usage = session === "?" ? undefined : harnessFor(s.agents!.execs[level.exec].cmd)?.usage?.(session);
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
		if (i < 0) t.log.push(row);
		else t.log[i] = row;
	}

	// Open a tab for the role in the task's worktree and start its exec at the task's level; herdr tells us when it is ready.
	// briefed: the harness took the role description as its system prompt, so messages carry only the task.
	async function startWorker(t: Task, role: string): Promise<{ pane: string; briefed: boolean }> {
		const level = s.agents!.roles[role].levels[t.level!];
		const exec = s.agents!.execs[level.exec];
		const harness = harnessFor(exec.cmd);
		let launch: Launch = { args: [], env: {} };
		if (harness) {
			const file = path.join(s.dir, t.id, `${role}.md`);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, rolePrompt(t, role));
			launch = harness.launch(file, role);
		}
		const env = Object.entries({ SOFA_WORKER: "1", ...launch.env }).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
		const tab = await herdr(
			"tab", "create", "--workspace", t.workspace!, "--cwd", t.worktree!, "--label", `${role}:${t.level}`, ...env, "--no-focus",
		);
		const pane: string = tab.root_pane.pane_id;
		await herdr("pane", "run", pane, [`mise x ${exec.tool} --`, exec.cmd, level.args, ...launch.args].filter(Boolean).join(" "));
		let told = false;
		// ponytail: 5 min covers a first-time mise install; raise it for slow networks
		for (let i = 0; i < 300; i++) {
			const status = (await herdr("agent", "get", pane).catch(() => undefined))?.agent?.agent_status;
			if (status === "idle" || status === "done") return { pane, briefed: !!harness };
			if (status === "blocked" && !told) {
				told = true;
				update(t, "blocked", `${role} needs you at startup in herdr pane ${pane}`);
				notify(t);
			}
			await sleep(1000);
		}
		throw new Error(`herdr never saw ${level.exec} become ready in pane ${pane} (tab "${role}")`);
	}

	// Wait for the worker to settle, then collect its report and cost. A blocked worker is escalated to the user, then awaited.
	async function settle(t: Task, pane: string, role: string) {
		update(t, "running");
		for (;;) {
			const status = (await herdr("agent", "get", pane)).agent?.agent_status;
			if (status === "idle" || status === "done") break;
			if (status === "blocked") {
				update(t, "blocked", `${role} is waiting on you in herdr pane ${pane}`);
				notify(t);
				await herdr("agent", "wait", pane, "--until", "idle", "--until", "done");
				update(t, "running");
			} else {
				await herdr("agent", "wait", pane);
				await sleep(1000); // ponytail: guards a hot loop if herdr keeps reporting "unknown"
			}
		}
		await collect(t, role, pane);
		await record(t, role, pane);
		save(t);
	}

	// Prompt the role in its pane while its agent is alive, else in a new worker tab that first gets the brief.
	async function ask(t: Task, role: string, followUp?: string) {
		let pane = t.panes[role];
		const parts = [followUp];
		if (!(await alive(pane))) {
			const w = await startWorker(t, role);
			pane = w.pane;
			const heading = `${t.kind[0].toUpperCase()}${t.kind.slice(1)} ${t.id}: ${t.title}`;
			parts.unshift(w.briefed ? undefined : rolePrompt(t, role), `# ${heading}\n\n${t.task}`);
		}
		parts.push(`When finished, write your final report as markdown to ${reportFile(t, role)} and stop.`);
		t.panes[role] = pane;
		update(t, "running");
		await herdr("agent", "prompt", pane, parts.filter(Boolean).join("\n\n"), "--wait");
		await settle(t, pane, role);
	}

	// Stage machine. On resume, the stage's worker is awaited if its agent is still alive, never re-prompted.
	async function pipeline(t: Task, resume: boolean) {
		const resumed = async (role: string) => {
			const was = resume;
			resume = false;
			if (!was || !(await alive(t.panes[role]))) return false;
			await settle(t, t.panes[role], role);
			return true;
		};
		const next = (stage: Task["stage"]) => {
			t.stage = stage;
			save(t);
		};

		if (!t.worktree) {
			const wt = await herdr(
				"worktree", "create", "--cwd", t.repo!, "--branch", t.branch, "--base", t.base!, "--label", `sofa-${t.id}`, "--no-focus",
			);
			t.workspace = wt.workspace.workspace_id;
			t.worktree = wt.worktree.path;
			save(t);
		}
		const research = t.kind === "research";
		const lead = research ? "researcher" : "builder";

		if (t.stage === "lead") {
			if (!(await resumed(lead))) await ask(t, lead);
			next(research ? "end" : "check");
		}
		if (t.stage === "check") {
			await resumed(lead); // a fix may have been in progress
			for (let attempt = 1; t.check; attempt++) {
				const c = await run(t.check, [], t.worktree!, true);
				if (c.code === 0) break;
				if (attempt === MAX_ATTEMPTS) throw new Error(`check \`${t.check}\` still failing after ${attempt} attempts:\n${tail(c.out)}`);
				await ask(t, lead, `The check \`${t.check}\` failed (exit ${c.code}). Fix it.\n\n${tail(c.out)}`);
			}
			if (await git(t.worktree!, "status", "--porcelain")) {
				await git(t.worktree!, "add", "-A");
				await git(t.worktree!, "commit", "-m", t.title);
			}
			if ((await git(t.worktree!, "rev-list", "--count", `${t.base}..HEAD`)) === "0") throw new Error("builder made no changes");
			next(t.review ? "review" : "end");
		}
		if (t.stage === "review") {
			if (!(await resumed("reviewer"))) await ask(t, "reviewer");
			next("end");
		}
		update(t, research ? "done" : "ready");
	}

	// Run the pipeline in the background and report the outcome to the orchestrator.
	const launch = (t: Task, resume: boolean) =>
		pipeline(t, resume).then(
			() => notify(t),
			(e) => {
				if (t.status === "discarded") return;
				t.reports.error = e.message;
				update(t, "failed", e.message.split("\n")[0]);
				notify(t);
			},
		);

	// Add a task to the todo column.
	async function create(ctx: ExtensionContext, p: NewTask) {
		sync();
		const repo = await git(path.resolve(ctx.cwd, p.repo ?? "."), "rev-parse", "--show-toplevel");
		const id = nextId(s.tasks, p.kind); // after the await, so concurrent adds get distinct ids
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
			log: [],
			reports: {},
		};
		s.tasks.push(t);
		save(t);
		return t;
	}

	// Start a todo task: rate its level (unless set), pin its base commit, run the pipeline in the background.
	async function start(ctx: ExtensionContext, t: Task) {
		if (t.status !== "todo") throw new Error(`task ${t.id} is ${t.status}, only todo tasks start`);
		s.agents = loadAgents(ctx);
		t.repo = await git(path.resolve(ctx.cwd, t.repo ?? "."), "rev-parse", "--show-toplevel");
		t.base = await git(t.repo, "rev-parse", t.base ?? "HEAD");
		if (!t.level) Object.assign(t, await rate(ctx, s.agents.classifier, t.kind, t.title, t.task).then(({ level, why }) => ({ level, levelWhy: why })));
		update(t, "running");
		launch(t, false);
		return `Started ${line(t)} on ${t.branch}; level ${t.level} (${t.levelWhy})`;
	}

	// Continue an interrupted or failed task from its stage.
	function resume(ctx: ExtensionContext, t: Task) {
		if (t.status !== "interrupted" && t.status !== "failed") throw new Error(`task ${t.id} is ${t.status}, only interrupted or failed tasks resume`);
		s.agents = loadAgents(ctx);
		delete t.reports.error;
		fs.rmSync(path.join(s.dir, t.id, "error.report.md"), { force: true });
		update(t, "running", "resumed");
		// ponytail: after an in-process /reload the old runtime may still supervise this task; resume only after a pi restart then
		launch(t, true);
		return `Resumed ${line(t)} at stage ${t.stage}`;
	}

	return { s, save, sync, find, line, update, create, start, resume };
}
