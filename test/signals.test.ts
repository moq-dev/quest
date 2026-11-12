import { describe as group, expect, test } from "vitest";

import type { Activity } from "../src/cli/online-review";
import { signals } from "../src/cli/signals";

const HEAD = "h".repeat(40);
const OLD = "o".repeat(40);
const URL_ = "https://github.com/acme/proj/pull/1";
const bot = (login: string) => ({ __typename: "Bot", login });
const person = { __typename: "User", login: "maintainer" };
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
const comment = (author: object, body: string, at: string, id: string, association = "OWNER") => ({
	author,
	authorAssociation: association,
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
	test("an online reviewer's thread on the head holds it until someone else replies or resolves it", () => {
		const pull = activity({
			reviews: [
				review("r1", bot("rabbit"), "Actionable comments posted: 3", "2026-11-10T17:05:00Z"),
				review("r2", bot("rabbit"), "Old pass.", "2026-11-10T16:00:00Z", OLD),
			],
			reviewThreads: [
				thread([reply(bot("rabbit"), "Leaks the handle.\nMore.", "r1", "1")]),
				thread([reply(bot("rabbit"), "Answered.", "r1", "2"), reply(person, "Declined: closed below.", null)]),
				thread([reply(bot("rabbit"), "Resolved.", "r1", "3")], true),
				// On an earlier head: a push since answers it.
				thread([reply(bot("rabbit"), "Stale.", "r2", "4")]),
				// A person's own review is no online reviewer's.
				thread([reply(person, "Hmm.", null, "5")]),
			],
		});
		expect(signals(pull)).toEqual([
			{ kind: "finding", url: `${URL_}#discussion_r1`, author: "rabbit[bot]", text: "Leaks the handle." },
		]);
	});

	test("a body finding on the head holds it until a later comment answers or links its pass", () => {
		const body = [
			"Automated review by review (OpenAI)",
			"",
			"1. **[P2] Share handover credit across predecessors** — [rs/a.rs:311](https://x). Long.",
			"2. **[P3] Name the timeout**",
		].join("\n");
		const pull = activity({ reviews: [review("r1", person, body, "2026-11-10T17:05:00Z")] });
		expect(signals(pull).map((signal) => [signal.author, signal.text])).toEqual([
			["review (OpenAI)", "share handover credit across predecessors"],
			["review (OpenAI)", "name the timeout"],
		]);
		// A comment before the pass, a bot's, or one that takes no side and links nothing answers nothing.
		pull.comments = [
			comment(person, "Fixed in abc.", "2026-11-10T17:01:00Z", "1"),
			comment(bot("watcher"), `Declined, see ${URL_}#pullrequestreview-r1`, "2026-11-10T17:06:00Z", "2"),
			comment(person, "Moot after merging main.", "2026-11-10T17:07:00Z", "3"),
		];
		expect(signals(pull)).toHaveLength(2);
		pull.comments.push(
			comment(person, `See ${URL_}#pullrequestreview-r1: both refuted.`, "2026-11-10T17:08:00Z", "4"),
		);
		expect(signals(pull)).toEqual([]);
		pull.comments.pop();
		pull.comments.push(comment(person, "Declined: the caller already checks.", "2026-11-10T17:08:00Z", "4"));
		expect(signals(pull)).toEqual([]);
	});

	test("a reviewer's latest pass over the head is the one that holds it", () => {
		const pull = activity({
			reviews: [
				review("r1", bot("rabbit"), "[P1] Guard null", "2026-11-10T17:05:00Z"),
				review("r2", bot("rabbit"), "No findings.", "2026-11-10T17:10:00Z"),
				review("r3", bot("frog"), "[P2] Old head", "2026-11-10T16:00:00Z", OLD),
			],
		});
		expect(signals(pull)).toEqual([]);
	});

	test("a writer's marked decision newer than the head's commit holds it until a writer links it", () => {
		const decision = comment(
			person,
			"**Maintainer decision** (2026-11-10): raise the timeout.\n\nDetails.",
			"2026-11-10T17:12:00Z",
			"9",
		);
		const pull = activity({
			comments: [
				decision,
				// Before the head's commit: the head may apply it.
				comment(person, "Maintainer decision: older.", "2026-11-10T16:00:00Z", "1"),
				// Not a writer, or not opening with the marker.
				comment(bot("rabbit"), "Maintainer decision: bot.", "2026-11-10T17:13:00Z", "2", "NONE"),
				comment(
					{ __typename: "User", login: "drive-by" },
					"Maintainer decision: me.",
					"2026-11-10T17:13:00Z",
					"3",
					"NONE",
				),
				comment(person, "Per the Maintainer decision, ...", "2026-11-10T17:13:00Z", "4"),
			],
		});
		expect(signals(pull)).toEqual([
			{
				kind: "decision",
				url: `${URL_}#issuecomment-9`,
				author: "maintainer",
				text: "**Maintainer decision** (2026-11-10): raise the timeout.",
			},
		]);
		// A head committed after it answers it, as does a writer's later comment linking it; a bot's link does not.
		expect(signals({ ...pull, committed: "2026-11-10T17:20:00Z" })).toEqual([]);
		pull.comments.push(
			comment(bot("watcher"), `Held by ${URL_}#issuecomment-9`, "2026-11-10T17:14:00Z", "5", "NONE"),
		);
		expect(signals(pull)).toHaveLength(1);
		pull.comments.push(comment(person, `Covered by the head: ${URL_}#issuecomment-9`, "2026-11-10T17:15:00Z", "6"));
		expect(signals(pull)).toEqual([]);
		// An unknown commit time cannot show the head applied either decision.
		pull.comments.pop();
		expect(signals({ ...pull, committed: undefined })).toHaveLength(2);
	});
});
