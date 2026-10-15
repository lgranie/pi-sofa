// B013 repro/guard: F010 corrupted the post-merge rev-parse guard in finish()
// (duplicate `let after: string;` + mis-indented `} catch`) and `npm run check`
// still reported 87/87 passing, because every repro test only reads pipeline.ts
// as text via fs.readFileSync and greps it — nothing imports or compiles it.
// This guard strips types (node:module, stdlib only) and runs `node --check`
// on the result, so a syntax error in pipeline.ts / index.ts fails the check.
// Repro-only: this commit adds the guard; pipeline.ts is intentionally untouched.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const GUARDED = ["./pipeline.ts", "./index.ts"];

function syntaxCheckSource(src: string): { ok: boolean; detail: string } {
	let js: string;
	try {
		js = stripTypeScriptTypes(src, { mode: "strip" });
	} catch (e) {
		return { ok: false, detail: `type-stripping failed (non-erasable syntax?): ${(e as Error).message}` };
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b013-guard-"));
	const tmp = path.join(dir, "check.mjs");
	try {
		fs.writeFileSync(tmp, js);
		execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
		return { ok: true, detail: "" };
	} catch (e) {
		const err = e as { stderr?: Buffer; message?: string };
		const raw = err.stderr?.toString() ?? err.message ?? String(e);
		// Surface theSyntaxError line (e.g. "Identifier 'after' has already been declared").
		const first = raw
			.split("\n")
			.filter((l) => l.trim() && !l.includes("trace-warnings"))
			.slice(0, 4)
			.join(" | ");
		return { ok: false, detail: first };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function syntaxCheck(srcPath: URL): { ok: boolean; detail: string } {
	return syntaxCheckSource(fs.readFileSync(srcPath, "utf8"));
}

test("B013-1: pipeline.ts and index.ts compile (type-stripped node --check)", () => {
	for (const rel of GUARDED) {
		const url = new URL(rel, import.meta.url);
		const r = syntaxCheck(url);
		assert.ok(
			r.ok,
			`BUG B013-1: ${rel} has a syntax error that npm run check did not catch (every test only greps the file as text). Detail: ${r.detail}`,
		);
	}
});

// B013-repro (FAILING until F010 is fixed): the F010 branch corrupted the
// post-merge rev-parse guard in finish() with a duplicate `let after: string;`
// declaration (hard SyntaxError: "Identifier 'after' has already been
// declared") plus a mis-indented `} catch`. This worktree's own pipeline.ts
// is still the clean pre-F010 code, so the B013-1/B013-2 guards above pass —
// this test reads the F010 branch content (via git, no local files touched)
// and asserts it compiles, so `npm run check` fails and demonstrates the bug.
// The fix must restore a single declaration with an aligned try/catch while
// preserving F010's wanted notify(t) additions.
test("B013-repro: sofa/F010 pipeline.ts compiles (duplicate `let after`)", () => {
	const src = execFileSync("git", ["show", "sofa/F010:extensions/sofa/pipeline.ts"], {
		encoding: "utf8",
	}) as string;
	const r = syntaxCheckSource(src);
	assert.ok(
		r.ok,
		`BUG B013-repro: sofa/F010 pipeline.ts does not compile — the F010 diff corrupted the post-merge rev-parse guard in finish() with a duplicate \`let after: string;\` declaration, so any sofa_finish merge fails to load the extension. Detail: ${r.detail}`,
	);
});

test("B013-2: finish() post-merge rev-parse guard declares `after` exactly once", () => {
	const pipelineSrc = fs.readFileSync(new URL("./pipeline.ts", import.meta.url), "utf8");
	const start = pipelineSrc.indexOf("async function finish");
	assert.ok(start >= 0, "could not find finish() in pipeline.ts");
	const finishSrc = pipelineSrc.slice(start, pipelineSrc.indexOf("return { s, save", start));
	const anchor = finishSrc.indexOf("const after = rev-parse(into), guarded");
	assert.ok(anchor >= 0, "could not find the post-merge rev-parse guard comment in finish()");
	const window = finishSrc.slice(anchor, anchor + 800);
	const decls = window.match(/let\s+after\s*:/g) ?? [];
	assert.equal(
		decls.length,
		1,
		`BUG B013-2: expected exactly one \`let after: string;\` in the post-merge rev-parse guard, found ${decls.length}. A duplicate declaration is a hard SyntaxError ("Identifier 'after' has already been declared") that makes the whole merge path dead code. Restore a single declaration with a properly aligned try/catch, preserving the notify(t) additions.`,
	);
});
