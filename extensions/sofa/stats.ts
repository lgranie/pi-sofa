/**
 * Factory stats: what the factory costs and delivers, computed from the board.
 *
 * Pure functions over Task[] so they can be unit-tested without the runtime.
 * Cost is unknown (`-`) when no session in the group recorded one
 * (claude records tokens but no cost).
 */
import { COLUMNS, KINDS, type Kind, type Status, type Task } from "./board.ts";

// Level order for display. Kept local (not imported from config.ts) so this
// module stays dependency-free and unit-testable without the pi packages.
const LEVEL_ORDER = ["low", "medium", "high"];

// Merged tasks that ended usefully, over all ended feature/bug tasks.
export interface MergeRate {
	merged: number;
	discarded: number;
	failed: number;
	rate?: number; // merged / (merged + discarded + failed), undefined when nothing ended
}

// One usage line: worker sessions with their tokens and cost.
export interface UsageRow {
	sessions: number;
	input: number;
	output: number;
	cost?: number; // undefined when no session recorded a cost
	merged: number; // merged tasks in the group (per agent: merged tasks that used the agent)
	costPerMerged?: number; // cost / merged, undefined when the cost is unknown or nothing merged
}

export interface Stats {
	total: number;
	counts: Record<Status, Record<Kind, number>>;
	mergeRate: Record<"feature" | "bug", MergeRate>;
	byLevel: Record<string, UsageRow>;
	byAgent: Record<string, UsageRow>;
	totals: UsageRow;
}

const emptyUsage = (): UsageRow => ({ sessions: 0, input: 0, output: 0, cost: undefined, merged: 0, costPerMerged: undefined });

// Marker rows (repro/check events) are not worker sessions.
const isSession = (r: Task["log"][number]) => r.agent !== "-" && r.session !== "-";

export function computeStats(tasks: Task[]): Stats {
	const counts = Object.fromEntries(COLUMNS.map((c) => [c, Object.fromEntries(KINDS.map((k) => [k, 0]))])) as Stats["counts"];
	for (const t of tasks) {
		const row = counts[t.status];
		if (row) row[t.kind]++;
	}

	const mergeRate = {
		feature: { merged: 0, discarded: 0, failed: 0 } as MergeRate,
		bug: { merged: 0, discarded: 0, failed: 0 } as MergeRate,
	};
	for (const t of tasks) {
		const m = t.kind === "feature" || t.kind === "bug" ? mergeRate[t.kind] : undefined;
		if (!m) continue;
		if (t.status === "merged") m.merged++;
		else if (t.status === "discarded") m.discarded++;
		else if (t.status === "failed") m.failed++;
	}
	for (const m of Object.values(mergeRate)) {
		const denom = m.merged + m.discarded + m.failed;
		if (denom > 0) m.rate = m.merged / denom;
	}

	const byLevel: Record<string, UsageRow> = {};
	const byAgent: Record<string, UsageRow> = {};
	const totals: UsageRow = emptyUsage();
	const costSeen = { level: new Set<string>(), agent: new Set<string>(), total: false };
	const mergedByAgent = new Map<string, Set<string>>();

	const levelOf = (t: Task) => t.level ?? "-";
	for (const t of tasks) {
		const lk = levelOf(t);
		byLevel[lk] ??= emptyUsage();
		if (t.status === "merged") byLevel[lk].merged++;
	}

	for (const t of tasks) {
		const lk = levelOf(t);
		const agents = new Set<string>();
		for (const r of t.log) {
			if (!isSession(r)) continue;
			byLevel[lk].sessions++;
			byLevel[lk].input += r.input ?? 0;
			byLevel[lk].output += r.output ?? 0;
			if (r.cost !== undefined) {
				byLevel[lk].cost = (byLevel[lk].cost ?? 0) + r.cost;
				costSeen.level.add(lk);
			}
			const ak = r.agent || "-";
			byAgent[ak] ??= emptyUsage();
			byAgent[ak].sessions++;
			byAgent[ak].input += r.input ?? 0;
			byAgent[ak].output += r.output ?? 0;
			if (r.cost !== undefined) {
				byAgent[ak].cost = (byAgent[ak].cost ?? 0) + r.cost;
				costSeen.agent.add(ak);
			}
			totals.sessions++;
			totals.input += r.input ?? 0;
			totals.output += r.output ?? 0;
			if (r.cost !== undefined) {
				totals.cost = (totals.cost ?? 0) + r.cost;
				costSeen.total = true;
			}
			agents.add(ak);
		}
		if (t.status === "merged") for (const ak of agents) {
			byAgent[ak] ??= emptyUsage();
			mergedByAgent.set(ak, (mergedByAgent.get(ak) ?? new Set()).add(t.id));
		}
	}
	for (const [ak, ids] of mergedByAgent) byAgent[ak].merged = ids.size;
	totals.merged = tasks.filter((t) => t.status === "merged").length;

	const finish = (u: UsageRow, seen: boolean) => {
		if (!seen) u.cost = undefined;
		u.costPerMerged = seen && u.merged > 0 ? u.cost! / u.merged : undefined;
	};
	for (const [k, u] of Object.entries(byLevel)) finish(u, costSeen.level.has(k));
	for (const [k, u] of Object.entries(byAgent)) finish(u, costSeen.agent.has(k));
	finish(totals, costSeen.total);

	return { total: tasks.length, counts, mergeRate, byLevel, byAgent, totals };
}

