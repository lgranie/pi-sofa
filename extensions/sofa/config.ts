/** sofa-agents.json loading and the classifier that picks a task's level. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

// Each task is rated low / medium / high by a classifier, and every role runs at that level.
export const LEVELS = ["low", "medium", "high"] as const;
export type Level = (typeof LEVELS)[number];

// sofa-agents.json. execs: mise tool + command typed into the herdr pane.
// roles: standing orders ({base} = commit the task branched from) + exec and args per level.
// classifier: "provider/id" (e.g. registered by pi-decision-provider); null = first available, none = "medium".
export interface Agents {
	file: string; // where it was loaded from
	classifier?: string | null;
	execs: Record<string, { tool: string; cmd: string }>;
	roles: Record<string, { prompt: string; levels: Record<Level, { exec: string; args?: string }> }>;
}

// First found wins: project (only when trusted, since it decides what runs in the panes), user, packaged default.
export function loadAgents(ctx: ExtensionContext): Agents {
	const file = [
		...(ctx.isProjectTrusted() ? [path.join(ctx.cwd, CONFIG_DIR_NAME, "sofa-agents.json")] : []),
		path.join(getAgentDir(), "sofa-agents.json"),
		fileURLToPath(new URL("../../sofa-agents.json", import.meta.url)),
	].find((f) => fs.existsSync(f))!;
	const a: Agents = { ...JSON.parse(fs.readFileSync(file, "utf8")), file };
	for (const role of ["builder", "researcher", "reviewer"]) {
		if (!a.roles?.[role]?.prompt) throw new Error(`${file}: role "${role}" needs a prompt`);
		for (const level of LEVELS) {
			const exec = a.roles[role].levels?.[level]?.exec;
			if (!a.execs?.[exec]) throw new Error(`${file}: roles.${role}.levels.${level}.exec "${exec}" is not in execs`);
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
