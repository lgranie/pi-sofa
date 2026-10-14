/** Pure report helpers, extracted from pipeline.ts so they can be unit-tested without the runtime. */

// Orchestrator budget: notify() prints one line per report, so cap each line at ~200 chars.
export const SUMMARY_MAX = 200;

// One line per report: its Summary: line if it has one, else its first line, capped with an ellipsis.
export function summaryLine(r: string): string {
	const m = r.match(/^Summary:\s*(.+)$/m);
	const s = (m ? m[1] : r.split("\n").find((l) => l.trim()) ?? "(empty)").trim();
	return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX)}...` : s;
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
