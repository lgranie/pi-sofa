/** Pure report helpers, extracted from pipeline.ts so they can be unit-tested without the runtime. */

// Orchestrator budget: notify() prints one line per report, so cap each line at ~200 chars.
export const SUMMARY_MAX = 200;

// One line per report: its Summary: line if it has one, else its first line, capped with an ellipsis.
export function summaryLine(r: string): string {
	const m = r.match(/^Summary:\s*(.+)$/m);
	const s = (m ? m[1] : r.split("\n").find((l) => l.trim()) ?? "(empty)").trim();
	return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX)}...` : s;
}

// Reviewer verdict: the last APPROVE / FIX verdict line in the report.
// `unknown` (no verdict found) never blocks and is treated as approve-with-note.
export type ReviewVerdict = "approve" | "fix" | "unknown";

// A line counts as a verdict line when the verdict word leads the line
// (after markdown/quote/bullet decoration), or when the line names the
// verdict explicitly ("verdict:" / "summary:"). Prose that merely mentions
// fix/approve mid-sentence never counts.
function verdictOfLine(line: string): ReviewVerdict | undefined {
	let s = line.trim();
	if (!s) return undefined;
	// Strip leading markdown decoration: headings, quotes, bullets, numbers.
	s = s.replace(/^(#{1,6}\s+|>\s*|(?:[-*+]\s+|\d+[.)]\s+))+/g, "").trim();
	// Strip surrounding emphasis/code markers.
	s = s.replace(/^[*_`~'"]+/, "").replace(/[*_`~'".:;!—\-,\s]+$/, "").trim();
	// 1. Verdict word leads the line: "APPROVE", "FIX", "APPROVE, no bugs found".
	let m = s.match(/^(APPROVE|FIX)\b/);
	if (m) return m[1].toUpperCase() === "APPROVE" ? "approve" : "fix";
	// 2. Explicit verdict prefix: "Verdict: FIX", "Summary: APPROVE, ...".
	m = s.match(/^(?:[Vv][Ee][Rr][Dd][Ii][Cc][Tt]|[Ss][Uu][Mm][Mm][Aa][Rr][Yy])\s*:+\s*\*{0,2}(APPROVE|FIX)\b/);
	if (m) return m[1] === "APPROVE" ? "approve" : "fix";
	// 3. Verdict named anywhere on the line: "Final verdict is FIX".
	m = line.match(/\b[vV][eE][rR][dD][iI][cC][tT]\b.*\b(APPROVE|FIX)\b/);
	if (m) return m[1].toUpperCase() === "APPROVE" ? "approve" : "fix";
	return undefined;
}

// The last verdict line wins, so a corrected verdict overrides an earlier one.
export function parseReviewVerdict(report: string): ReviewVerdict {
	let verdict: ReviewVerdict = "unknown";
	for (const line of (report ?? "").split("\n")) {
		const v = verdictOfLine(line);
		if (v) verdict = v;
	}
	return verdict;
}

export const REVIEW_VERDICT_LABEL: Record<ReviewVerdict, string> = {
	approve: "APPROVE",
	fix: "FIX",
	unknown: "UNKNOWN",
};

// Round counting without a board format change: one row per reviewer
// session is already recorded in t.log, so reviewer rows are rounds.
export function countReviewRounds(log: { role: string }[]): number {
	return log.filter((r) => r.role === "reviewer").length;
}

// Loop decision, unit-testable without the runtime: only FIX with rounds
// remaining reworks the same task; APPROVE and `unknown` finish (unknown
// never blocks), as does FIX once rounds reach the cap.
export type ReviewAction = "rework" | "done";
export function nextReviewAction(verdict: ReviewVerdict, rounds: number, maxRounds = 2): ReviewAction {
	if (verdict !== "fix") return "done";
	return rounds >= maxRounds ? "done" : "rework";
}

// Note left on the task when it lands ready from review: exhausted FIX
// rounds name the cap; `unknown` is approve-with-note.
export function reviewReadyNote(verdict: ReviewVerdict, rounds: number, maxRounds = 2): string | undefined {
	if (verdict === "fix" && rounds >= maxRounds) return `review FIX after ${maxRounds} rounds`;
	if (verdict === "unknown") return "review verdict unknown (treated as approve)";
	return undefined;
}

// Notify suffix surfacing the final verdict and rounds, e.g.
// "APPROVE (round 1)" or "FIX→APPROVE (round 2)". Only FIX continues the
// loop, so every round before the last was FIX.
export function reviewRoundSuffix(rounds: number, final: ReviewVerdict): string {
	const label = REVIEW_VERDICT_LABEL[final];
	if (rounds <= 1) return `${label} (round 1)`;
	return `${Array(rounds - 1).fill("FIX").join("→")}→${label} (round ${rounds})`;
}

// Text out of `herdr agent read`: the CLI sometimes returns a JSON envelope
// (object or JSON-encoded string) instead of bare text. Always returns the text
// as a string, never the raw envelope object.
export function extractReportText(v: unknown): string {
	if (typeof v === "string") {
		const t = v.trim();
		if (t.length > 1 && ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")))) {
			try {
				return extractReportText(JSON.parse(t));
			} catch {
				return v;
			}
		}
		return v;
	}
	if (v && typeof v === "object") {
		const o = v as { read?: unknown; text?: unknown; result?: unknown };
		if (o.read && typeof o.read === "object") {
			const inner = (o.read as { text?: unknown }).text;
			if (typeof inner === "string") return inner;
		}
		if (typeof o.read === "string") return extractReportText(o.read);
		if (typeof o.text === "string") return o.text;
		if (o.result !== undefined) return extractReportText(o.result);
		if (Array.isArray(v)) return v.map(extractReportText).join("\n");
		return "";
	}
	return v === undefined || v === null ? "" : String(v);
}
