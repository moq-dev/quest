// Build-time inputs for the Worker, written to build/ (ignored by Git):
// - build/docs.json: the repository's docs/*.md rendered to HTML.
// - build/board.json: this repository's quest tree and finished quests, for the board.
// - build/public/: static assets: the theme from design/theme/, src/site.css, the
//   scripts src/passkey.js, src/app.js, and the service worker src/sw.js, and the
//   web app manifest.
// Wrangler runs this before dev and deploy; the check and test scripts run it first.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { Lexer, Marked, type Token, type Tokens } from "marked";
import type { Snapshot } from "../src/board/project";
import { LOG, finished, isQuest } from "./history.ts";

const repo = "https://github.com/moq-dev/quest";
const worker = join(import.meta.dirname, "..");
const root = join(worker, "..");
const docs = join(root, "docs");
const design = join(root, "design");
const build = join(worker, "build");

// Docs link relative to their file so they work on GitHub. Other docs become
// site pages; anything else in the repository links to GitHub.
function rewrite(href: string, image: boolean): string {
	if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return href;
	const [path, hash = ""] = href.split(/(?=#)/);
	const target = path.startsWith("/") ? path.slice(1) : posix.normalize(posix.join("docs", path));
	const doc = /^docs\/([^/]+)\.md$/.exec(target);
	if (doc) return `/docs/${doc[1]}${hash}`;
	if (image) return `https://raw.githubusercontent.com/moq-dev/quest/main/${target}`;
	return `${repo}/blob/main/${target}${hash}`;
}

// GitHub's heading anchors, so links like getting-started.md#set-it-up keep working.
function slugger() {
	const seen = new Map<string, number>();
	return (text: string) => {
		const base = text
			.toLowerCase()
			.trim()
			.replace(/[^\p{L}\p{N}\s_-]/gu, "")
			.replace(/\s/g, "-");
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		return count ? `${base}-${count}` : base;
	};
}

// Plain text of inline Markdown, for titles and summaries.
function plain(markdown: string): string {
	return markdown
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`*_]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function render(slug: string, markdown: string) {
	const tokens = Lexer.lex(markdown, { gfm: true });
	const heading = tokens.find((token): token is Tokens.Heading => token.type === "heading" && token.depth === 1);
	if (!heading) throw new Error(`docs/${slug}.md has no title`);
	const opening = tokens.find((token): token is Tokens.Paragraph => token.type === "paragraph");

	const anchor = slugger();
	const marked = new Marked({
		gfm: true,
		renderer: {
			heading({ tokens, depth, text }) {
				return `<h${depth} id="${anchor(plain(text))}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
			},
		},
	});
	marked.walkTokens(tokens, (token: Token) => {
		if (token.type === "link" || token.type === "image") token.href = rewrite(token.href, token.type === "image");
	});
	return {
		slug,
		title: plain(heading.text),
		summary: opening ? plain(opening.text) : "",
		html: marked.parser(tokens),
	};
}

const rendered = readdirSync(docs)
	.filter((name) => name.endsWith(".md"))
	.sort()
	.map((name) => render(name.slice(0, -3), readFileSync(join(docs, name), "utf8")));

// The board's snapshot of this repository: its quest tree as checked out, and
// the quests that history shows finished. A shallow clone has no history, so
// it shows no finished work.

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 << 20 });
}

function questTree(dir: string, out: Snapshot["documents"] = []): Snapshot["documents"] {
	for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory()) questTree(path, out);
		else if (isQuest(path)) out.push({ path, content: readFileSync(join(root, path), "utf8") });
	}
	return out;
}

const tree = questTree("quest");
const [commit, date] = git("log", "-1", "--format=%H %cs").trim().split(" ");
const paths = new Set(tree.map(({ path }) => path));
const completed = finished(git(...LOG), paths, (rev, path) => git("show", `${rev}:${path}`));
const snapshot: Snapshot = { commit, date, documents: tree, completed };

rmSync(build, { recursive: true, force: true });
mkdirSync(join(build, "public"), { recursive: true });
writeFileSync(join(build, "docs.json"), JSON.stringify(rendered));
writeFileSync(join(build, "board.json"), JSON.stringify(snapshot));
cpSync(join(design, "theme"), join(build, "public", "theme"), { recursive: true });
cpSync(join(worker, "src", "site.css"), join(build, "public", "site.css"));
for (const file of ["passkey.js", "app.js", "sw.js", "manifest.webmanifest"])
	cpSync(join(worker, "src", file), join(build, "public", file));
