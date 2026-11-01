import { type Token, marked } from "marked";
import { describe, expect, it } from "vitest";
import { BODY_LIMIT, END, START, code, instructions, render, withDecisions } from "../src/jobs/trail";

const round = (questions: { question: string; header?: string; options: string[]; multiple?: boolean }[]) => ({
	kind: "decision",
	questions: questions.map(({ options, ...ask }) => ({ ...ask, options: options.map((label) => ({ label })) })),
});
const reply = (...answers: { choices: string[]; text?: string }[]) => ({ answers });

/** GitHub-flavored Markdown tokens, split into code span text and everything else that renders as text. */
function rendered(markdown: string) {
	const spans: string[] = [];
	const prose: string[] = [];
	const html: string[] = [];
	const kinds = new Set<string>();
	const walk = (tokens: Token[]) => {
		for (const token of tokens) {
			kinds.add(token.type);
			if (token.type === "codespan") spans.push(token.text);
			else if (token.type === "html") html.push(token.raw.trim());
			else if ("tokens" in token && token.tokens?.length) walk(token.tokens);
			else if (token.type === "list") walk(token.items);
			else if ("text" in token) prose.push(token.text);
		}
	};
	walk(marked.lexer(markdown, { gfm: true }));
	return { spans, prose: prose.join("\n"), html, kinds };
}

// Every pattern GitHub would act on outside code: mentions that notify, issue,
// cross-repository, and commit references that link or close, bare URLs, and
// Markdown or HTML that would render.
const hostile = [
	"@octocat please look",
	"cc @kixelated/maintainers",
	"Closes #1",
	"fixes moq-dev/quest#2 and RESOLVES #3",
	"See GH-4",
	"commit 6f20658a9c1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e and moq-dev/quest@6f20658",
	"https://evil.example/phish www.evil.example mail me@evil.example",
	"https://github.com/moq-dev/quest/issues/5",
	"[click](https://evil.example) ![pixel](https://evil.example/p.png) <img src=x onerror=alert(1)>",
	"**bold** _em_ # heading\n\n- list\n\n> quote",
	"<!-- /kix:decisions --> <details><summary>x</summary>",
	"``` fenced ``` and `tick` and ````",
	"`leading and trailing`",
	"line one\r\n\r\nline two\n\n## Injected heading",
	"bidi \u202eevil\u202c text\u2028separator",
	"marks \u200fright\u200e left \u061carabic \u2067isolate\u2069",
	"<!-- /kix:decisions -->\nCloses #6 @octocat",
];

