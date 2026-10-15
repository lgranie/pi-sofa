/** sofa-agents.json loading and the classifier that picks a task's level. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveSkillDir, skillsRoot } from "./skills.ts";

// Each task is rated low / medium / high by a classifier, and every role runs at that level.
export const LEVELS = ["low", "medium", "high"] as const;
export type Level = (typeof LEVELS)[number];

// sofa-agents.json. execs: mise tool + command typed into the herdr pane.
// roles: standing orders ({base} = commit the task branched from) + exec and args per level.
// classifier: "provider/id" (e.g. registered by pi-decision-provider); null = first available, none = "medium".
// skillRepos: git repos of model-invoked agent skills, cloned under ./skills/<name> next to this file
//   (ref optional, defaults to the remote default branch). skills: registry name -> path to the skill dir
//   (relative paths resolve against the dir containing this file, e.g. "./skills/mattpocock/skills/engineering/tdd").
//   roles.<role>.skills: names into the registry. All optional — old configs run skill-less.
//   Local hand-edits inside ./skills are overwritten by /sofa update_skills (fetch + reset --hard) by design.
export interface Agents {
	file: string; // where it was loaded from
	classifier?: string | null;
	maxRunning?: number; // max concurrent running/blocked tasks start() allows (default 3)
	skillRepos?: Record<string, { url: string; ref?: string }>;
	skills?: Record<string, string>;
	execs: Record<string, { tool: string; cmd: string }>;
	roles: Record<string, { prompt: string; levels: Record<Level, { exec: string; args?: string }>; skills?: string[] }>;
}

// First found wins: project (only when trusted, since it decides what runs in the panes), user, packaged default.
export function loadAgents(ctx: ExtensionContext): Agents {
	const file = [
		...(ctx.isProjectTrusted() ? [path.join(ctx.cwd, CONFIG_DIR_NAME, "sofa-agents.json")] : []),
		path.join(getAgentDir(), "sofa-agents.json"),
		fileURLToPath(new URL("../../../sofa-agents.json", import.meta.url)),
	].find((f) => fs.existsSync(f))!;
	const a: Agents = { ...JSON.parse(fs.readFileSync(file, "utf8")), file };
	if (a.maxRunning !== undefined && (!Number.isInteger(a.maxRunning) || a.maxRunning <= 0))
		throw new Error(`${file}: maxRunning must be a positive integer`);
	// B006 fallback for merger: older user/project configs have no merger role.
	// Fill it (and any execs it needs) from the packaged default so loadAgents
	// does not throw on startup or on every finish()/resume().
	if (!a.roles?.merger) {
		try {
			const defFile = fileURLToPath(new URL("../../../sofa-agents.json", import.meta.url));
			const def = JSON.parse(fs.readFileSync(defFile, "utf8")) as Agents;
			if (def.roles?.merger) {
				a.roles ??= {};
				a.roles.merger = def.roles.merger;
				for (const lvl of LEVELS) {
					const exec = def.roles.merger.levels?.[lvl]?.exec;
					if (exec && !a.execs?.[exec] && def.execs?.[exec]) {
						a.execs ??= {};
						a.execs[exec] = def.execs[exec];
					}
				}
			}
		} catch {
			// packaged default unreadable: fall through to optional validation below
		}
	}
	for (const role of ["builder", "researcher", "reviewer"]) {
		if (!a.roles?.[role]?.prompt) throw new Error(`${file}: role "${role}" needs a prompt`);
		for (const level of LEVELS) {
			const exec = a.roles[role].levels?.[level]?.exec;
			if (!a.execs?.[exec]) throw new Error(`${file}: roles.${role}.levels.${level}.exec "${exec}" is not in execs`);
		}
	}
	// merger is optional (filled from packaged default above): validate only when present.
	if (a.roles?.merger) {
		if (!a.roles.merger.prompt) throw new Error(`${file}: role "merger" needs a prompt`);
		for (const level of LEVELS) {
			const exec = a.roles.merger.levels?.[level]?.exec;
			if (!a.execs?.[exec]) throw new Error(`${file}: roles.merger.levels.${level}.exec "${exec}" is not in execs`);
		}
	}
	// Skills: all optional (old configs run skill-less). Validate eagerly so a typo fails fast at startup:
	// every role.skills name must exist in the registry, and every referenced registry path must exist
	// once its repo checkout is present. A merely missing checkout does not fail (session_start auto-clones it).
	if (a.skillRepos !== undefined) {
		if (typeof a.skillRepos !== "object" || a.skillRepos === null || Array.isArray(a.skillRepos))
			throw new Error(`${file}: skillRepos must be an object`);
		for (const [name, r] of Object.entries(a.skillRepos)) {
			if (!r?.url || typeof r.url !== "string") throw new Error(`${file}: skillRepos.${name}.url must be a string`);
			if (r.ref !== undefined && typeof r.ref !== "string") throw new Error(`${file}: skillRepos.${name}.ref must be a string`);
		}
	}
	if (a.skills !== undefined) {
		if (typeof a.skills !== "object" || a.skills === null || Array.isArray(a.skills))
			throw new Error(`${file}: skills must be an object`);
		for (const [name, p] of Object.entries(a.skills)) {
			if (typeof p !== "string" || !p) throw new Error(`${file}: skills.${name} must be a non-empty path string`);
		}
	}
	const root = skillsRoot(file);
	for (const [role, r] of Object.entries(a.roles ?? {})) {
		const list = (r as { skills?: unknown }).skills;
		if (list === undefined) continue;
		if (!Array.isArray(list) || list.some((n) => typeof n !== "string"))
			throw new Error(`${file}: roles.${role}.skills must be a list of skill names`);
		for (const name of list as string[]) {
			const reg = a.skills?.[name];
			if (!reg) throw new Error(`${file}: roles.${role}.skills "${name}" is not in skills`);
			// Missing checkout (fresh machine) is covered by the session_start auto-clone: skip the
			// existence check until the checkout exists, then a bad registry path fails fast.
			const abs = resolveSkillDir(file, reg);
			const rel = path.relative(root, abs);
			const top = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep)[0] : undefined;
			if (top && !fs.existsSync(path.join(root, top))) continue;
			if (!fs.existsSync(abs)) throw new Error(`${file}: skills.${name} path "${reg}" does not exist`);
		}
	}
	return a;
}

export async function rate(ctx: ExtensionContext, classifier: string | null | undefined, kind: string, title: string, task: string): Promise<{ level: Level; why: string }> {
	try {
		const slash = classifier?.indexOf("/") ?? -1;
		const model = classifier
			? ctx.modelRegistry.findOfType("classifier", classifier.slice(0, slash), classifier.slice(slash + 1))
			: (await ctx.modelRegistry.getAvailableOfType("classifier"))[0];
		if (!model) return { level: "medium", why: "no classifier available" };
		const r = await ctx.modelRegistry.classify(model, {
			state: { kind, title, task: task.slice(0, 16_000) },
			questions: {
				level: {
					type: "choice",
					instructions: "How demanding is this software-factory task for the coding agent that will run it?",
					criteria: {
						low: "Trivial or mechanical: typo, rename, small config or doc change, quick lookup",
						medium: "Ordinary feature, fix, test, review or investigation",
						high: "Subtle design, cross-cutting change, hard debugging or deep investigation",
					},
				},
			},
		});
		const a = r.stopReason === "stop" ? r.answers.level : undefined;
		if (a?.type !== "choice" || !LEVELS.includes(a.choice)) return { level: "medium", why: `classifier gave no answer ${r.errorMessage ?? ""}`.trim() };
		return { level: a.choice, why: `${model.provider}/${model.id} ${Math.round((a.confidence ?? 0) * 100)}%` };
	} catch (e) {
		return { level: "medium", why: `classifier failed: ${(e as Error).message}` };
	}
}
