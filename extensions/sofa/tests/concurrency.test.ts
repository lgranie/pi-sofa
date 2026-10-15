// node --test extensions/sofa/tests/concurrency.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Status, Task } from "../core/board.ts";
import { activeCount, canStart, DEFAULT_MAX_RUNNING, resolveMaxRunning } from "../infra/concurrency.ts";

const task = (status: Status) => ({ status }) as Task;
const tasks = (...statuses: Status[]) => statuses.map(task);

test("canStart: under the limit → can start", () => {
	assert.equal(canStart(tasks("running", "blocked"), 3), true);
	assert.equal(canStart(tasks("todo", "ready", "done"), 3), true);
});

test("canStart: exactly at limit → refuse", () => {
	assert.equal(canStart(tasks("running", "running", "running"), 3), false);
	assert.equal(canStart(tasks("running", "blocked", "blocked"), 3), false);
});

test("canStart: over limit → refuse", () => {
	assert.equal(canStart(tasks("running", "running", "running", "blocked"), 3), false);
});

test("canStart: only running/blocked count", () => {
	assert.equal(activeCount(tasks("todo", "running", "blocked", "ready", "done", "failed", "interrupted", "merged", "discarded")), 2);
	assert.equal(canStart(tasks("todo", "todo", "todo"), 1), true);
});

test("canStart: absent max → default 3", () => {
	assert.equal(DEFAULT_MAX_RUNNING, 3);
	assert.equal(resolveMaxRunning(undefined), 3);
	assert.equal(canStart(tasks("running", "running"), undefined), true);
	assert.equal(canStart(tasks("running", "running", "running"), undefined), false);
});

test("canStart: max 0 → default 3", () => {
	assert.equal(resolveMaxRunning(0), 3);
	assert.equal(canStart(tasks("running", "running"), 0), true);
	assert.equal(canStart(tasks("running", "running", "running"), 0), false);
});

test("canStart: negative/NaN → refuse", () => {
	assert.equal(canStart([], -1), false);
	assert.equal(canStart([], Number.NaN), false);
	assert.equal(canStart(tasks("todo"), -5), false);
});
