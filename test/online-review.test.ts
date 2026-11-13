import { describe, expect, test } from "vitest";

import type { GitHub, Repository } from "../src/cli/github";
import { type Activity, bodyFindings, classify, onlineReviews, readActivity } from "../src/cli/online-review";
import { readSignals } from "../src/cli/signals";

const HEAD = "h".repeat(40);
const bot = (login: string) => ({ __typename: "Bot", login });
const person = { __typename: "User", login: "maintainer" };
const review = (id: string, author: object, body: string, at: string, commit = HEAD) => ({
	id,
	url: `https://github.com/acme/proj/pull/1#pullrequestreview-${id}`,
	author,
	body,
	submittedAt: at,
	commit: { oid: commit },
});
const comment = (author: object, body: string, review: string) => ({ author, body, pullRequestReview: { id: review } });
const thread = (comments: object[], resolvedBy: object | null = null) => ({
	isResolved: resolvedBy !== null,
	resolvedBy,
	comments: { pageInfo: { hasNextPage: false }, nodes: comments },
});
const activity = (pull: Partial<Activity>): Activity => ({
	head: HEAD,
	committed: "2026-11-06T00:00:00Z",
	reviews: [],
	reviewThreads: [],
	comments: [],
	...pull,
});

describe("classify", () => {
	test("reads an answer's first word", () => {
		expect(classify("Fixed in abc123: done.")).toBe("accepted");
		expect(classify("**Agreed**, applied.")).toBe("accepted");
		expect(classify("Declining: the caller already checks.")).toBe("declined");
		expect(classify("Not quite: the window opens later.")).toBe("declined");
		expect(classify("Moot after merging main.")).toBe("unclassified");
		expect(classify("")).toBe("unclassified");
	});
});

describe("bodyFindings", () => {
	test("two findings that share a title in one body stay two", () => {
		expect(bodyFindings("[P1] Guard null (GET)\n[P2] Guard null (POST)").map((finding) => finding.key)).toEqual([
			"guard null",
			"guard null #2",
		]);
	});

	test("reads bracketed and dashed markers, keyed by title", () => {
		const body = [
			"Automated review by review (OpenAI)",
			"",
			"[P2] Keep `sampling` when unavailable — rs/a.rs:138. Long text.",
			"P3 — src/b.ts:10–12: preserve output. More.",
			"- [P1] Restore the hierarchy (quest/x.md:4)",
			"The previous P2 is fixed.",
			"P2 is a prose word here.",
		].join("\n");
		expect(bodyFindings(body).map((finding) => finding.key)).toEqual([
			"keep sampling when unavailable",
			"src/b.ts:10–12",
			"restore the hierarchy",
		]);
	});
});

describe("onlineReviews", () => {
	test("a bot's threads are taken, declined, unclassified, or unanswered by their first answer", () => {
		const pull = activity({
			reviews: [
				review("r1", bot("rabbit"), "Actionable comments posted: 5", "2026-11-06T10:00:00Z", "a".repeat(40)),
				// A reply-only review at the head is no pass over it.
				review("r2", bot("rabbit"), "", "2026-11-06T12:00:00Z"),
				review("r3", person, "", "2026-11-06T11:00:00Z"),
				// A person's own review opens no online reviewer's thread.
				review("r4", person, "Looks off.", "2026-11-06T11:00:00Z"),
			],
			reviewThreads: [
				thread([
					comment(bot("rabbit"), "Bug.", "r1"),
					comment(bot("rabbit"), "Also.", "r2"),
					comment(person, "Fixed in abc.", "r3"),
				]),
				thread([comment(bot("rabbit"), "Bug.", "r1"), comment(person, "Declining: holds.", "r3")]),
				thread([comment(bot("rabbit"), "Bug.", "r1"), comment(person, "Moot now.", "r3")]),
				thread([comment(bot("rabbit"), "Bug.", "r1")]),
				// Resolved by the reviewer itself, which reports a bot's login with its suffix there.
				thread([comment(bot("rabbit"), "Bug.", "r1")], { __typename: "User", login: "rabbit[bot]" }),
				thread([comment(person, "Nit.", "r4")]),
			],
		});
		expect(onlineReviews(pull)).toEqual([
			{
				reviewer: "rabbit[bot]",
				finalHead: false,
				findings: 5,
				accepted: 2,
				declined: 1,
				unclassified: 1,
				unanswered: 1,
			},
		]);
	});

	test("a named reviewer's body findings are settled by a later pass or answered in a comment", () => {
		const named = (id: string, body: string, at: string, commit?: string) =>
			review(id, person, `Automated review by dot (X)\n\n${body}`, at, commit);
		const pull = activity({
			reviews: [
				named("d1", "[P2] Keep it — a.rs:1.\n[P3] Rename it — b.rs:2.", "2026-11-06T10:00:00Z", "a".repeat(40)),
				named(
					"d2",
					"[P2] Keep it — a.rs:3, still.\n[P1] Guard it — c.rs:4.",
					"2026-11-06T12:00:00Z",
					"b".repeat(40),
				),
				named("d3", "[P1] Guard it — c.rs:4.\n[P3] Docs — d.md:1.", "2026-11-06T14:00:00Z"),
				review("p1", bot("frog"), "No issues.", "2026-11-06T09:00:00Z", "a".repeat(40)),
				// The agent's reply in the Dot's thread posts under the same account, in a review of its own.
				review("x1", person, "", "2026-11-06T15:00:00Z"),
			],
			reviewThreads: [
				thread([comment(person, "Bug.", "d3"), comment(person, "Agreed and fixed.", "x1")]),
				thread([comment(person, "Bug.", "d3"), comment(person, "Still.", "d3")]),
			],
			comments: [
				// The bot's own notice answers nothing, nor does a comment that neither links a pass nor takes a side.
				{ author: bot("frog"), body: "Fixed: credit restored.", createdAt: "2026-11-06T12:30:00Z" },
				{ author: person, body: "Design change: narrowed.", createdAt: "2026-11-06T12:40:00Z" },
				// Answers the findings of both reviews it links, though d3 came between.
				{
					author: person,
					body: "Declining: [one](https://github.com/acme/proj/pull/1#pullrequestreview-d1), [two](https://github.com/acme/proj/pull/1#pullrequestreview-d2).",
					createdAt: "2026-11-06T14:30:00Z",
				},
			],
		});
		expect(onlineReviews(pull)).toEqual([
			{
				reviewer: "dot (X)",
				finalHead: true,
				// Keep it (relisted), Rename it, and Guard it, all declined though Rename it was settled; Docs (open in
				// the last pass); and the two threads.
				findings: 6,
				accepted: 1,
				declined: 3,
				unclassified: 0,
				unanswered: 2,
			},
			{
				reviewer: "frog[bot]",
				finalHead: false,
				findings: 0,
				accepted: 0,
				declined: 0,
				unclassified: 0,
				unanswered: 0,
			},
		]);
	});
});

