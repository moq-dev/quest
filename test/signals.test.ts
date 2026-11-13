import { describe as group, expect, test } from "vitest";

import type { Activity } from "../src/cli/online-review";
import { signals } from "../src/cli/signals";

const HEAD = "h".repeat(40);
const OLD = "o".repeat(40);
const URL_ = "https://github.com/acme/proj/pull/1";
const WRITERS = new Set(["maintainer"]);
const bot = (login: string) => ({ __typename: "Bot", login });
const person = { __typename: "User", login: "maintainer" };
const reader = { __typename: "User", login: "drive-by" };
const review = (id: string, author: object, body: string, at: string, commit = HEAD) => ({
	id,
	url: `${URL_}#pullrequestreview-${id}`,
	author,
	body,
	submittedAt: at,
	commit: { oid: commit },
});
const reply = (author: object, body: string, review: string | null, id = "c") => ({
	author,
	body,
	url: `${URL_}#discussion_r${id}`,
	pullRequestReview: review === null ? null : { id: review },
});
const thread = (comments: object[], resolved = false) => ({
	isResolved: resolved,
	comments: { pageInfo: { hasNextPage: false }, nodes: comments },
});
const comment = (author: object, body: string, at: string, id: string) => ({
	author,
	body,
	createdAt: at,
	url: `${URL_}#issuecomment-${id}`,
});
const activity = (pull: Partial<Activity>): Activity => ({
	head: HEAD,
	committed: "2026-11-10T17:00:00Z",
	reviews: [],
	reviewThreads: [],
	comments: [],
	...pull,
});

