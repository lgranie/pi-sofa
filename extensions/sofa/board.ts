/**
 * Task model and the board: one directory per task, moved between state dirs.
 *
 *   .sofa/board/<column>/<id>/task.md         front matter (one `key: <JSON>` per line) + title + brief + report links + log
 *   .sofa/board/<column>/<id>/<role>.md       role prompt handed to the harness
 *   .sofa/board/<column>/<id>/<role>.report.md worker reports (kept apart: their own headings would break parsing)
 *   .sofa/board/todo/<name>/task.md           drop-in chute for hand-written tasks (dir-only);
 *                                              renamed to the id on assignment
 *
 * The column directory is the status: moving a task moves its directory.
 * Dirs are id-only (no slug); the title lives inside the file. Files can be
 * written or edited by hand; front matter is optional for a new todo task.
 * Deleting a task is `rm -rf .sofa/board/<column>/<id>`.
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
	reports: Record<string, string>; // role -> report text (stored next to task.md as <role>.report.md)
	file?: string; // task.md it was read from / written to
}

// Next id for the kind: prefix + 3-digit sequence per prefix (F001, F002, B001...).
export function nextId(tasks: { id: string }[], kind: Kind) {
	const p = PREFIX[kind];
	const n = Math.max(0, ...tasks.filter((t) => t.id.startsWith(p)).map((t) => Number(t.id.slice(1)) || 0));
	return `${p}${String(n + 1).padStart(3, "0")}`;
}

// Front-matter fields, in file order. title, task, log and reports live in the body, the path or report files.
const FIELDS = ["id", "kind", "level", "levelWhy", "check", "review", "repo", "base", "branch", "workspace", "worktree", "stage", "panes", "prompted", "note", "testsChanged"] as const;
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

// Parse a task.md. The column directory is the status; the task dir is id-only.
// Missing id/kind are left for the caller (a hand-written todo task).
export function parse(file: string, status: Status): Task {
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
	const dirName = path.basename(path.dirname(file));
	const id: string = fm.id ?? (dirName.match(/^[FBR]\d{3,}/)?.[0] ?? "") ?? titleLine.match(/^[FBR]\d{3,}/)?.[0] ?? "";
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
	const rdir = path.dirname(file);
	for (const f of fs.existsSync(rdir) ? fs.readdirSync(rdir).filter((f) => f.endsWith(".report.md")) : [])
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
		prompted: fm.prompted ?? {},
		log,
		reports,
		file,
	} as Task;
}

// All tasks on the board: one task.md per task dir under board/<column>/.
// Older layouts are migrated into place first (best-effort, never throws):
// F011 top-level .sofa/<id>/task.md dirs (status from front matter) and
// pre-F011 loose board/<column>/*.md files (status from the column, reports
// from the top-level .sofa/<id>/ sidecar dir). Same-id duplicates prefer the
// task-dir version; stale copies are removed.
export function readBoard(dir: string): Task[] {
	migrateLegacy(dir);
	const tasks: Task[] = [];
	const board = path.join(dir, "board");
	if (!fs.existsSync(board)) return tasks;
	for (const col of COLUMNS) {
		const d = path.join(board, col);
		if (!fs.existsSync(d)) continue;
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			if (!e.isDirectory()) continue;
			const f = path.join(d, e.name, "task.md");
			if (fs.existsSync(f)) tasks.push(parse(f, col));
		}
	}
	return tasks;
}

// Read a `status: "<col>"` front-matter value without a full parse.
function readFmStatus(file: string): Status | undefined {
	try {
		const m = fs.readFileSync(file, "utf8").match(/^status: (.*)$/m)?.[1].trim();
		if (!m) return undefined;
		const v = JSON.parse(m);
		return COLUMNS.includes(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

function taskDirExists(dir: string, id: string): boolean {
	for (const col of COLUMNS) if (fs.existsSync(path.join(dir, "board", col, id, "task.md"))) return true;
	return false;
}

function migrateLegacy(dir: string) {
	const board = path.join(dir, "board");
	// (a) F011 top-level <id>/task.md dirs (status from front matter).
	if (fs.existsSync(dir))
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!e.isDirectory() || e.name === "board") continue;
			const f = path.join(dir, e.name, "task.md");
			if (!fs.existsSync(f)) continue;
			try {
				const t = parse(f, readFmStatus(f) ?? "todo");
				if (!t.id) continue;
				if (taskDirExists(dir, t.id)) continue; // already migrated: leave for a human
				writeTask(dir, t); // moves the whole dir, sidecars travel
			} catch {
				// leave unparseable dirs for a human
			}
		}
	if (!fs.existsSync(board)) return;
	// (b) pre-F011 loose board/<column>/*.md files (todo chute handled below).
	// Reports and prompts live in the top-level .sofa/<id>/ sidecar dir.
	for (const col of COLUMNS) {
		if (col === "todo") continue;
		const d = path.join(board, col);
		if (!fs.existsSync(d)) continue;
		const loose = fs.readdirSync(d).filter((f) => f.endsWith(".md"));
		// Newest first so the freshest copy wins when an id appears twice.
		loose.sort((a, b) => fs.statSync(path.join(d, b)).mtimeMs - fs.statSync(path.join(d, a)).mtimeMs);
		for (const name of loose) {
			const f = path.join(d, name);
			try {
				const t = parse(f, col);
				if (!t.id || taskDirExists(dir, t.id)) continue; // migrated already: leave for a human
				// Fold the top-level sidecar dir in: reports into memory (written
				// by writeTask), every other file moved next to the new task.md.
				const side = path.join(dir, t.id);
				t.file = f;
				writeTask(dir, t);
				if (fs.existsSync(side)) {
					const targetDir = path.join(board, t.status, t.id);
					for (const entry of fs.readdirSync(side)) {
						if (entry === "task.md") continue; // stale: fresh one written
						try {
							if (entry.endsWith(".report.md")) {
								const role = entry.slice(0, -".report.md".length);
								t.reports[role] ??= fs.readFileSync(path.join(side, entry), "utf8");
							}
							fs.renameSync(path.join(side, entry), path.join(targetDir, entry));
						} catch {}
					}
					// Re-save so folded reports are all on disk next to task.md.
					writeTask(dir, t);
					try {
						if (fs.readdirSync(side).length === 0) fs.rmdirSync(side);
					} catch {}
				}
				fs.rmSync(f, { force: true }); // absorbed: content + sidecars moved
			} catch {
				// leave unparseable files for a human
			}
		}
		try {
			if (fs.readdirSync(d).length === 0) fs.rmdirSync(d);
		} catch {}
	}
	// (c) todo chute: loose .md files become todo/<stem>/task.md dirs (dir-only intake).
	const todo = path.join(board, "todo");
	if (fs.existsSync(todo))
		for (const name of fs.readdirSync(todo).filter((f) => f.endsWith(".md"))) {
			const f = path.join(todo, name);
			try {
				const target = path.join(todo, path.basename(name, ".md"), "task.md");
				if (fs.existsSync(target)) continue; // name clash: leave for a human
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.renameSync(f, target);
			} catch {
				// leave it for a human
			}
		}
}

// Write the task into board/<status>/<id>/task.md with its reports next to it.
// A status change moves the whole directory: sidecars travel with the task.
export function writeTask(dir: string, t: Task) {
	if (!t.id) throw new Error("writeTask requires an id (hand-written tasks get one in sync())");
	fs.mkdirSync(path.join(dir, "board", "todo"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".gitignore"), "*\n");
	const targetDir = path.join(dir, "board", t.status, t.id);
	const target = path.join(targetDir, "task.md");
	fs.mkdirSync(targetDir, { recursive: true });
	fs.writeFileSync(target, render(t));
	if (t.file && path.dirname(t.file) !== targetDir) {
		const prevDir = path.dirname(t.file);
		if (path.basename(prevDir) === t.id) {
			// Per-task dir (another column, F011 top-level, todo intake):
			// sidecars travel; the stale task.md does not (fresh one written).
			if (fs.existsSync(prevDir)) {
				for (const entry of fs.readdirSync(prevDir)) {
					if (entry === "task.md") continue;
					try {
						fs.renameSync(path.join(prevDir, entry), path.join(targetDir, entry));
					} catch {}
				}
				fs.rmSync(path.join(prevDir, "task.md"), { force: true });
			}
		} else {
			// Shared dir (legacy loose column file): drop just this task's file.
			fs.rmSync(t.file, { force: true });
		}
		try {
			if (fs.existsSync(prevDir) && fs.readdirSync(prevDir).length === 0) fs.rmdirSync(prevDir);
		} catch {}
	}
	t.file = target;
	for (const [role, text] of Object.entries(t.reports)) {
		fs.writeFileSync(path.join(targetDir, `${role}.report.md`), text);
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
