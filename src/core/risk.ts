// A pull request's risk tier: what could break, for whom, and how hard it is to undo, set from its diff and never
// from who wrote it. The repository's RISK.md lists the paths whose change is always high and says what else is
// customer-facing there; `quest review` sets the tier and records it in the PR body's `## Review` section.
import type { List, ListItem, Paragraph, RootContent } from "mdast";

import { markdown } from "./doc";
import { reviewSection } from "./review";

/** The tiers, from least risk to most. */
export const TIERS = ["low", "medium", "high"] as const;
export type Tier = (typeof TIERS)[number];

/** Whether tier `a` is riskier than `b`. */
export const riskier = (a: Tier, b: Tier): boolean => TIERS.indexOf(a) > TIERS.indexOf(b);

/** The repository's risk file, read from the base so a change cannot lower its own tier. */
export const RISK_FILE = "RISK.md";

/** A path pattern whose change is always high, and why. */
export interface HighPath {
	pattern: string;
	reason: string;
}

/** The paths every repository holds high, whatever its risk file says. */
export const ALWAYS_HIGH: readonly HighPath[] = [
	{ pattern: RISK_FILE, reason: "it sets the tier of every later change" },
	{
		pattern: ".github/workflows/",
		reason: "workflows run with the repository's secrets and decide what merges and ships",
	},
	{ pattern: ".github/actions/", reason: "the repository's actions run inside its workflows, with their secrets" },
];

/**
 * Why `pattern` is not a path pattern, or null when it is one: a path from the repository root, `/`-separated,
 * where `*` matches within one segment, `?` one character of it, and a whole `**` segment any number of segments.
 */
export function patternError(pattern: string): string | null {
	if (pattern.trim() === "") return "it is empty";
	if (pattern.startsWith("/")) return "it starts with /, but a pattern is a path from the repository root";
	if (/[[\]{}\\!\s]/.test(pattern))
		return "it holds whitespace or one of [ ] { } \\ !, which patterns do not support";
	const segments = (pattern.endsWith("/") ? pattern.slice(0, -1) : pattern).split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
		return "it has an empty, `.`, or `..` segment";
	if (segments.some((segment) => segment !== "**" && segment.includes("**"))) return "`**` must be a whole segment";
	return null;
}

const escape = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
const segmentSource = (segment: string) => escape(segment).replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");

/** Whether `path` matches `pattern`, as {@link patternError} defines one, or lies under a directory it matches. */
export function matches(pattern: string, path: string): boolean {
	const segments = (pattern.endsWith("/") ? pattern.slice(0, -1) : pattern).split("/");
	let source = "";
	segments.forEach((segment, index) => {
		const last = index === segments.length - 1;
		if (segment === "**") source += index === 0 ? (last ? ".*" : "(?:[^/]+/)*") : last ? "(?:/.*)?" : "(?:/[^/]+)*";
		else source += (index === 0 || (index === 1 && segments[0] === "**") ? "" : "/") + segmentSource(segment);
	});
	return new RegExp(`^${source}(?:/.*)?$`).test(path);
}

/** What a risk file holds: its always-high paths, and each mistake that keeps it from being read. */
export interface RiskFile {
	high: HighPath[];
	problems: string[];
}

/**
 * The risk file `text`: each item of its `## High` list is a backticked {@link patternError} pattern, ` - `, and why
 * changing what it matches is always high. The rest of the file is prose the classifier reads, such as what is
 * customer-facing. A file without the section lists no paths.
 */
export function parseRiskFile(text: string): RiskFile {
	const high: HighPath[] = [];
	const problems: string[] = [];
	const nodes = markdown(text).children;
	const headings = nodes.filter(
		(node) => node.type === "heading" && node.depth === 2 && headingText(text, node) === "High",
	);
	if (headings.length > 1) problems.push(`${RISK_FILE} has ${headings.length} ## High sections; merge them into one`);
	const at = headings.length > 0 ? nodes.indexOf(headings[0]!) : -1;
	if (at < 0) return { high, problems };
	for (const node of nodes.slice(at + 1)) {
		if (node.type === "heading" && node.depth <= 2) break;
		if (node.type !== "list") continue;
		for (const item of (node as List).children) {
			const entry = highPath(text, item);
			if (typeof entry === "string") problems.push(`${RISK_FILE}:${item.position!.start.line}: ${entry}`);
			else high.push(entry);
		}
	}
	return { high, problems };
}

function headingText(text: string, node: RootContent): string {
	return text
		.slice(node.position!.start.offset!, node.position!.end.offset!)
		.replace(/^#+[ \t]*/, "")
		.trim();
}

/** One `## High` item, or why it is not one. */
function highPath(text: string, item: ListItem): HighPath | string {
	const [first, ...rest] = item.children;
	const shape = "a `## High` item is a backticked pattern, ` - `, and why its change is high";
	if (first?.type !== "paragraph" || rest.length > 0) return shape;
	const [code] = (first as Paragraph).children;
	if (code?.type !== "inlineCode") return shape;
	const after = text.slice(code.position!.end.offset!, first.position!.end.offset!);
	const reason = /^[ \t]+-[ \t]+(\S[\s\S]*)$/.exec(after)?.[1]?.replace(/\s+/g, " ").trim();
	if (reason === undefined) return shape;
	const problem = patternError(code.value);
	if (problem !== null) return `\`${code.value}\` is no pattern: ${problem}`;
	return { pattern: code.value, reason };
}

/** The risk the PR body's `## Review` record names for its head. */
export interface RecordedRisk {
	tier: Tier;
	reason: string;
	/** The classifier's own tier, lower than `tier` when a reviewer raised it. */
	classified: Tier;
	/** How the classifier set it: a model, a path held high, or the default where the base has no risk file. */
	by: "model" | "paths" | "default";
	/** The classifier's session, when a model set the tier. */
	session: string | null;
	/** The head the record names: in full, or its first 12 characters while a finding is open. */
	head: string;
}

/**
 * The risk `body`'s `## Review` record names, or null when it names none, as a record `quest review` wrote before
 * tiers, or a record of a skipped review. A malformed risk line fails.
 */
export function recordedRisk(body: string): RecordedRisk | null {
	const section = reviewSection(body);
	if (section === null) return null;
	const text = body.slice(section.start, section.end);
	const line = /^- Risk: (.*?)\r?$/m.exec(text);
	if (line === null) return null;
	// Model text is an inline code span, as long a run of backticks as it needs, padded when it starts or ends with one.
	const risk = /^(low|medium|high), (`+) ?(.*?) ?\2$/.exec(line[1]!);
	const classified = /^- Classified: (low|medium|high) by (.*?)\r?$/m.exec(text);
	const head = /^- Head: ([0-9a-f]{12,40})\b/m.exec(text);
	if (risk === null || classified === null || head === null)
		throw new Error(`the ## Review record's risk is malformed: ${line[1]}`);
	const by = classified[2]!;
	const session = /, session (`+) ?(.*?) ?\1$/.exec(by);
	return {
		tier: risk[1] as Tier,
		reason: risk[3]!,
		classified: classified[1] as Tier,
		by: by === PATHS ? "paths" : by === DEFAULT ? "default" : "model",
		session: session ? session[2]! : null,
		head: head[1]!,
	};
}

/** How the record names a tier the paths set, and the default where the base has no risk file. */
export const PATHS = "the always-high paths";
export const DEFAULT = "default";
