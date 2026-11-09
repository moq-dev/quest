// Splits a shell command line into its simple commands, closely enough for
// `quest hook` to judge what an agent's command does. It removes quoting,
// attaches redirections and here-documents to their command, and leaves
// expansions as written: nothing runs.

/** A redirection: its operator and the word after it. */
export interface Redirect {
	op: string;
	target: string;
}

/** One simple command: its words, redirections, and the text a here-document or here-string feeds its stdin. */
export interface Simple {
	argv: string[];
	redirects: Redirect[];
	stdin?: string;
	/** The words in `argv` holding a parameter expansion or command substitution, whose text only the shell knows. */
	expanded?: string[];
	/** Whether `stdin` holds an expansion, from a here-string or a here-document with an unquoted delimiter. */
	stdinExpanded?: boolean;
}

/** An expansion the shell performs in a word or an unquoted here-document. */
const EXPANSION = /\$[\w{(@*#?$!-]|`/;

const SEPARATORS = new Set([";", "&", "|", "(", ")", "\n"]);

/**
 * The simple commands in `line`, in order, across `;`, `&&`, `||`, pipes,
 * subshells, and newlines. Command substitutions stay inside their word.
 */
export function parse(line: string): Simple[] {
	const commands: Simple[] = [];
	const heredocs: { command: Simple; delimiter: string; tabs: boolean; literal: boolean }[] = [];
	let command: Simple = { argv: [], redirects: [] };
	let word: string | null = null;
	let redirect: string | null = null;
	// Whether the current word holds an expansion, and whether any of it was quoted.
	let expands = false;
	let quoted = false;
	let i = 0;

	const endWord = () => {
		if (word === null) return;
		if (redirect === null) {
			command.argv.push(word);
			if (expands) (command.expanded ??= []).push(word);
		} else if (redirect === "<<" || redirect === "<<-")
			heredocs.push({ command, delimiter: word, tabs: redirect === "<<-", literal: quoted });
		else if (redirect === "<<<") {
			command.stdin = `${word}\n`;
			if (expands) command.stdinExpanded = true;
		} else command.redirects.push({ op: redirect, target: word });
		word = null;
		redirect = null;
		expands = false;
		quoted = false;
	};
	const endCommand = () => {
		endWord();
		if (command.argv.length > 0 || command.redirects.length > 0 || heredocs.some((h) => h.command === command))
			commands.push(command);
		command = { argv: [], redirects: [] };
	};
	const append = (text: string) => {
		word = (word ?? "") + text;
	};
	/** The index just past the `)` closing a `$(` or `(` opened before `from`. */
	const closing = (from: number): number => {
		let depth = 1;
		let j = from;
		while (j < line.length && depth > 0) {
			const c = line[j]!;
			if (c === "\\") j++;
			else if (c === "'") j = line.indexOf("'", j + 1) === -1 ? line.length : line.indexOf("'", j + 1);
			else if (c === "(") depth++;
			else if (c === ")") depth--;
			j++;
		}
		return j;
	};

	while (i < line.length) {
		const c = line[i]!;
		if (c === "'" || c === '"' || c === "\\") quoted = true;
		if ((c === "$" && line[i + 1] !== "'" && EXPANSION.test(line.slice(i, i + 2))) || c === "`") expands = true;
		if (c === "\\") {
			if (line[i + 1] === "\n") i += 2;
			else {
				append(line[i + 1] ?? "");
				i += 2;
			}
		} else if (c === "'") {
			const end = line.indexOf("'", i + 1);
			append(line.slice(i + 1, end === -1 ? line.length : end));
			i = end === -1 ? line.length : end + 1;
		} else if (c === '"') {
			let text = "";
			i++;
			while (i < line.length && line[i] !== '"') {
				if (line[i] === "\\" && '"\\$`\n'.includes(line[i + 1] ?? "")) {
					if (line[i + 1] !== "\n") text += line[i + 1];
					i += 2;
				} else if (line[i] === "$" && line[i + 1] === "(") {
					expands = true;
					const end = closing(i + 2);
					text += line.slice(i, end);
					i = end;
				} else {
					if (EXPANSION.test(line.slice(i, i + 2))) expands = true;
					text += line[i++];
				}
			}
			append(text);
			i++;
		} else if (c === "$" && line[i + 1] === "'") {
			const end = line.indexOf("'", i + 2);
			append(line.slice(i + 2, end === -1 ? line.length : end).replace(/\\n/g, "\n"));
			i = end === -1 ? line.length : end + 1;
		} else if (c === "$" && line[i + 1] === "(") {
			const end = closing(i + 2);
			append(line.slice(i, end));
			i = end;
		} else if (c === "`") {
			const end = line.indexOf("`", i + 1);
			append(line.slice(i, end === -1 ? line.length : end + 1));
			i = end === -1 ? line.length : end + 1;
		} else if (c === "#" && word === null) {
			while (i < line.length && line[i] !== "\n") i++;
		} else if (c === " " || c === "\t") {
			endWord();
			i++;
		} else if (c === ">" || c === "<" || (c === "&" && line[i + 1] === ">")) {
			// A word of digits right before the operator names the descriptor.
			if (word !== null && /^\d+$/.test(word) && redirect === null) word = null;
			endWord();
			const op = /^(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/.exec(line.slice(i))![1]!;
			i += op.length;
			redirect = op;
		} else if (SEPARATORS.has(c)) {
			endCommand();
			i += c !== "\n" && line[i + 1] === c ? 2 : 1;
			if (c === "\n") i = readHeredocs(i);
		} else {
			append(c);
			i++;
		}
	}
	endCommand();
	return commands;

	/** Read the bodies of the here-documents opened on the line just ended, returning the index after them. */
	function readHeredocs(from: number): number {
		let at = from;
		for (const { command: owner, delimiter, tabs, literal } of heredocs.splice(0)) {
			const body: string[] = [];
			while (at < line.length) {
				const end = line.indexOf("\n", at);
				const raw = line.slice(at, end === -1 ? line.length : end);
				at = end === -1 ? line.length : end + 1;
				const text = tabs ? raw.replace(/^\t+/, "") : raw;
				if (text === delimiter) break;
				body.push(text);
			}
			owner.stdin = body.length > 0 ? `${body.join("\n")}\n` : "";
			if (!literal && EXPANSION.test(owner.stdin)) owner.stdinExpanded = true;
		}
		return at;
	}
}
