/**
 * Task model and the kanban board: one markdown file per task, one directory per column.
 *
 *   .sofa/board/<column>/<id>-<slug>.md   front matter (one `key: <JSON>` per line) + title + brief + report links + log
 *   .sofa/<id>/<role>.report.md           worker reports (kept apart: their own headings would break parsing)
 *   .sofa/<id>/<role>.md                  role prompt handed to the harness
 *
 * The column is the status. Files can be written or edited by hand; front matter is optional for a new todo task.
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
	stage: "lead" | "check" | "review" | "end"; // where the pipeline is; resume restarts here
	panes: Record<string, string>; // role -> herdr pane it was prompted in
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

// Front-matter fields, in file order. title, task, status, log and reports live in the body, the path or report files.
const FIELDS = ["id", "kind", "level", "levelWhy", "check", "review", "repo", "base", "branch", "workspace", "worktree", "stage", "panes", "note"] as const;
const LOG_HEAD = "| finished | role | agent | session | tokens in | tokens out | cost |\n|---|---|---|---|---|---|---|";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const num = (s: string) => (s.trim() && s.trim() !== "-" ? Number(s.replace(/[$,]/g, "")) : undefined);
const cell = (v?: number, money = false) => (v === undefined ? "-" : money ? `$${v.toFixed(4)}` : String(v));

export function render(t: Task) {
	const fm = FIELDS.filter((k) => t[k] !== undefined).map((k) => `${k}: ${JSON.stringify(t[k])}`);
	const reports = Object.keys(t.reports).map((role) => `- [${role}](../../${t.id}/${role}.report.md)`);
	const rows = t.log.map(
		(r) => `| ${r.finished} | ${r.role} | ${r.agent} | ${r.session} | ${cell(r.input)} | ${cell(r.output)} | ${cell(r.cost, true)} |`,
	);
	return [`---\n${fm.join("\n")}\n---`, `# ${t.id} ${t.title}`, t.task, "## Reports", reports.join("\n") || "-", "## Log", [LOG_HEAD, ...rows].join("\n")].join("\n\n") + "\n";
}

// Parse a board file. Missing id/kind are left for the caller (a hand-written todo task).
export function parse(file: string, status: Status, dir: string): Task {
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
	const id: string = fm.id ?? path.basename(file).match(/^[FBR]\d{3,}/)?.[0] ?? titleLine.match(/^[FBR]\d{3,}/)?.[0] ?? "";
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
		status,
		review: fm.review === true,
		branch: fm.branch ?? (id ? `sofa/${id}` : ""),
		stage: fm.stage ?? "lead",
		panes: fm.panes ?? {},
		log,
		reports,
		file,
	} as Task;
}

// All tasks on the board under dir (.sofa).
export function readBoard(dir: string): Task[] {
	return COLUMNS.flatMap((col) => {
		const d = path.join(dir, "board", col);
		return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".md")).map((f) => parse(path.join(d, f), col, dir)) : [];
	});
}

// Write the task into its status column (moving it if the status changed) and its reports next to it.
export function writeTask(dir: string, t: Task) {
	fs.mkdirSync(path.join(dir, "board"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".gitignore"), "*\n");
	const target = path.join(dir, "board", t.status, `${t.id}-${slug(t.title)}.md`);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, render(t));
	if (t.file && t.file !== target) fs.rmSync(t.file, { force: true });
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
