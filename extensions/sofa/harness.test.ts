// node --test extensions/sofa/harness.test.ts
// Role-scoped worker skills: resolution is tested for real (skills.ts has no
// pi dependency); harness.ts / config.ts / pipeline.ts / index.ts wiring —
// which import @earendil-works/pi-coding-agent and cannot load under
// `npm run check` — is pinned by source assertions, the repo's repro-test pattern.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { claudeSkillFarm, opencodeSkillFarm, resolveSkillDir, skillsForRole, skillsRoot, type Agents } from "./skills.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f: string) => fs.readFileSync(path.join(here, f), "utf8");
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// Fake agents with a registry + role map; file anchors relative registry paths.
function agents(base: string): Agents {
	for (const s of ["tdd", "diagnosing-bugs", "code-review", "research"]) fs.mkdirSync(path.join(base, "skills", "repo", s), { recursive: true });
	return {
		file: path.join(base, "sofa-agents.json"),
		skillRepos: { repo: { url: "https://example.invalid/repo.git" } },
		skills: {
			tdd: "./skills/repo/tdd",
			"diagnosing-bugs": "./skills/repo/diagnosing-bugs",
			"code-review": "./skills/repo/code-review",
			research: "./skills/repo/research",
		},
		execs: {},
		roles: {
			builder: { prompt: "b", levels: {} as never, skills: ["tdd", "diagnosing-bugs"] },
			reviewer: { prompt: "r", levels: {} as never, skills: ["code-review"] },
			researcher: { prompt: "q", levels: {} as never, skills: ["research"] },
			merger: { prompt: "m", levels: {} as never },
		},
	} as Agents;
}

test("per-role scoping: each role resolves exactly its mapped skills, in order", () => {
	const a = agents(tmp("sofa-harness-"));
	const root = path.join(path.dirname(a.file), "skills", "repo");
	assert.deepEqual(skillsForRole(a, "builder"), [path.join(root, "tdd"), path.join(root, "diagnosing-bugs")]);
	assert.deepEqual(skillsForRole(a, "reviewer"), [path.join(root, "code-review")]);
	assert.deepEqual(skillsForRole(a, "researcher"), [path.join(root, "research")]);
	assert.deepEqual(skillsForRole(a, "merger"), [], "no skills key means no skills");
	assert.deepEqual(skillsForRole(a, "unknown"), [], "unknown role means no skills");
});

test("missing key means no skills: no registry, or no role list", () => {
	const a = agents(tmp("sofa-harness-"));
	assert.deepEqual(skillsForRole({ ...a, skills: undefined }, "builder"), []);
	assert.deepEqual(skillsForRole({ ...a, roles: { ...a.roles, builder: { prompt: "b", levels: {} as never } } }, "builder"), []);
});

test("resolveSkillDir: relative resolves against the agents file, absolute passes through", () => {
	const file = path.join(tmp("sofa-harness-"), "sub", "sofa-agents.json");
	assert.equal(resolveSkillDir(file, "./skills/repo/tdd"), path.join(path.dirname(file), "skills", "repo", "tdd"));
	assert.equal(resolveSkillDir(file, "/abs/skill"), "/abs/skill");
	assert.equal(skillsRoot(file), path.join(path.dirname(file), "skills"));
});

test("opencode farm: per-role symlinks next to the .opencode.json; skill-less means no farm", () => {
	const dir = tmp("sofa-harness-");
	const config = path.join(dir, "builder.opencode.json");
	fs.writeFileSync(config, "{}");
	const a = agents(tmp("sofa-harness-"));
	const farm = opencodeSkillFarm(config, skillsForRole(a, "builder"));
	assert.ok(farm, "farm dir returned");
	assert.equal(path.dirname(farm!), dir, "farm lives next to the per-role .opencode.json");
	assert.match(path.basename(farm!), /\.opencode-skills$/);
	for (const s of skillsForRole(a, "builder"))
		assert.equal(fs.realpathSync(path.join(farm!, path.basename(s))), fs.realpathSync(s));
	assert.equal(opencodeSkillFarm(path.join(dir, "merger.opencode.json"), []), undefined, "no OPENCODE_CONFIG_DIR when skill-less");
	assert.ok(!fs.existsSync(path.join(dir, "merger.opencode-skills")), "no farm dir created when skill-less");
});

test("opencode farm: stale links are replaced", () => {
	const dir = tmp("sofa-harness-");
	const config = path.join(dir, "builder.opencode.json");
	fs.writeFileSync(config, "{}");
	const a = agents(tmp("sofa-harness-"));
	const farm = opencodeSkillFarm(config, skillsForRole(a, "builder"))!;
	const dangling = path.join(farm, "stale");
	fs.symlinkSync(path.join(dir, "gone"), dangling, "dir");
	const farm2 = opencodeSkillFarm(config, skillsForRole(a, "builder"))!;
	assert.equal(farm2, farm);
	assert.ok(!fs.existsSync(dangling), "stale link replaced");
	assert.equal(fs.readdirSync(farm).length, 2, "exactly the role's skills remain");
});