test("a head pushed while later pages are read marks the read moved, which fails a signal read", async () => {
	const page = (nodes: object[], next: boolean) => ({
		pageInfo: { hasNextPage: next, endCursor: next ? "1" : null },
		nodes,
	});
	const client = (moved: boolean) =>
		({
			graphql: async (query: string) => {
				if (query.includes("$reviews"))
					return {
						repository: {
							pullRequest: {
								headRefOid: moved ? "m".repeat(40) : HEAD,
								reviews: page([review("r2", bot("rabbit"), "[P1] New", "2026-11-10T17:06:00Z")], false),
							},
						},
					};
				return {
					repository: {
						p1: {
							headRefOid: HEAD,
							commits: { nodes: [{ commit: { oid: HEAD, committedDate: "2026-11-10T17:00:00Z" } }] },
							reviews: page([review("r1", bot("rabbit"), "Ok.", "2026-11-10T17:05:00Z")], true),
							reviewThreads: page([], false),
							comments: page([], false),
						},
					},
				};
			},
		}) as unknown as GitHub;
	const repository = { owner: "acme", repo: "proj" } as Repository;
	const still = (await readActivity(client(false), repository, [1])).get(1)!;
	expect([still.reviews.length, still.moved]).toEqual([2, undefined]);
	// Usage tallies take the mixed read; a signal read, which judges findings by the head, refuses it.
	expect((await readActivity(client(true), repository, [1])).get(1)!.moved).toBe(true);
	await expect(readSignals(client(true), repository, [1])).rejects.toThrow("head of PR #1 changed while it was read");
	expect((await readSignals(client(false), repository, [1])).get(1)!.signals.map((signal) => signal.text)).toEqual([
		"new",
	]);
});

test("a head pushed while a long thread's later comments are read marks the read moved", async () => {
	const read = async (moved: boolean) => {
		const client = {
			graphql: async (query: string) =>
				query.includes("PullRequestReviewThread")
					? {
							node: {
								pullRequest: { headRefOid: moved ? "m".repeat(40) : HEAD },
								comments: { pageInfo: { hasNextPage: false }, nodes: [{ body: "Later." }] },
							},
						}
					: {
							repository: {
								p1: {
									headRefOid: HEAD,
									commits: {
										nodes: [{ commit: { oid: HEAD, committedDate: "2026-11-10T17:00:00Z" } }],
									},
									reviews: { pageInfo: { hasNextPage: false }, nodes: [] },
									reviewThreads: {
										pageInfo: { hasNextPage: false },
										nodes: [
											{
												id: "t1",
												comments: {
													pageInfo: { hasNextPage: true, endCursor: "1" },
													nodes: [{ body: "First." }],
												},
											},
										],
									},
									comments: { pageInfo: { hasNextPage: false }, nodes: [] },
								},
							},
						},
		} as unknown as GitHub;
		return (await readActivity(client, { owner: "acme", repo: "proj" } as Repository, [1])).get(1)!.moved;
	};
	expect(await read(false)).toBeUndefined();
	expect(await read(true)).toBe(true);
});
