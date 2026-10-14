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
import { canStart, resolveMaxRunning } from "./concurrency.ts";
import { harnessFor, type Launch } from "./harness.ts";
import { extractReportText, summaryLine } from "./report.ts";
import { isBugReproduced, nextStageAfterLead } from "./stage.ts";
import { changedTestFiles } from "./tests.ts";

export const MAX_ATTEMPTS = 3;

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
		const failed = t.status === "failed";
		const lines = [`sofa ${line(t)}`, `branch ${t.branch} · board ${t.file}`];
		if (t.testsChanged?.length) lines.push(`Changed tests: ${t.testsChanged.join(", ")}`);
		for (const [role, r] of Object.entries(t.reports)) {
			if (role === "error") continue;
			lines.push(`- ${role}: ${summaryLine(r)} · .sofa/${t.id}/${role}.report.md`);
		}
		if (failed && t.reports.error) lines.push("", "Error:", t.reports.error);
		pi.sendMessage(
			{ customType: "sofa", content: lines.join("\n"), display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	};

	const update = (t: Task, status: Status, note?: string) => {
		t.status = status;
		t.note = note;
		save(t);
	};

	const reportFile = (t: Task, role: string) => path.join(t.worktree!, `.sofa-${role}.md`);
	const rolePrompt = (t: Task, role: string) => {
		const prompt = s.agents!.roles[role].prompt.replaceAll("{base}", t.base!);
		if (role === "reviewer" && t.testsChanged?.length)
			return `${prompt}\n\n## Changed tests\n${t.testsChanged.join(", ")}\n\nSome existing test files were modified or deleted by the builder after the check passed. Judge whether the change weakens the test (e.g. relaxes an assertion, removes coverage, or makes the check pass without fixing the underlying behaviour) and say so in your report.`;
		return prompt;
	};
	const alive = async (pane?: string) => !!pane && !!(await herdr("agent", "get", pane).catch(() => undefined))?.agent;

	// Read and remove the role's report so it never ends up in a commit; fall back to the pane's screen.
	async function collect(t: Task, role: string, pane: string) {
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

	// Marker row for non-worker events (repro gate, check pass) so the board log shows the bug was reproduced / fixed.
	const logEvent = (t: Task, role: string) => {
		// Skip if a row with the same role already exists: on resume the repro/check stages re-run and would push a duplicate.
		if (t.log.some((r) => r.role === role)) return;
		t.log.push({
			finished: new Date().toISOString().slice(0, 16).replace("T", " "),
			role,
			agent: "-",
			session: "-",
		});
		save(t);
	};

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
		// B002/B005: record the pane right after the tab is created (unprompted for now) so a stop
		// before the first prompt never orphans the tab, and resume can tell it apart from a dead one.
		t.panes[role] = pane;
		if (!t.prompted) t.prompted = {};
		t.prompted[role] = false;
		save(t);
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

	// The heading + brief parts prepended when a worker is first (re)briefed. Extracted so the
	// dead-tab and unprompted-tab branches cannot drift from each other.
	const briefParts = (t: Task, role: string): [string | undefined, string] => {
		const level = s.agents!.roles[role].levels[t.level!];
		const briefed = !!harnessFor(s.agents!.execs[level.exec].cmd);
		const heading = `${t.kind[0].toUpperCase()}${t.kind.slice(1)} ${t.id}: ${t.title}`;
		return [briefed ? undefined : rolePrompt(t, role), `# ${heading}\n\n${t.task}`];
	};

	// Prompt the role in its pane while its agent is alive, else in a new worker tab that first gets the brief.
	// B005: an alive-but-unprompted pane (pi stopped between tab creation and the prompt) gets the brief
	// in its own tab instead of a second tab being opened. prompted[role] is set true BEFORE awaiting
	// --wait, so a stop mid-prompt resumes without re-briefing. A missing prompted entry is treated as
	// prompted (only explicit false means unprompted), so old task files survive a resume.
	async function ask(t: Task, role: string, followUp?: string) {
		const parts = [followUp];
		let pane = t.panes[role];
		if (!(await alive(pane))) {
			const w = await startWorker(t, role);
			pane = w.pane;
			parts.unshift(...briefParts(t, role));
		} else if (t.prompted?.[role] === false) {
			parts.unshift(...briefParts(t, role));
		}
		parts.push(`When finished, write your final report as markdown to ${reportFile(t, role)} and stop.`);
		t.panes[role] = pane;
		update(t, "running");
		// Mark prompted before awaiting: --wait blocks until the worker finishes, so a pi stop here
		// would otherwise leave prompted[role] false and resume would re-brief a busy/finished worker.
		if (!t.prompted) t.prompted = {};
		t.prompted[role] = true;
		save(t);
		await herdr("agent", "prompt", pane, parts.filter(Boolean).join("\n\n"), "--wait");
		await settle(t, pane, role);
	}

	// Stage machine. On resume, the stage's worker is awaited if its agent is still alive, never re-prompted.
	async function pipeline(t: Task, resume: boolean) {
		const resumed = async (role: string) => {
			const was = resume;
			resume = false;
			if (!was || !(await alive(t.panes[role]))) return false;
			// B005: only an explicit false means unprompted. A missing entry means the worker was
			// prompted (old task file, or prompted before this field existed) — settle it, don't re-brief.
			if (t.prompted?.[role] === false) return false; // tab opened but brief never sent: ask() briefs the same tab
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
			if (!(await resumed(lead))) {
				// Bug tasks with a check: the builder must first write a reproducer, not the fix. The fix arrives as a
				// separate prompt in the check stage ("The check failed. Fix it.").
				const followUp =
					t.kind === "bug" && t.check
						? "This is a bug task: write a test or script that reproduces the bug (make the check fail) WITHOUT fixing it. Do not fix the bug yet — the fix comes later, in a separate step."
						: undefined;
				await ask(t, lead, followUp);
			}
			next(nextStageAfterLead(t.kind, Boolean(t.check)));
		}
		if (t.stage === "repro") {
			// Reproduce-first gate for bug tasks: the check must FAIL to prove the bug exists
			await resumed(lead); // a repro attempt may have been in progress
			for (let attempt = 1; t.check; attempt++) {
				const c = await run(t.check, [], t.worktree!, true);
				if (isBugReproduced(c.code)) {
					logEvent(t, "repro"); // check failed: the bug was reproduced
					break;
				}
				if (attempt === MAX_ATTEMPTS)
					throw new Error(`check \`${t.check}\` still passes after ${attempt} attempts; the bug was not reproduced\n\n${tail(c.out)}`);
				await ask(t, lead, `The check \`${t.check}\` passed (exit 0), so the bug is not reproduced. Add a test or script that fails to demonstrate the bug, without fixing it.\n\n${tail(c.out)}`);
			}
			next("check");
		}
		if (t.stage === "check") {
			await resumed(lead); // a fix may have been in progress
			for (let attempt = 1; t.check; attempt++) {
				const c = await run(t.check, [], t.worktree!, true);
				if (c.code === 0) {
					if (t.kind === "bug") logEvent(t, "check"); // check passed: the bug is fixed
					break;
				}
				if (attempt === MAX_ATTEMPTS) throw new Error(`check \`${t.check}\` still failing after ${attempt} attempts:\n${tail(c.out)}`);
				await ask(t, lead, `The check \`${t.check}\` failed (exit ${c.code}). Fix it.\n\n${tail(c.out)}`);
			}
			if (await git(t.worktree!, "status", "--porcelain")) {
				await git(t.worktree!, "add", "-A");
				await git(t.worktree!, "commit", "-m", t.title);
			}
			if ((await git(t.worktree!, "rev-list", "--count", `${t.base}..HEAD`)) === "0") throw new Error("builder made no changes");
		// Flag test files the builder modified or deleted since the base: an agent can make check pass by weakening its own tests.
		// Stored in its own field so it survives later status updates (unlike t.note) and reaches notify + the reviewer prompt.
		const tests = changedTestFiles(await git(t.worktree!, "-c", "core.quotePath=false", "diff", "--name-status", `${t.base}..HEAD`));
		if (tests.length) {
			t.testsChanged = tests;
			save(t);
		}
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
			async (e) => {
				if (t.status === "discarded") return;
				// B001: log the cost of unsettled workers so a failed task lists a row
				// for each prompted worker. The session id is read while the pane still exists.
				for (const [role, pane] of Object.entries(t.panes)) {
					try {
						const session: string | undefined = (await herdr("agent", "get", pane).catch(() => undefined))?.agent
							?.agent_session?.value;
						if (session && t.log.some((r) => r.role === role && r.session === session)) continue;
						await record(t, role, pane);
					} catch {
						// best-effort: a dead pane must not hide the pipeline error
					}
				}
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
			prompted: {},
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
		const max = resolveMaxRunning(s.agents.maxRunning);
		if (!canStart(s.tasks, max)) throw new Error(`max ${max} tasks already running/blocked; start fewer or wait`);
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
