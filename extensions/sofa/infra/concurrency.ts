/** Pure concurrency helpers, extracted from pipeline.ts so they can be unit-tested without the runtime. */
import type { Task } from "../core/board.ts";

// Default cap on concurrent running/blocked tasks when sofa-agents.json sets no maxRunning.
export const DEFAULT_MAX_RUNNING = 3;

// Effective limit: absent (or 0) falls back to the default; anything else is returned as-is
// so canStart() can refuse invalid values (negative, NaN, fractional) instead of starting.
export function resolveMaxRunning(max: unknown): number {
	if (max === undefined || max === null || max === 0) return DEFAULT_MAX_RUNNING;
	return max as number;
}

export function activeCount(tasks: Task[]): number {
	return tasks.filter((t) => t.status === "running" || t.status === "blocked").length;
}

// Whether another task may start: true only when fewer than max tasks are running/blocked.
export function canStart(tasks: Task[], max?: unknown): boolean {
	const m = resolveMaxRunning(max);
	if (typeof m !== "number" || !Number.isInteger(m) || m <= 0) return false;
	return activeCount(tasks) < m;
}
