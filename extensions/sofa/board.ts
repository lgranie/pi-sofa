/**
 * Task model and the board: one directory per task.
 *
 *   .sofa/<id>/task.md              front matter (one `key: <JSON>` per line) + title + brief + report links + log
 *   .sofa/<id>/<role>.report.md     worker reports (kept apart: their own headings would break parsing)
 *   .sofa/<id>/<role>.md            role prompt handed to the harness
 *   .sofa/board/todo/*.md           drop-in chute for hand-written tasks; migrated on id assignment
 *
 * The status lives in front matter, not in the path. Files can be written or edited by hand;
 * front matter is optional for a new todo task. Deleting a task is `rm -rf .sofa/<id>`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Level } from "./config.ts";

// Features and bugs run the build line (builder, check, commit, review); research only reports.
export const KINDS = ["feature", "bug", "research"] as const;
export type Kind = (typeof KINDS)[number];
const PREFIX: Record<Kind, string> = { feature: "F", bug: "B", research: "R" };

export const COLUMNS = ["todo", "running", "blocked", "ready", "done", "failed", "interrupted", "merged", "discarded"] as const;
export type Status = (typeof COLUMNS)[number];

// One row per worker session: what the role cost.
export interface LogRow {
	finished: string;
	role: string;
	agent: string;
	session: string;
	input?: number;
	output?: number;
	cost?: number;
}

export interface Task {
	id: string;
	kind: Kind;
	title: string;
	task: string;
	status: Status;
	check?: string;
	review: boolean;
	repo?: string;
	level?: Level; // set when started
	levelWhy?: string;
	base?: string;
	branch: string;
	workspace?: string;
	worktree?: string;
	note?: string;
	testsChanged?: string[]; // test files the builder modified/deleted since base (set in check stage, survives status updates)
	stage: "lead" | "repro" | "check" | "review" | "end"; // where the pipeline is; resume restarts here
	panes: Record<string, string>; // role -> herdr pane it was prompted in
	prompted?: Record<string, boolean>; // role -> the pane's worker was prompted (false: tab opened but brief never sent; resume reuses it)
	log: LogRow[];
	reports: Record<string, string>; // role -> report text (stored in .sofa/<id>/<role>.report.md)
	file?: string; // board file it was read from / written to
}

// Next id for the kind: prefix + 3-digit sequence per prefix (F001, F002, B001...).
export function nextId(tasks: { id: string }[], kind: Kind) {
	const p = PREFIX[kind];
	const n = Math.max(0, ...tasks.filter((t) => t.id.startsWith(p)).map((t) => Number(t.id.slice(1)) || 0));
	return `${p}${String(n + 1).padStart(3, "0")}`;
}

// Front-matter fields, in file order. title, task, log and reports live in the body, the path or report files.
const FIELDS = ["id", "kind", "status", "level", "levelWhy", "check", "review", "repo", "base", "branch", "workspace", "worktree", "stage", "panes", "prompted", "note", "testsChanged"] as const;
const LOG_HEAD = "| finished | role | agent | session | tokens in | tokens out | cost |\n|---|---|---|---|---|---|---|";

const num = (s: string) => (s.trim() && s.trim() !== "-" ? Number(s.replace(/[$,]/g, "")) : undefined);
const cell = (v?: number, money = false) => (v === undefined ? "-" : money ? `$${v.toFixed(4)}` : String(v));

export function render(t: Task) {
	const fm = FIELDS.filter((k) => t[k] !== undefined).map((k) => `${k}: ${JSON.stringify(t[k])}`);
	const reports = Object.keys(t.reports).map((role) => `- [${role}](./${role}.report.md)`);
	const rows = t.log.map(
		(r) => `| ${r.finished} | ${r.role} | ${r.agent} | ${r.session} | ${cell(r.input)} | ${cell(r.output)} | ${cell(r.cost, true)} |`,
	);
	return [`---\n${fm.join("\n")}\n---`, `# ${t.id} ${t.title}`, t.task, "## Reports", reports.join("\n") || "-", "## Log", [LOG_HEAD, ...rows].join("\n")].join("\n\n") + "\n";
}

// Parse a task file. Missing id/kind are left for the caller (a hand-written todo task).
// Status comes from front matter; files without one (hand-written chute files) get the fallback.
export function parse(file: string, dir: string, fallbackStatus: Status = "todo"): Task {
	const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
	const fm: Record<string, any> = {};
	let body = text;
	if (text.startsWith("---\n")) {
		const end = text.indexOf("\n---", 4);
		for (const l of text.slice(4, end).split("\n")) {
			const i = l.indexOf(":");
			if (i < 0) continue;
			const v = l.slice(i + 1).trim();
			try {
				fm[l.slice(0, i).trim()] = JSON.parse(v);
			} catch {
				fm[l.slice(0, i).trim()] = v; // hand-written: `kind: bug`
			}
		}
		body = text.slice(end + 4);
	}
	const sections = body.split(/\n## (?=Reports\n|Log\n)/);
	const head = sections[0].trim();
	const titleLine = head.match(/^# (.*)$/m)?.[1] ?? path.basename(file, ".md");
	const id: string = fm.id ?? path.basename(path.dirname(file)).match(/^[FBR]\d{3,}/)?.[0] ?? path.basename(file).match(/^[FBR]\d{3,}/)?.[0] ?? titleLine.match(/^[FBR]\d{3,}/)?.[0] ?? "";
	const kind: Kind = KINDS.includes(fm.kind) ? fm.kind : (KINDS.find((k) => PREFIX[k] === id[0]) ?? "feature");
	const title = titleLine.replace(/^[FBR]\d{3,}\s*/, "").trim();
	const task = head.replace(/^# .*$/m, "").trim() || title;

	const logText = sections.find((s) => s.startsWith("Log\n")) ?? "";
	const log: LogRow[] = logText
		.split("\n")
		.filter((l) => l.startsWith("|") && !l.startsWith("|---") && !l.startsWith("| finished"))
		.map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
		.map(([finished, role, agent, session, input, output, cost]) => ({ finished, role, agent, session, input: num(input), output: num(output), cost: num(cost) }));

	const reports: Record<string, string> = {};
	const rdir = path.join(dir, id || "-");
	if (id && fs.existsSync(rdir))
		for (const f of fs.readdirSync(rdir).filter((f) => f.endsWith(".report.md")))
			reports[f.slice(0, -".report.md".length)] = fs.readFileSync(path.join(rdir, f), "utf8");

	return {
		...fm,
		id,
		kind,
		title,
		task,
		status: COLUMNS.includes(fm.status) ? fm.status : fallbackStatus,
		review: fm.review === true,
		branch: fm.branch ?? (id ? `sofa/${id}` : ""),
		stage: fm.stage ?? "lead",
		panes: fm.panes ?? {},
		prompted: fm.prompted ?? {},
		log,
		reports,
		file,
	} as Task;
}

