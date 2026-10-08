/**
 * Per agent harness: how it receives a role description at startup, and where to read what a session cost.
 * The harness is the first word of the exec's `cmd`. An unknown harness gets the role description in its
 * first message and no usage.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface Launch {
	args: string[];
	env: Record<string, string>;
}
export interface Usage {
	input: number; // including cache reads/writes
	output: number;
	cost?: number; // USD, when the harness records it
}
interface Harness {
	launch(promptFile: string, role: string): Launch;
	usage?(sessionId: string): Usage | undefined; // sessionId as reported by herdr
}

const quote = (s: string) => `"${s}"`;

// Session logs live in <root>/<project dir>/<file>.jsonl; find the one for this session.
function sessionLines(root: string, match: (name: string) => boolean): any[] | undefined {
	if (!fs.existsSync(root)) return undefined;
	for (const d of fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
		const f = fs.readdirSync(path.join(root, d.name)).find(match);
		if (f)
			return fs
				.readFileSync(path.join(root, d.name, f), "utf8")
				.split("\n")
				.flatMap((l) => {
					try {
						return [JSON.parse(l)];
					} catch {
						return [];
					}
				});
	}
	return undefined;
}

const pi: Harness = {
	launch: (file) => ({ args: ["--append-system-prompt", quote(file)], env: {} }),
	// <agentDir>/sessions/--<cwd>--/<timestamp>_<id>.jsonl; usage on assistant messages, usage and compaction entries.
	usage(id) {
		const lines = sessionLines(path.join(getAgentDir(), "sessions"), (n) => n.endsWith(`_${id}.jsonl`));
		if (!lines) return undefined;
		const u: Usage = { input: 0, output: 0, cost: 0 };
		for (const e of lines) {
			const x = e.message?.usage ?? e.usage;
			if (!x) continue;
			u.input += (x.input ?? 0) + (x.cacheRead ?? 0) + (x.cacheWrite ?? 0);
			u.output += x.output ?? 0;
			u.cost! += x.cost?.total ?? 0;
		}
		return u;
	},
};

const HARNESSES: Record<string, Harness> = {
	pi,
	"little-coder": { launch: pi.launch }, // built on pi; assumed to take pi's flags (unverified); session location unknown
	claude: {
		launch: (file) => ({ args: ["--append-system-prompt-file", quote(file)], env: {} }),
		// ~/.claude/projects/<cwd>/<id>.jsonl; streamed messages repeat their usage, so count each message id once. No cost recorded.
		usage(id) {
			const root = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects");
			const lines = sessionLines(root, (n) => n === `${id}.jsonl`);
			if (!lines) return undefined;
			const byMessage = new Map<string, any>();
			for (const e of lines) if (e.message?.usage) byMessage.set(e.message.id ?? e.uuid, e.message.usage);
			const u: Usage = { input: 0, output: 0 };
			for (const x of byMessage.values()) {
				u.input += (x.input_tokens ?? 0) + (x.cache_creation_input_tokens ?? 0) + (x.cache_read_input_tokens ?? 0);
				u.output += x.output_tokens ?? 0;
			}
			return u;
		},
	},
	// opencode has no system-prompt flag: define a primary agent in an extra config file and select it.
	// ponytail: no usage yet; opencode keeps it in its own storage
	opencode: {
		launch(file, role) {
			const config = file.replace(/\.md$/, ".opencode.json");
			const agent = `sofa-${role}`;
			const prompt = `{file:${file.replaceAll("\\", "/")}}`;
			fs.writeFileSync(config, JSON.stringify({ agent: { [agent]: { description: `sofa ${role}`, mode: "primary", prompt } } }, null, 2));
			return { args: ["--agent", agent], env: { OPENCODE_CONFIG: config } };
		},
	},
};

export const harnessFor = (cmd: string): Harness | undefined => HARNESSES[cmd.trim().split(/\s+/)[0]];