const money = (v?: number) => (v === undefined ? "-" : `$${v.toFixed(4)}`);
const pct = (r?: number) => (r === undefined ? "-" : `${Math.round(r * 100)}%`);

const levelOrder = (keys: string[]) =>
	keys.sort((a, b) => {
		const ia = LEVEL_ORDER.indexOf(a);
		const ib = LEVEL_ORDER.indexOf(b);
		if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
		return a.localeCompare(b);
	});

// Same text for /sofa stats and the sofa_stats tool.
export function statsView(s: Stats): string {
	if (!s.total) return "No tasks on the board.";
	const lines = [`sofa stats: ${s.total} task${s.total === 1 ? "" : "s"}`, "", "Tasks by column and kind:"];
	for (const col of COLUMNS) {
		const row = s.counts[col];
		const n = KINDS.map((k) => row[k]).reduce((a, b) => a + b, 0);
		if (!n) continue;
		const kinds = KINDS.filter((k) => row[k]).map((k) => `${k} ${row[k]}`).join(", ");
		lines.push(`- ${col}: ${n} (${kinds})`);
	}
	lines.push("", "Merge rate (merged / merged+discarded+failed):");
	for (const kind of ["feature", "bug"] as const) {
		const m = s.mergeRate[kind];
		const denom = m.merged + m.discarded + m.failed;
		lines.push(`- ${kind}: ${m.rate === undefined ? "-" : `${m.merged}/${denom} = ${pct(m.rate)}`} (merged ${m.merged}, discarded ${m.discarded}, failed ${m.failed})`);
	}
	const usage = (label: string, u: UsageRow) =>
		`- ${label}: ${u.sessions} sessions, ${u.input} in, ${u.output} out, ${money(u.cost)}, ${money(u.costPerMerged)}/merged (${u.merged} merged)`;
	lines.push("", "Usage by level (sessions, tokens in/out, cost, cost per merged task):");
	for (const k of levelOrder(Object.keys(s.byLevel))) lines.push(usage(k, s.byLevel[k]));
	lines.push("", "Usage by agent (sessions, tokens in/out, cost, cost per merged task):");
	for (const k of Object.keys(s.byAgent).sort()) lines.push(usage(k, s.byAgent[k]));
	lines.push("", `Totals: ${s.totals.sessions} sessions, ${s.totals.input} in, ${s.totals.output} out, ${money(s.totals.cost)}, ${money(s.totals.costPerMerged)}/merged (${s.totals.merged} merged)`);
	return lines.join("\n");
}
