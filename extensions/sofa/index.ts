/**
 * pi-sofa: Software Factory for pi, on herdr.
 *
 * This pi session is the orchestrator; it hands tasks to worker agents that run in herdr worktrees.
 * Tasks live on a markdown kanban board (board.ts). The factory line is code (pipeline.ts), not prompt.
 * Workers (execs, roles, per-level agents, classifier) are configured in sofa-agents.json (config.ts);
 * harness.ts passes each role its prompt and reads its token cost; cli.ts runs git and herdr.
 * This file wires it into pi: session state, tools and the /sofa command.
 */
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { boardView, KINDS, type Kind } from "./board.ts";
import { git, herdr } from "./cli.ts";
import { LEVELS, loadAgents } from "./config.ts";
import { factory, MAX_ATTEMPTS } from "./pipeline.ts";

export default function (pi: ExtensionAPI) {
	if (process.env.SOFA_WORKER) return; // workers must not run their own factory

	if (process.env.HERDR_ENV !== "1") {
		pi.on("session_start", (_e, ctx) => {
			if (ctx.hasUI) ctx.ui.notify("pi-sofa needs herdr: launch with sofa.ps1 / sofa.sh", "warning");
		});
		return;
	}

	const { s, sync, find, line, update, create, start, resume } = factory(pi);
	const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
	const board = () => {
		sync();
		return boardView(s.tasks);
	};

	pi.on("session_start", (_e, ctx) => {
		s.ui = ctx;
		s.dir = path.join(ctx.cwd, ".sofa");
		s.tasks = [];
		sync();
		// Supervision dies with the session; the herdr tabs live on and sofa_resume picks them back up.
		for (const t of s.tasks) if (t.status === "running" || t.status === "blocked") update(t, "interrupted", t.note);
		try {
			s.agents = loadAgents(ctx);
		} catch (e) {
			ctx.ui.notify(`sofa: ${(e as Error).message}`, "error");
		}
	});

	pi.registerTool({
		name: "sofa_dispatch",
		label: "Sofa dispatch",
		description: [
			"Add a task to the board and start it, unless `queue` is true (then it waits in todo for sofa_start).",
			"Each task runs in its own herdr worktree (branch sofa/<id>), one herdr tab per role. Ids: F001 feature, B001 bug, R001 research.",
			`kind "feature" or "bug": builder implements, \`check\` is enforced by exit code with up to ${MAX_ATTEMPTS} attempts, the work is committed with \`title\` as message, then an optional reviewer reviews.`,
			`kind "research": researcher investigates and reports, no commit.`,
			"A classifier rates the task low/medium/high when it starts, which picks each role's agent and effort; pass `level` only to override it.",
			"Returns immediately; the result arrives later as a sofa message.",
		].join(" "),
		promptSnippet: "Dispatch work to worker agents in a herdr worktree",
		promptGuidelines: [
			"You orchestrate a software factory for the user. Delegate implementation and investigation with sofa_dispatch instead of editing code yourself.",
			"The board (.sofa/board/<column>/<id>-<title>.md) is the task list; the user may add todo tasks there by hand. Use sofa_status to see it.",
			"Workers report back automatically through sofa messages; do not poll sofa_status in a loop.",
			"When a worker is blocked, tell the user which herdr pane needs them. Merge (sofa_finish) only after the user approves.",
			"Offer sofa_resume for interrupted or failed tasks instead of dispatching them again.",
			"Write titles that are valid commit messages for the target repo (include issue keys if its hooks require them).",
		],
		parameters: Type.Object({
			kind: StringEnum(KINDS),
			title: Type.String({ description: "Short title; used as the commit message for feature and bug tasks" }),
			task: Type.String({ description: "Full brief for the workers: goal, constraints, acceptance criteria" }),
			check: Type.Optional(Type.String({ description: "Feature/bug only: shell command that must exit 0 in the worktree, e.g. `npm test`" })),
			review: Type.Optional(Type.Boolean({ description: "Feature/bug only: run the reviewer role after the check passes" })),
			level: Type.Optional(StringEnum(LEVELS, { description: "Override the classifier's level (only when the user asks)" })),
			repo: Type.Optional(Type.String({ description: "Path of the git repo (default: current directory)" })),
			base: Type.Optional(Type.String({ description: "Git ref to branch from (default: HEAD when started)" })),
			queue: Type.Optional(Type.Boolean({ description: "Only add to the todo backlog; start later with sofa_start" })),
		}),
		async execute(_id, { queue, ...p }, _signal, _onUpdate, ctx) {
			const t = await create(ctx, p);
			return text(queue ? `Queued ${line(t)} in todo` : await start(ctx, t));
		},
	});

	pi.registerTool({
		name: "sofa_start",
		label: "Sofa start",
		description: "Start a task waiting in the todo column of the board.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, { id }, _signal, _onUpdate, ctx) {
			return text(await start(ctx, find(id)));
		},
	});

	pi.registerTool({
		name: "sofa_status",
		label: "Sofa status",
		description: "Show the task board: tasks per column (todo, running, blocked, ready, done, failed, interrupted, merged, discarded).",
		parameters: Type.Object({}),
		async execute() {
			return text(board());
		},
	});

	pi.registerTool({
		name: "sofa_resume",
		label: "Sofa resume",
		description:
			"Resume an interrupted or failed task from the stage it stopped at (lead, check, review). A worker whose agent is still alive in its herdr pane is awaited, not re-prompted; otherwise a new worker gets the brief. A failed check gets fresh attempts.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, { id }, _signal, _onUpdate, ctx) {
			return text(resume(ctx, find(id)));
		},
	});

	pi.registerTool({
		name: "sofa_finish",
		label: "Sofa finish",
		description:
			"Finish a task. merge: merge its branch (ready feature/bug tasks only) into the repo's current branch, then remove the worktree. discard: stop the workers, remove the worktree and delete the branch.",
		parameters: Type.Object({
			id: Type.String(),
			action: StringEnum(["merge", "discard"] as const),
		}),
		async execute(_id, { id, action }, _signal, _onUpdate, ctx) {
			const t = find(id);
			if (action === "merge") {
				if (t.status !== "ready") throw new Error(`task ${id} is ${t.status}, only ready feature/bug tasks merge`);
				const into = await git(t.repo!, "branch", "--show-current");
				if (ctx.hasUI && !(await ctx.ui.confirm(`Merge ${t.branch} into ${into}?`, `${t.title}\n${t.repo}`)))
					return text("User declined the merge.");
				try {
					await git(t.repo!, "merge", "--no-ff", t.branch, "-m", t.title);
				} catch (e) {
					await git(t.repo!, "merge", "--abort").catch(() => {});
					throw e;
				}
				await herdr("worktree", "remove", "--workspace", t.workspace!); // fail-closed: refuses a dirty worktree
				await git(t.repo!, "branch", "-d", t.branch);
				update(t, "merged", `into ${into}`);
			} else {
				update(t, "discarded");
				if (t.workspace) await herdr("worktree", "remove", "--workspace", t.workspace, "--force").catch(() => {});
				if (t.repo) await git(t.repo, "branch", "-D", t.branch).catch(() => {});
			}
			return text(line(t));
		},
	});

	const help = (ctx: ExtensionContext) => {
		let workers: string;
		try {
			const a = loadAgents(ctx);
			const run = (r: { exec: string; args?: string }) => `${r.exec}${r.args ? ` ${r.args}` : ""}`;
			workers = [
				`config     ${a.file}`,
				`classifier ${a.classifier ?? "first available (none: medium)"}`,
				...Object.entries(a.roles).map(
					([role, r]) => `${role.padEnd(10)} ${LEVELS.map((l) => `${l}: ${run(r.levels[l])}`).join(" | ")}`,
				),
			].join("\n");
		} catch (e) {
			workers = `config error: ${(e as Error).message}`;
		}
		return [
			"sofa: software factory. Talk to this session (the orchestrator); worker agents run in herdr worktrees.",
			"",
			"/sofa                                    show the board",
			"/sofa add [feature|bug|research] [title] add a todo task (asks for what is missing)",
			"/sofa start <id>                         start a todo task",
			"/sofa help                               this help",
			"",
			`Board: ${s.dir}${path.sep}board${path.sep}<column>${path.sep}<id>-<title>.md, one file per task; drop a .md in todo/ to add one by hand`,
			"Task ids: F001 feature, B001 bug, R001 research",
			"Orchestrator tools: sofa_dispatch, sofa_start, sofa_status, sofa_resume, sofa_finish (merge | discard)",
			`Feature / bug: classify level -> worktree sofa/<id> -> builder tab -> check gate (${MAX_ATTEMPTS} tries) -> commit -> reviewer tab -> report`,
			"Research: classify level -> worktree -> researcher tab -> report",
			"Interrupted (pi restarted) or failed tasks: sofa_resume continues from their stage, reusing live herdr panes",
			"",
			workers,
		].join("\n");
	};

	// /sofa add [kind] [title]: a todo task without the orchestrator's model; dialogs ask for what is missing, cancel aborts.
	async function add(ctx: ExtensionContext, words: string[]) {
		const kind = KINDS.find((k) => k === words[0]) ?? (await ctx.ui.select("Task kind", [...KINDS]));
		if (!kind) return;
		if (words[0] === kind) words.shift();
		const title = words.join(" ") || (await ctx.ui.input("Title (also the commit message)", ""))?.trim();
		if (!title) return;
		const brief = await ctx.ui.editor(`Brief for ${kind} "${title}": goal, constraints, acceptance criteria`, "");
		if (brief === undefined) return;
		let check: string | undefined;
		let review = false;
		if (kind !== "research") {
			check = (await ctx.ui.input("Check command that must exit 0 (empty: none)", "npm test"))?.trim() || undefined;
			review = await ctx.ui.confirm("Review", "Run the reviewer after the check passes?");
		}
		const t = await create(ctx, { kind: kind as Kind, title, task: brief.trim() || title, check, review });
		ctx.ui.notify(`Added ${line(t)} to todo. Start it with /sofa start ${t.id}`, "info");
	}

	pi.registerCommand("sofa", {
		description: "Show the task board; /sofa add, /sofa start <id>, /sofa help",
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (!sub) ctx.ui.notify(board(), "info");
				else if (sub === "add") await add(ctx, rest);
				else if (sub === "start" && rest[0]) ctx.ui.notify(await start(ctx, find(rest[0].toUpperCase())), "info");
				else ctx.ui.notify(help(ctx), "info");
			} catch (e) {
				ctx.ui.notify(`sofa: ${(e as Error).message}`, "error");
			}
		},
	});
}
