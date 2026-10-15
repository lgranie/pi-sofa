/**
 * Worker skills from git repos (e.g. mattpocock/skills), managed by sofa itself.
 * Clones live in <dir of sofa-agents.json>/skills/<repo> (gitignored in the pi-sofa repo).
 *
 * Local hand-edits inside ./skills are overwritten by design: an update is
 * `git fetch` + `git reset --hard` to the remote ref, so the checkout is always
 * exactly what the remote has. Run `/sofa update_skills` to refresh.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "../infra/cli.ts";
import type { Agents } from "./config.ts";

// Dir that holds the skill repo checkouts: <dir of agents file>/skills.
export const skillsRoot = (agentsFile: string): string => path.join(path.dirname(agentsFile), "skills");

// Resolve a registry path to an absolute dir. Relative paths resolve against the dir of the agents file.
export function resolveSkillDir(agentsFile: string, registryPath: string): string {
	return path.isAbsolute(registryPath) ? registryPath : path.resolve(path.dirname(agentsFile), registryPath);
}

// Resolved absolute skill dirs for a role (registry order preserved). Empty when the role or registry is skill-less.
export function skillsForRole(a: Agents, role: string): string[] {
	const list = a.roles?.[role]?.skills;
	if (!list?.length || !a.skills) return [];
	return list.map((n) => resolveSkillDir(a.file, a.skills![n])).filter((p) => !!p);
}

// Symlink farm for opencode: one link per skill dir in <role>.opencode-skills/
// next to the per-role .opencode.json. Returns the farm dir, or undefined when
// skill-less (so launch sets no OPENCODE_CONFIG_DIR). Stale symlinks are replaced.
export function opencodeSkillFarm(configFile: string, skills: string[]): string | undefined {
	if (!skills.length) return undefined;
	const farm = configFile.replace(/\.opencode\.json$/, ".opencode-skills");
	fs.mkdirSync(farm, { recursive: true });
	for (const e of fs.readdirSync(farm)) {
		const p = path.join(farm, e);
		try {
			if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p);
		} catch {
			// stale entry unreadable: leave it
		}
	}
	for (const s of skills) {
		const link = path.join(farm, path.basename(s));
		try {
			if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
		} catch {
			// link does not exist yet
		}
		if (!fs.existsSync(link)) fs.symlinkSync(s, link, process.platform === "win32" ? "junction" : "dir");
	}
	return farm;
}

// Best-effort global farm for claude: claude has no per-launch skill scoping,
// so mapped skills are linked into ~/.claude/skills and the role prompt names
// them (see the skill mentions in sofa-agents.json). Never throws: a failed
// farm must not stop the worker. CLAUDE_CONFIG_DIR overrides the base (tests).
export function claudeSkillFarm(skills: string[]): void {
	if (!skills.length) return;
	try {
		const farm = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "skills");
		fs.mkdirSync(farm, { recursive: true });
		for (const s of skills) {
			try {
				const link = path.join(farm, path.basename(s));
				try {
					if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
					else continue; // a real file/dir: leave it alone
				} catch {
					// link does not exist yet
				}
				fs.symlinkSync(s, link, process.platform === "win32" ? "junction" : "dir");
			} catch {
				// best-effort per skill
			}
		}
	} catch {
		// best-effort
	}
}

const short = (sha: string) => sha.slice(0, 7);

// Resolve the remote ref a checkout tracks: origin/<ref>, or the remote
// default branch when no ref is pinned (origin/HEAD, else main, else master).
async function remoteRef(dir: string, ref?: string): Promise<string> {
	if (ref) return `origin/${ref}`;
	try {
		const sym = (await run("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], dir)).out.trim();
		const m = sym.match(/^refs\/remotes\/origin\/(.+)$/);
		if (m) return `origin/${m[1]}`;
	} catch {
		// no origin/HEAD (e.g. fresh local fixture): fall through
	}
	for (const b of ["main", "master"]) {
		const r = await run("git", ["rev-parse", "--verify", `origin/${b}`], dir);
		if (r.code === 0) return `origin/${b}`;
	}
	throw new Error("no remote default branch (tried origin/HEAD, origin/main, origin/master)");
}

async function headSha(dir: string): Promise<string> {
	const r = await run("git", ["rev-parse", "--short", "HEAD"], dir);
	if (r.code) throw new Error(r.out.trim().split("\n").pop() || "git rev-parse failed");
	return r.out.trim();
}

async function cloneRepo(url: string, ref: string | undefined, target: string): Promise<string> {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const args = ["clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), url, target];
	const r = await run("git", args, path.dirname(target));
	if (r.code) throw new Error(r.out.trim().split("\n").pop() || `git clone failed`);
	return headSha(target);
}

// Full update of one repo: clone when missing, else fetch + reset --hard to
// the remote ref (deterministic; local hand-edits are overwritten by design).
async function updateOne(root: string, name: string, url: string, ref?: string): Promise<string> {
	const target = path.join(root, name);
	try {
		if (!fs.existsSync(target)) {
			const sha = await cloneRepo(url, ref, target);
			return `${name}: cloned at ${sha}`;
		}
		const before = await headSha(target);
		const fetch = await run("git", ["fetch", "origin"], target);
		if (fetch.code) throw new Error(fetch.out.trim().split("\n").pop() || "git fetch failed");
		const remote = await remoteRef(target, ref);
		const reset = await run("git", ["reset", "--hard", remote], target);
		if (reset.code) throw new Error(reset.out.trim().split("\n").pop() || `git reset --hard ${remote} failed`);
		const after = await headSha(target);
		return before === after ? `${name}: already current at ${after}` : `${name}: updated ${short(before)}→${short(after)}`;
	} catch (e) {
		return `${name}: FAILED: ${(e as Error).message.split("\n")[0]}`;
	}
}

// Full update of every configured repo. One line per repo
// (cloned at / updated a→b / already current / FAILED); partial failures are
// reported, never thrown. Empty when no skillRepos are configured.
export async function updateSkills(agents: Agents): Promise<string[]> {
	const repos = agents.skillRepos ?? {};
	const root = skillsRoot(agents.file);
	const lines: string[] = [];
	for (const [name, r] of Object.entries(repos)) lines.push(await updateOne(root, name, r.url, r.ref));
	return lines;
}

// Missing-only variant for session_start: clones absent repos, never pulls or
// stalls on the network for present ones. Returns one line per repo that was
// cloned or failed; empty when everything is already present.
export async function ensureSkills(agents: Agents): Promise<string[]> {
	const repos = agents.skillRepos ?? {};
	const root = skillsRoot(agents.file);
	const lines: string[] = [];
	for (const [name, r] of Object.entries(repos)) {
		if (fs.existsSync(path.join(root, name))) continue;
		lines.push(await updateOne(root, name, r.url, r.ref));
	}
	return lines;
}
