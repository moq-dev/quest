// The quest log theme on a terminal: markers, size colours, and the quest-log
// voice. `design/theme.md` is the source of truth for the codes; this is the CLI's
// own copy of its small tables, kept out of the core. Statuses use the format's
// own terms (ready, blocked, `Required`), with no display aliases.
//
// Only a terminal sees any of this. Piped output is the plain contract agents
// and scripts read, and `main.ts` prints it unchanged.

import { type Blocker, type Doc, type Size } from "../core";

/** stdout is a terminal. Without `colour` (NO_COLOR) the layout stays and the escape codes go. */
export interface Terminal {
	colour: boolean;
}

/** The terminal behind stdout, or `undefined` when piped. A non-empty NO_COLOR turns colour off. */
export function detect(isTTY: boolean | undefined, env: Record<string, string | undefined>): Terminal | undefined {
	return isTTY ? { colour: !env.NO_COLOR } : undefined;
}

/**
 * Size colours as SGR parameters, from `design/theme.md` (Size): named ANSI
 * colours, so they follow the user's terminal palette. The size label always
 * prints beside its colour, so colour is never the only signal.
 */
const SIZE_COLOURS: Record<Size, string> = { XS: "90", S: "32", M: "34", L: "35", XL: "33" };

/** Marker colours, from `design/theme.md` (Size): an amber `!` is ready, a grey one blocked. */
const MARKER_COLOURS = { ready: "33", blocked: "90" } as const;

/** A status marker for a ready or blocked quest. */
type Marker = keyof typeof MARKER_COLOURS;

/** C0 and C1 control characters, which a title could use to send escape sequences. */
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

/** A quest title split into its size label and name, as `quest check` requires it. */
const TITLE = /^\[(XS|S|M|L|XL)\] (.+)$/s;

/** Styled text and the columns it takes on screen. */
interface Span {
	text: string;
	width: number;
}

/** One output line: a label, and the quest path aligned in a column after it. */
interface Row {
	indent: number;
	label: Span;
	path: string | null;
}

/** Themed output for one terminal. */
export class Theme {
	constructor(private readonly terminal: Terminal) {}

	/**
	 * `quest unblocked <path>`: the quest with its marker, then its status: Ready
	 * or the `Required` chain, with each required epic expanded
	 * into the quests it still holds.
	 */
	blockers(docs: Map<string, Doc>, doc: Doc, found: Blocker[]): string[] {
		const marker: Marker = found.length === 0 ? "ready" : "blocked";
		const rows: Row[] = [{ indent: 0, label: this.quest(docs, doc.path, marker), path: doc.path }];
		const note = (text: string) => rows.push({ indent: 2, label: plain(text), path: null });

		if (found.length === 0) note("Ready");
		if (found.length > 0) {
			note("Required:");
			const add = (blocker: Blocker, indent: number) => {
				const label = blocker.path === null ? plain(blocker.text) : this.quest(docs, blocker.path, undefined);
				rows.push({ indent, label, path: blocker.path });
				for (const nested of blocker.blockers) add(nested, indent + 2);
			};
			for (const blocker of found) add(blocker, 4);
		}
		return layout(rows);
	}

	/** `quest check` with nothing to report. */
	checked(count: number): string {
		return `The quest log is in order: ${count} documents checked.`;
	}

	/** `quest init`: what changed, and where to go next. */
	init(changes: string[]): string[] {
		if (changes.length === 0) return ["Quest is already set up; nothing changed."];
		return [
			"Quest is set up for you and your agents. Changed:",
			...changes.map((path) => `  ${path}`),
			"Next: plan a quest with /quest-plan in Claude Code or $quest-plan in Codex.",
		];
	}

	/** `quest uninstall`: what changed, and that the quest log stays. */
	uninstall(changes: string[]): string[] {
		if (changes.length === 0) return ["Nothing of Quest's left to remove."];
		return [
			"Quest has packed up. Changed:",
			...changes.map((path) => `  ${path}`),
			"Your quest log under quest/ stays.",
		];
	}

	/**
	 * A quest as `! [M] Title`: its marker (none when `undefined`), size label
	 * in its size colour, and name. An epic, or a title `quest check` would
	 * reject, prints as written.
	 */
	private quest(docs: Map<string, Doc>, path: string, marker: Marker | undefined): Span {
		const parts: Span[] = [];
		if (marker) parts.push(this.paint(MARKER_COLOURS[marker], "!"), plain(" "));
		// Titles come from contributors' Markdown: never let one drive the terminal.
		const title = (docs.get(path)?.title?.text ?? path).replace(CONTROL, "\uFFFD");
		const match = TITLE.exec(title);
		if (match) {
			const size = match[1] as Size;
			parts.push(this.paint(SIZE_COLOURS[size], `[${size}]`), plain(` ${match[2]}`));
		} else {
			parts.push(plain(title));
		}
		return { text: parts.map((p) => p.text).join(""), width: parts.reduce((sum, p) => sum + p.width, 0) };
	}

	private paint(sgr: string, text: string): Span {
		return { text: this.terminal.colour ? `\x1b[${sgr}m${text}\x1b[0m` : text, width: text.length };
	}
}

function plain(text: string): Span {
	return { text, width: text.length };
}

/** Rows as lines, with every path aligned two columns after the widest label. */
function layout(rows: Row[]): string[] {
	const width = Math.max(0, ...rows.filter((r) => r.path !== null).map((r) => r.indent + r.label.width));
	return rows.map((row) => {
		const line = " ".repeat(row.indent) + row.label.text;
		if (row.path === null) return line;
		return line + " ".repeat(width - row.indent - row.label.width + 2) + row.path;
	});
}