// All tasks under dir (.sofa): one task.md per task dir plus the hand-written board/todo chute.
// Legacy board/<column>/*.md files (pre-F011) are migrated into their task dirs first,
// with the column injected as status, so live tasks keep history and reports.
export function readBoard(dir: string): Task[] {
	migrateBoard(dir);
	const tasks: Task[] = [];
	if (fs.existsSync(dir))
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!e.isDirectory() || e.name === "board") continue;
			const f = path.join(dir, e.name, "task.md");
			if (fs.existsSync(f)) tasks.push(parse(f, dir));
		}
	const todo = path.join(dir, "board", "todo");
	if (fs.existsSync(todo))
		for (const f of fs.readdirSync(todo).filter((f) => f.endsWith(".md"))) tasks.push(parse(path.join(todo, f), dir, "todo"));
	return tasks;
}

// Move legacy board/<column>/*.md files into .sofa/<id>/task.md with `status: <column>`
// injected (rendered via writeTask, so report links are rewritten too). Only todo/
// survives under board/; other column dirs are removed once empty. The todo chute
// is left alone: id-bearing todo files migrate via sync()/writeTask on id assignment.
function migrateBoard(dir: string) {
	const board = path.join(dir, "board");
	if (!fs.existsSync(board)) return;
	for (const col of COLUMNS) {
		if (col === "todo") continue;
		const d = path.join(board, col);
		if (!fs.existsSync(d)) continue;
		for (const f of fs.readdirSync(d).filter((f) => f.endsWith(".md"))) {
			try {
				const t = parse(path.join(d, f), dir, col);
				if (!t.id) continue;
				t.status = col;
				writeTask(dir, t);
			} catch {
				// leave unparseable files for a human
			}
		}
		try {
			if (fs.readdirSync(d).length === 0) fs.rmdirSync(d);
		} catch {}
	}
}

// Write the task into its task dir in place (no moves across column dirs, no filename
// churn) and its reports next to it. Removes the previous file when it differs, which
// covers both the legacy board/<column> path and the board/todo chute on id assignment.
export function writeTask(dir: string, t: Task) {
	if (!t.id) throw new Error("writeTask requires an id (hand-written tasks get one in sync())");
	fs.mkdirSync(path.join(dir, "board", "todo"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".gitignore"), "*\n");
	const target = path.join(dir, t.id, "task.md");
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, render(t));
	if (t.file && t.file !== target) {
		fs.rmSync(t.file, { force: true });
		// Best-effort: drop the legacy column dir left behind (never the todo chute).
		const prevDir = path.dirname(t.file);
		const col = path.basename(prevDir);
		if (path.basename(path.dirname(prevDir)) === "board" && col !== "todo") {
			try {
				if (fs.existsSync(prevDir) && fs.readdirSync(prevDir).length === 0) fs.rmdirSync(prevDir);
			} catch {}
		}
	}
	t.file = target;
	for (const [role, text] of Object.entries(t.reports)) {
		fs.mkdirSync(path.join(dir, t.id), { recursive: true });
		fs.writeFileSync(path.join(dir, t.id, `${role}.report.md`), text);
	}
}

// Board view for /sofa and sofa_status: non-empty columns with their tasks.
export function boardView(tasks: Task[]) {
	const lines = COLUMNS.flatMap((col) => {
		const ts = tasks.filter((t) => t.status === col);
		return ts.length ? [`${col} (${ts.length})`, ...ts.map((t) => `  ${t.id} ${t.title}${t.level ? ` [${t.level}]` : ""}${t.note ? ` (${t.note})` : ""}`)] : [];
	});
	return lines.join("\n") || "Board is empty.";
}