group("signals", () => {
	test("an online reviewer's thread on the head holds it until a writer replies or it is resolved", () => {
		const pull = activity({
			reviews: [
				review("r1", bot("rabbit"), "Actionable comments posted: 3", "2026-11-10T17:05:00Z"),
				review("r2", bot("rabbit"), "Old pass.", "2026-11-10T16:00:00Z", OLD),
			],
			reviewThreads: [
				thread([
					reply(bot("rabbit"), "<!-- marker -->\n\n**<img src=x> Minor**\n\nLeaks the handle.", "r1", "1"),
				]),
				thread([reply(bot("rabbit"), "Answered.", "r1", "2"), reply(person, "Declined: closed below.", null)]),
				thread([reply(bot("rabbit"), "Resolved.", "r1", "3")], true),
				// A bot's reply, or one by an account that cannot push, answers nothing.
				thread([reply(bot("rabbit"), "Botted.", "r1", "4"), reply(bot("frog"), "Agreed.", null)]),
				thread([reply(bot("rabbit"), "Drive-by.", "r1", "5"), reply(reader, "Fixed.", null)]),
				// On an earlier head: a push since answers it.
				thread([reply(bot("rabbit"), "Stale.", "r2", "6")]),
				// A person's own review is no online reviewer's.
				thread([reply(person, "Hmm.", null, "7")]),
			],
		});
		expect(signals(pull, WRITERS).map((signal) => [signal.url, signal.text])).toEqual([
			[`${URL_}#discussion_r1`, "Minor"],
			[`${URL_}#discussion_r4`, "Botted."],
			[`${URL_}#discussion_r5`, "Drive-by."],
		]);
	});

	test("a named reviewer's own replies under a writer's account answer nothing", () => {
		const named = "Automated review by review (OpenAI)\n\nOne thread.";
		const pull = activity({
			reviews: [
				review("r1", person, named, "2026-11-10T17:05:00Z"),
				review("r2", person, named, "2026-11-10T17:06:00Z"),
			],
			reviewThreads: [
				thread([reply(person, "Bug.", "r1", "1"), reply(person, "Still.", "r2")]),
				// A reply posted alone sits in an empty-bodied review, so its own body names the reviewer.
				thread([
					reply(person, "Bug.", "r1", "2"),
					reply(person, "Automated review by review (OpenAI)\n\nStill not fixed.", "r3"),
				]),
			],
		});
		pull.reviews.push(review("r3", person, "", "2026-11-10T17:07:00Z"));
		expect(signals(pull, WRITERS)).toHaveLength(2);
	});

	test("a body finding on the head holds it until a writer's later comment links that pass", () => {
		const body = [
			"Automated review by review (OpenAI)",
			"",
			"1. **[P2] Share handover credit across predecessors** — [rs/a.rs:311](https://x). Long.",
			"2. **[P3] Name the timeout**",
		].join("\n");
		const pull = activity({ reviews: [review("r1", person, body, "2026-11-10T17:05:00Z")] });
		expect(signals(pull, WRITERS).map((signal) => [signal.author, signal.text])).toEqual([
			["review (OpenAI)", "share handover credit across predecessors"],
			["review (OpenAI)", "name the timeout"],
		]);
		// Before the pass, by a bot or a reader, or linking nothing: no answer.
		pull.comments = [
			comment(person, "Fixed in abc.", "2026-11-10T17:01:00Z", "1"),
			comment(bot("watcher"), `Declined, see ${URL_}#pullrequestreview-r1`, "2026-11-10T17:06:00Z", "2"),
			comment(reader, "Declined: not a bug.", "2026-11-10T17:06:00Z", "3"),
			comment(person, "Moot after merging main.", "2026-11-10T17:07:00Z", "4"),
		];
		expect(signals(pull, WRITERS)).toHaveLength(2);
		pull.comments.push(
			comment(person, `See ${URL_}#pullrequestreview-r1: both refuted.`, "2026-11-10T17:08:00Z", "5"),
		);
		expect(signals(pull, WRITERS)).toEqual([]);
		// An answer word alone cannot tell which finding it meant.
		pull.comments.pop();
		pull.comments.push(comment(person, "Declined: the caller already checks.", "2026-11-10T17:08:00Z", "5"));
		expect(signals(pull, WRITERS)).toHaveLength(2);
	});

	test("an answer clears only the passes it links, even once a linked pass is superseded", () => {
		const pull = activity({
			reviews: [
				review("a", bot("rabbit"), "[P1] Guard null", "2026-11-10T17:05:00Z"),
				review("b", bot("frog"), "[P2] Name it", "2026-11-10T17:06:00Z"),
			],
			comments: [
				comment(person, `Declined ${URL_}#pullrequestreview-a: checked above.`, "2026-11-10T17:07:00Z", "1"),
			],
		});
		expect(signals(pull, WRITERS).map((signal) => signal.text)).toEqual(["name it"]);
		pull.reviews.push(review("c", bot("rabbit"), "No findings.", "2026-11-10T17:08:00Z"));
		expect(signals(pull, WRITERS).map((signal) => signal.text)).toEqual(["name it"]);
	});

	test("a reviewer's latest pass over the head is the one that holds it", () => {
		const pull = activity({
			reviews: [
				review("r1", bot("rabbit"), "[P1] Guard null", "2026-11-10T17:05:00Z"),
				review("r2", bot("rabbit"), "No findings.", "2026-11-10T17:10:00Z"),
				review("r3", bot("frog"), "[P2] Old head", "2026-11-10T16:00:00Z", OLD),
			],
		});
		expect(signals(pull, WRITERS)).toEqual([]);
	});

	test("a later pass that only opens threads supersedes an earlier body's findings", () => {
		const pull = activity({
			reviews: [
				review("r1", bot("rabbit"), "[P1] Guard null", "2026-11-10T17:05:00Z"),
				review("r2", bot("rabbit"), "", "2026-11-10T17:10:00Z"),
				review("r3", bot("rabbit"), "", "2026-11-10T17:11:00Z"),
			],
			// r3 only replies, so it is no pass.
			reviewThreads: [
				thread([reply(bot("rabbit"), "New.", "r2", "1"), reply(bot("rabbit"), "More.", "r3")], true),
			],
		});
		expect(signals(pull, WRITERS)).toEqual([]);
		pull.reviewThreads = [
			thread([reply(bot("rabbit"), "Reply only.", "r1", "1"), reply(bot("rabbit"), "More.", "r3")], true),
		];
		expect(signals(pull, WRITERS).map((signal) => signal.text)).toEqual(["guard null"]);
	});

	test("a writer's marked decision newer than the head's commit holds it until a writer links it", () => {
		const decision = comment(
			person,
			"  **Maintainer decision** (2026-11-10): raise the timeout.\n\nDetails.",
			"2026-11-10T17:12:00Z",
			"9",
		);
		const pull = activity({
			comments: [
				decision,
				// Before the head's commit: the head may apply it.
				comment(person, "Maintainer decision: older.", "2026-11-10T16:00:00Z", "1"),
				// Not a writer's, quoted, or not opening with the marker.
				comment(bot("rabbit"), "Maintainer decision: bot.", "2026-11-10T17:13:00Z", "2"),
				comment(reader, "Maintainer decision: me.", "2026-11-10T17:13:00Z", "3"),
				comment(person, "> Maintainer decision: quoted.\n\nApplied.", "2026-11-10T17:13:00Z", "4"),
				comment(person, "```\nMaintainer decision: fenced.\n```", "2026-11-10T17:13:00Z", "10"),
				comment(person, "`Maintainer decision` lines hold a head.", "2026-11-10T17:13:00Z", "11"),
				comment(person, "    Maintainer decision: indented code.", "2026-11-10T17:13:00Z", "12"),
				comment(person, "\tMaintainer decision: tabbed code.", "2026-11-10T17:13:00Z", "13"),
				comment(person, "Per the Maintainer decision, ...", "2026-11-10T17:13:00Z", "5"),
			],
		});
		expect(signals(pull, WRITERS)).toEqual([
			{
				kind: "decision",
				url: `${URL_}#issuecomment-9`,
				author: "maintainer",
				text: "Maintainer decision (2026-11-10): raise the timeout.",
			},
		]);
		// A head committed after it answers it, as does a writer's later comment linking it; a bot's or reader's does not.
		expect(signals({ ...pull, committed: "2026-11-10T17:20:00Z" }, WRITERS)).toEqual([]);
		pull.comments.push(comment(bot("watcher"), `Held by ${URL_}#issuecomment-9`, "2026-11-10T17:14:00Z", "6"));
		pull.comments.push(comment(reader, `Done: ${URL_}#issuecomment-9`, "2026-11-10T17:14:00Z", "7"));
		expect(signals(pull, WRITERS)).toHaveLength(1);
		pull.comments.push(comment(person, `Covered by the head: ${URL_}#issuecomment-9`, "2026-11-10T17:15:00Z", "8"));
		expect(signals(pull, WRITERS)).toEqual([]);
	});

	test("a named review counts only under a bot's or a writer's account", () => {
		const pull = activity({
			reviews: [
				review("r1", person, "Automated review by review (OpenAI)\n\n[P1] Guard null", "2026-11-10T17:05:00Z"),
				review("r2", reader, "Automated review by review (OpenAI)\n\nNo findings.", "2026-11-10T17:06:00Z"),
			],
		});
		expect(signals(pull, WRITERS).map((signal) => signal.text)).toEqual(["guard null"]);
	});

	test("a head that carries a pick forward keeps the pick's findings and the decisions since it", () => {
		const pull = activity({
			committed: "2026-11-10T18:00:00Z",
			reviews: [review("r1", bot("rabbit"), "[P1] Guard null", "2026-11-10T17:30:00Z", OLD)],
			comments: [
				comment(person, "Maintainer decision: before the pick.", "2026-11-10T16:30:00Z", "1"),
				comment(person, "Maintainer decision: while it ran.", "2026-11-10T17:40:00Z", "2"),
			],
		});
		expect(signals(pull, WRITERS)).toEqual([]);
		const carried = { heads: [OLD], picked: "2026-11-10T17:00:00Z" };
		expect(signals(pull, WRITERS, carried).map((signal) => [signal.kind, signal.text])).toEqual([
			["finding", "guard null"],
			["decision", "Maintainer decision: while it ran."],
		]);
	});

	test("a late pass over a carried head leaves the current head's findings, and a dismissed review holds nothing", () => {
		const pull = activity({
			reviews: [
				review("r1", bot("rabbit"), "[P1] Guard null\n[P2] Guard null", "2026-11-10T17:30:00Z"),
				review("r2", bot("rabbit"), "No findings.", "2026-11-10T17:40:00Z", OLD),
				{ ...review("r3", bot("frog"), "[P1] Leaks", "2026-11-10T17:35:00Z"), state: "DISMISSED" },
			],
		});
		const carried = { heads: [OLD], picked: "2026-11-10T17:00:00Z" };
		expect(signals(pull, WRITERS, carried).map((signal) => signal.text)).toEqual(["guard null", "guard null"]);
	});

	test("an answer links a whole anchor, not the start of a longer one", () => {
		const pull = activity({
			reviews: [review("1", bot("rabbit"), "[P1] Guard null", "2026-11-10T17:05:00Z")],
			comments: [
				comment(person, "Maintainer decision: add it.", "2026-11-10T17:06:00Z", "9"),
				comment(person, `See ${URL_}#pullrequestreview-12 and #issuecomment-90.`, "2026-11-10T17:07:00Z", "2"),
			],
		});
		expect(signals(pull, WRITERS)).toHaveLength(2);
		pull.comments.push(
			comment(person, `See #pullrequestreview-1, and #issuecomment-9.`, "2026-11-10T17:08:00Z", "3"),
		);
		expect(signals(pull, WRITERS)).toEqual([]);
	});
});
