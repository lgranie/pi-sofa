// Pure stage-machine helpers, extracted from pipeline.ts so they can be unit-tested without the runtime.
import type { Kind } from "./board.ts";

export type Stage = "lead" | "repro" | "check" | "review" | "end";

// Where the pipeline goes after the lead stage. Research reports and ends; bug tasks with a check run a
// reproduce-first gate (repro) before the fix (check); everything else goes straight to the check stage.
export function nextStageAfterLead(kind: Kind, hasCheck: boolean): Stage {
	if (kind === "research") return "end";
	if (kind === "bug" && hasCheck) return "repro";
	return "check";
}

// A non-zero exit code means the check failed, i.e. the bug was reproduced.
export function isBugReproduced(checkExitCode: number): boolean {
	return checkExitCode !== 0;
}