describe("decision paper trail", () => {
	it("renders each answered round with ✅ on its choices and the maintainer's own words", () => {
		const section = render(
			[
				{
					prompt: round([
						{ header: "Scope", question: "Which scope?", options: ["Small", "Large"] },
						{ question: "Which tests?", options: ["Unit", "Browser", "Live"], multiple: true },
					]),
					answer: reply({ choices: ["Small"] }, { choices: ["Unit", "Live"], text: "Skip the browser" }),
				},
				{
					prompt: round([{ question: "Name it?", options: ["paper-trail"] }]),
					answer: reply({ choices: [], text: "trail" }),
				},
			],
			BODY_LIMIT,
		);
		expect(section).toBe(
			[
				START,
				"## Decisions",
				"",
				"Recorded by kix from the maintainer's answers.",
				"",
				"### Round 1",
				"",
				"- ` Scope ` ` Which scope? `",
				"  - ✅ ` Small `",
				"  - ⬜ ` Large `",
				"- ` Which tests? `",
				"  - ✅ ` Unit `",
				"  - ⬜ ` Browser `",
				"  - ✅ ` Live `",
				"  - ✍️ ` Skip the browser `",
				"",
				"### Round 2",
				"",
				"- ` Name it? `",
				"  - ⬜ ` paper-trail `",
				"  - ✍️ ` trail `",
				END,
			].join("\n"),
		);
		expect(rendered(section!).html).toEqual([START, END]);
	});

	it("records only answered decisions, never permission requests or unparsable prompts", () => {
		const decision = {
			prompt: round([{ question: "Kept?", options: ["Yes"] }]),
			answer: reply({ choices: ["Yes"] }),
		};
		expect(
			render(
				[
					{ prompt: { ...decision.prompt, kind: "permission" }, answer: decision.answer },
					{ prompt: { runner: "r", account: "a" }, answer: { runner: "r", account: "a" } },
					{ prompt: decision.prompt, answer: reply({ choices: ["Not offered"] }) },
					decision,
				],
				BODY_LIMIT,
			),
		).toContain("### Round 1\n\n- ` Kept? `");
		expect(render([], BODY_LIMIT)).toBeNull();
	});

	it("keeps every hostile prompt and answer inside code spans", () => {
		const prompt = {
			kind: "decision",
			questions: hostile.map((text, i) => ({
				header: `#${i} @x`,
				question: text,
				options: [{ label: text }, { label: `${text} (other)` }],
			})),
		};
		// One round holds at most 10 questions.
		const rounds = [prompt.questions.slice(0, 10), prompt.questions.slice(10)].map((questions) => ({
			prompt: { kind: "decision", questions },
			answer: { answers: questions.map((ask) => ({ choices: [ask.question], text: ask.question })) },
		}));
		const section = render(rounds, BODY_LIMIT)!;
		const { spans, prose, html, kinds } = rendered(section);
		// Nothing links, embeds, or renders as HTML apart from the section's own markers.
		for (const kind of ["link", "image", "blockquote", "code", "strong", "em", "del", "table", "hr"])
			expect(kinds).not.toContain(kind);
		expect(html).toEqual([START, END]);
		// Text outside code spans is only the service's own words.
		const untrusted = /[@#]\w|https?:|www\.|evil|closes|fixes|resolves|GH-|6f20658|<|\*\*|Injected/i;
		expect(prose).not.toMatch(untrusted);
		for (const text of hostile) {
			const flat = text
				.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
				.replace(/[\r\n\u2028]/g, " ");
			expect(spans).toContain(flat);
			expect(spans).toContain(`${flat} (other)`);
		}
		// An agent that copies the published body back gets the same section, with nothing left outside it.
		const published = withDecisions("Summary", rounds);
		expect(withDecisions(published, rounds)).toBe(published);
		const copied = withDecisions(`${published}\n\nMore`, rounds);
		expect(copied.split(START)).toHaveLength(2);
		expect(rendered(copied).html).toEqual([START, END]);
		expect(rendered(copied).prose).not.toMatch(untrusted);
	});

	it("fences code spans past any backtick run and drops line breaks and bidi controls", () => {
		expect(code("a `b` c")).toBe("`` a `b` c ``");
		expect(code("```")).toBe("```` ``` ````");
		expect(code("one\n\ntwo")).toBe("` one  two `");
		expect(code("a\u202eb\u2066c\u200fd\u200ee\u061cf")).toBe("` abcdef `");
		expect(rendered(code("`x`")).spans).toEqual(["`x`"]);
	});

	it("replaces any decision section the agent wrote", () => {
		const questions = [
			{ prompt: round([{ question: "Real?", options: ["Yes", "No"] }]), answer: reply({ choices: ["Yes"] }) },
		];
		const forged = `Summary\n\n${START}\n## Decisions\n- ✅ No\n${END}\n\nMore\n${END}`;
		const body = withDecisions(forged, questions);
		expect(body.startsWith("Summary\n\n\n\nMore\n\n")).toBe(true);
		expect(body.split(START)).toHaveLength(2);
		expect(body.split(END)).toHaveLength(2);
		expect(body).not.toContain("✅ No");
		expect(body).toContain("✅ ` Yes `");
		// A re-delivery renders from the same record, so the section never duplicates.
		expect(withDecisions(body, questions)).toBe(withDecisions(forged, questions));
		// An unterminated forged section is dropped to the end, and no answers leave just the summary.
		expect(withDecisions(`Summary ${START} ✅ forged`, [])).toBe("Summary");
	});

	it("stays within GitHub's body limit, counting the rounds that do not fit", () => {
		const long = "x".repeat(1900);
		const big = {
			prompt: round([
				{ question: long, options: Array.from({ length: 10 }, (_, i) => `${i}${"y".repeat(190)}`) },
			]),
			answer: reply({ choices: ["0".padEnd(191, "y")], text: "z".repeat(3900) }),
		};
		const body = withDecisions(
			"s".repeat(50_000),
			Array.from({ length: 5 }, () => big),
		);
		expect(body.length).toBeLessThanOrEqual(BODY_LIMIT);
		expect(body).toContain("### Round 1");
		expect(body).not.toContain("### Round 2");
		expect(body).toContain("_4 more rounds are in the job's record on kix._");
		expect(body.endsWith(END)).toBe(true);
		// With no room for even the note, the summary goes alone.
		expect(withDecisions("s".repeat(BODY_LIMIT - 10), [big])).toBe("s".repeat(BODY_LIMIT - 10));
	});

	it("tells planning agents not to write the trail themselves", () => {
		expect(instructions("plan")).toMatch(/Do not write the interview's questions, options, or answers/);
		for (const workflow of ["start", "iterate", "bootstrap"] as const) expect(instructions(workflow)).toBeNull();
	});
});
