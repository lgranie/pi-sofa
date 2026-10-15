/** Child-process helpers: shell commands, git, and the herdr CLI. */
import { spawn } from "node:child_process";

export const tail = (s: string, n = 4000) => (s.length > n ? `...\n${s.slice(-n)}` : s);

const parse = (s: string) => {
	try {
		return JSON.parse(s);
	} catch {
		return undefined;
	}
};

export function run(cmd: string, args: string[], cwd: string, shell = false): Promise<{ code: number; out: string }> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { cwd, shell, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (out += d));
		p.on("error", reject);
		p.on("close", (code) => resolve({ code: code ?? 1, out }));
	});
}

export async function git(cwd: string, ...args: string[]) {
	const r = await run("git", args, cwd);
	if (r.code) throw new Error(`git ${args[0]}: ${r.out.trim()}`);
	return r.out.trim();
}

// herdr CLI is a thin wrapper over its socket; it inherits this pane's session, so workers open in the same session.
export function herdr(...args: string[]): Promise<any> {
	return new Promise((resolve, reject) => {
		const p = spawn("herdr", args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (err += d));
		p.on("error", reject);
		p.on("close", (code) => {
			const json = parse(out) ?? parse(err);
			if (code === 0 && !json?.error) return resolve(json?.result ?? {}); // some commands (pane run) print nothing
			const e = json?.error;
			reject(new Error(`herdr ${args.slice(0, 2).join(" ")}: ${e ? `${e.code}: ${e.message}` : (err || out).trim()}`));
		});
	});
}