test("claude farm: links land in CLAUDE_CONFIG_DIR/skills and never throw", () => {
	const home = tmp("sofa-harness-claude-");
	const prev = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = home;
	try {
		const a = agents(tmp("sofa-harness-"));
		claudeSkillFarm(skillsForRole(a, "reviewer"));
		const link = path.join(home, "skills", "code-review");
		assert.equal(fs.realpathSync(link), fs.realpathSync(skillsForRole(a, "reviewer")[0]));
		assert.doesNotThrow(() => claudeSkillFarm([]), "skill-less is a no-op");
	} finally {
		if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = prev;
	}
});

test("claude farm: an unwritable base never throws (best-effort)", () => {
	const prev = process.env.CLAUDE_CONFIG_DIR;
	const file = path.join(tmp("sofa-harness-"), "not-a-dir");
	fs.writeFileSync(file, "x");
	process.env.CLAUDE_CONFIG_DIR = path.join(file, "child");
	try {
		assert.doesNotThrow(() => claudeSkillFarm(["/some/skill"]), "best-effort, never throws");
	} finally {
		if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = prev;
	}
});

test("packaged sofa-agents.json: registry, role map and model-invoked-only skills", () => {
	const raw = JSON.parse(fs.readFileSync(path.join(here, "../../sofa-agents.json"), "utf8"));
	assert.equal(raw.skillRepos.mattpocock.url, "https://github.com/mattpocock/skills.git");
	assert.equal(raw.skillRepos.mattpocock.ref, undefined, "ref optional, defaults to the remote default branch");
	for (const [name, p] of Object.entries<string>(raw.skills)) {
		assert.match(p, /^\.\/skills\/mattpocock\/skills\/engineering\//, `${name} points into the mattpocock checkout`);
		assert.ok(["tdd", "diagnosing-bugs", "code-review", "research"].includes(name), `${name} is model-invoked`);
	}
	assert.deepEqual(raw.roles.builder.skills, ["tdd", "diagnosing-bugs"]);
	assert.deepEqual(raw.roles.reviewer.skills, ["code-review"]);
	assert.deepEqual(raw.roles.researcher.skills, ["research"]);
	assert.equal(raw.roles.merger.skills, undefined);
	for (const p of ["builder", "reviewer", "researcher"]) {
		const skill = raw.roles[p].skills[0];
		assert.ok(raw.roles[p].prompt.includes(skill), `${p} prompt names its skill`);
	}
});

test("repo .gitignore covers the skills checkouts", () => {
	const gi = fs.readFileSync(path.join(here, "../../.gitignore"), "utf8");
	assert.ok(gi.split("\n").some((l) => l.trim() === "skills/"), ".gitignore has skills/");
});

test("config.ts: unknown skill names and bad registry paths fail fast, missing clones do not", () => {
	const c = src("config.ts");
	assert.ok(c.includes('is not in skills'), "unknown role.skills name throws");
	assert.ok(c.includes("does not exist"), "bad registry path throws");
	assert.ok(c.includes("auto-clone") || c.includes("auto-clone covers"), "missing checkout skips the existence check");
	assert.ok(c.includes("skillsRoot") && c.includes("resolveSkillDir"), "registry paths resolve against the agents file");
});

test("harness.ts: exact per-role scoping per harness", () => {
	const h = src("harness.ts");
	assert.ok(h.includes('"--skill"'), "pi / little-coder append one --skill per mapped skill");
	assert.ok(h.includes("OPENCODE_CONFIG_DIR") && h.includes("opencodeSkillFarm"), "opencode gets a per-role OPENCODE_CONFIG_DIR farm");
	assert.ok(h.includes("claudeSkillFarm"), "claude gets the best-effort ~/.claude/skills farm");
	assert.ok(h.includes("skills = []"), "missing key means no flags and no farm");
});

test("pipeline.ts: startWorker passes resolved skill paths and points missing clones at update_skills", () => {
	const p = src("pipeline.ts");
	assert.ok(p.includes("skillsForRole(s.agents"), "launch gains resolved skill paths from s.agents");
	assert.ok(p.includes("harness.launch(file, role, skillDirs)"), "resolved paths reach launch()");
	assert.ok(p.includes("/sofa update_skills"), "missing-clone error points at /sofa update_skills");
});

test("index.ts: update_skills command and background auto-clone on session start", () => {
	const i = src("index.ts");
	assert.ok(i.includes("update_skills"), "/sofa update_skills command exists");
	assert.ok(i.includes("updateSkills(s.agents)"), "command runs a full update");
	assert.ok(i.includes("void ensureSkills("), "session_start auto-clone is fire-and-forget, never awaited");
	assert.ok(i.includes("/sofa update_skills to retry"), "auto-clone failure names the manual fallback");
});
