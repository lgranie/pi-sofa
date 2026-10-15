// node --test extensions/sofa/tests/skills.test.ts
// updateSkills()/ensureSkills() against local-path git fixtures (no network):
// clone / already-current / update / hand-edits overwritten / partial failure.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ensureSkills, updateSkills, type Agents } from "../agents/skills.ts";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (dir: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" }).trim();

// A local repo standing in for the remote skill repo (git clones from a path with no network).
function remoteWithCommits(): { dir: string; sha: (n?: number) => string } {
	const dir = tmp("sofa-skills-remote-");
	git(dir, "init", "-b", "main");
	fs.writeFileSync(path.join(dir, "SKILL.md"), "# v1\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-m", "v1");
	return { dir, sha: () => git(dir, "rev-parse", "--short", "HEAD") };
}

const agentsFor = (file: string, skillRepos: Agents["skillRepos"]): Agents =>
	({ file, skillRepos, execs: {}, roles: {} }) as Agents;

test("updateSkills: missing repo is cloned, one line reported", async () => {
	const remote = remoteWithCommits();
	const base = tmp("sofa-skills-base-");
	const agents = agentsFor(path.join(base, "sofa-agents.json"), { demo: { url: remote.dir } });
	const lines = await updateSkills(agents);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /^demo: cloned at [0-9a-f]+$/);
	const target = path.join(base, "skills", "demo");
	assert.ok(fs.existsSync(path.join(target, "SKILL.md")), "clone landed under <base>/skills/<repo>");
	assert.equal(fs.readFileSync(path.join(target, "SKILL.md"), "utf8"), "# v1\n");
});

test("updateSkills: second run reports already current", async () => {
	const remote = remoteWithCommits();
	const base = tmp("sofa-skills-base-");
	const agents = agentsFor(path.join(base, "sofa-agents.json"), { demo: { url: remote.dir } });
	await updateSkills(agents);
	const lines = await updateSkills(agents);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /^demo: already current at [0-9a-f]+$/);
});

test("updateSkills: new remote commits advance SHAs in the report", async () => {
	const remote = remoteWithCommits();
	const base = tmp("sofa-skills-base-");
	const agents = agentsFor(path.join(base, "sofa-agents.json"), { demo: { url: remote.dir } });
	const [first] = await updateSkills(agents);
	fs.writeFileSync(path.join(remote.dir, "SKILL.md"), "# v2\n");
	git(remote.dir, "add", "-A");
	git(remote.dir, "commit", "-m", "v2");
	const [second] = await updateSkills(agents);
	assert.match(second, /^demo: updated [0-9a-f]{7}→[0-9a-f]{7}$/);
	const m = second.match(/updated ([0-9a-f]{7})→([0-9a-f]{7})/)!;
	assert.notEqual(m[1], m[2], "SHA advanced");
	assert.equal(m[1], first.split(" ").pop(), "update starts from the cloned SHA");
	assert.equal(fs.readFileSync(path.join(base, "skills", "demo", "SKILL.md"), "utf8"), "# v2\n");
});

test("updateSkills: local hand-edits are overwritten by design", async () => {
	const remote = remoteWithCommits();
	const base = tmp("sofa-skills-base-");
	const agents = agentsFor(path.join(base, "sofa-agents.json"), { demo: { url: remote.dir } });
	await updateSkills(agents);
	const f = path.join(base, "skills", "demo", "SKILL.md");
	fs.writeFileSync(f, "# hand-edited\n");
	const lines = await updateSkills(agents);
	assert.equal(fs.readFileSync(f, "utf8"), "# v1\n", "hand-edit overwritten by fetch + reset --hard");
	assert.match(lines[0], /^demo: (already current at|updated) /);
});

test("updateSkills: partial failure is reported, never thrown", async () => {
	const remote = remoteWithCommits();
	const base = tmp("sofa-skills-base-");
	const agents = agentsFor(path.join(base, "sofa-agents.json"), {
		demo: { url: remote.dir },
		broken: { url: path.join(base, "does-not-exist") },
	});
	const lines = await updateSkills(agents);
	assert.equal(lines.length, 2);
	assert.match(lines[0], /^demo: cloned at [0-9a-f]+$/);
	assert.match(lines[1], /^broken: FAILED: /);
});

test("updateSkills: pinned ref clones that branch", async () => {
	const remote = remoteWithCommits();
	git(remote.dir, "branch", "stable");
	fs.writeFileSync(path.join(remote.dir, "SKILL.md"), "# v2\n");
	git(remote.dir, "add", "-A");
	git(remote.dir, "commit", "-m", "v2");
	const base = tmp("sofa-skills-base-");
	const agents = agentsFor(path.join(base, "sofa-agents.json"), { demo: { url: remote.dir, ref: "stable" } });
	const lines = await updateSkills(agents);
	assert.match(lines[0], /^demo: cloned at [0-9a-f]+$/);
	assert.equal(fs.readFileSync(path.join(base, "skills", "demo", "SKILL.md"), "utf8"), "# v1\n");
});

test("updateSkills and ensureSkills: no skillRepos means no lines", async () => {
	const base = tmp("sofa-skills-base-");
	const agents = agentsFor(path.join(base, "sofa-agents.json"), undefined);
	assert.deepEqual(await updateSkills(agents), []);
	assert.deepEqual(await ensureSkills(agents), []);
});

test("ensureSkills: clones when missing, then stays quiet (no pulls)", async () => {
	const remote = remoteWithCommits();
	const base = tmp("sofa-skills-base-");
	const agents = agentsFor(path.join(base, "sofa-agents.json"), { demo: { url: remote.dir } });
	const first = await ensureSkills(agents);
	assert.equal(first.length, 1);
	assert.match(first[0], /^demo: cloned at [0-9a-f]+$/);
	assert.deepEqual(await ensureSkills(agents), [], "present repos are never pulled");
	fs.writeFileSync(path.join(remote.dir, "SKILL.md"), "# v2\n");
	git(remote.dir, "add", "-A");
	git(remote.dir, "commit", "-m", "v2");
	assert.deepEqual(await ensureSkills(agents), [], "ensureSkills never advances SHAs");
	const [updated] = await updateSkills(agents);
	assert.match(updated, /^demo: updated [0-9a-f]{7}→[0-9a-f]{7}$/);
});

test("ensureSkills: clone failure is reported, never thrown", async () => {
	const base = tmp("sofa-skills-base-");
	const agents = agentsFor(path.join(base, "sofa-agents.json"), { broken: { url: path.join(base, "does-not-exist") } });
	const lines = await ensureSkills(agents);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /^broken: FAILED: /);
});
