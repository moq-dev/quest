import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { type Comment, type OpenPull, DROP_WINDOW, landingQueues } from "../src/github/queue";
import { privateKey } from "./github-key";
import { origin } from "./login-fixtures";
import { maintainerOf } from "./project-fixtures";

const testEnv = { ...env, GITHUB_APP_PRIVATE_KEY: privateKey };
const now = Date.parse("2026-11-07T12:00:00Z");
const since = now - DROP_WINDOW;
const hours = (n: number) => new Date(now - n * 3_600_000).toISOString();

function pull(number: number, fields: Partial<OpenPull> = {}): OpenPull {
	return {
		number,
		title: `PR ${number}`,
		url: `https://github.com/o/r/pull/${number}`,
		baseRefName: "main",
		isMergeQueueEnabled: false,
		autoMergeRequest: null,
		mergeQueueEntry: null,
		commits: { nodes: [{ commit: { checkSuites: { nodes: [] } } }] },
		...fields,
	};
}
const check = (status: string, title: string, detailsUrl: string | null = null) => ({
	commits: {
		nodes: [{ commit: { checkSuites: { nodes: [{ checkRuns: { nodes: [{ status, title, detailsUrl }] } }] } } }],
	},
});
function said(number: number, pick: string, kind: string, at: string, text = "said", bot = true): Comment {
	return {
		html_url: `https://github.com/o/r/pull/${number}#${kind}-${at}`,
		issue_url: `https://api.github.com/repos/o/r/issues/${number}`,
		body: `quest land watch: ${text}\n\nMore.\n\n<!-- quest land fixer: ${pick} ${kind} job.json -->`,
		created_at: at,
		author_association: "NONE",
		user: { type: bot ? "Bot" : "User" },
	};
}

describe("landing queues", () => {
	it("orders GitHub's queue by position, links a build's run, then lists picks waiting to join", () => {
		const queues = landingQueues(
			[
				pull(3, { isMergeQueueEnabled: true, autoMergeRequest: { enabledAt: hours(1) } }),
				pull(2, {
					isMergeQueueEnabled: true,
					mergeQueueEntry: { position: 2, state: "QUEUED", headCommit: null },
				}),
				pull(1, {
					isMergeQueueEnabled: true,
					mergeQueueEntry: {
						position: 1,
						state: "AWAITING_CHECKS",
						headCommit: {
							statusCheckRollup: {
								contexts: {
									nodes: [
										{
											__typename: "CheckRun",
											status: "COMPLETED",
											detailsUrl: "https://example.test/review",
										},
										{
											__typename: "CheckRun",
											status: "IN_PROGRESS",
											detailsUrl: "https://github.com/o/r/actions/runs/9/job/10",
										},
									],
								},
							},
						},
					},
				}),
			],
			[],
			[],
			since,
		);
		expect(queues).toEqual([
			{
				base: "main",
				mode: "merge-queue",
				drops: [],
				entries: [
					expect.objectContaining({
						number: 1,
						status: "Building",
						build: { url: "https://github.com/o/r/actions/runs/9" },
					}),
					expect.objectContaining({ number: 2, status: "Queued", build: null }),
					expect.objectContaining({ number: 3, status: "Waiting on its checks to join", build: null }),
				],
			},
		]);
	});

	it("orders the own queue by when each pick was armed, with its queue check's place and build", () => {
		const [queue] = landingQueues(
			[
				pull(5, { autoMergeRequest: { enabledAt: hours(1) }, ...check("COMPLETED", "Removed from the queue") }),
				pull(4, { autoMergeRequest: { enabledAt: hours(2) }, ...check("QUEUED", "2nd of 2") }),
				pull(6, {
					autoMergeRequest: { enabledAt: hours(3) },
					...check("IN_PROGRESS", "Building on main", "https://github.com/o/r/actions/runs/7"),
				}),
				pull(7),
			],
			[],
			[],
			since,
		);
		expect(queue!.mode).toBe("own");
		expect(queue!.entries.map((e) => [e.number, e.status, e.build])).toEqual([
			[6, "Building on main", { url: "https://github.com/o/r/actions/runs/7" }],
			[4, "2nd of 2", null],
			[5, "Waiting on its checks", null],
		]);
	});

	it("keeps each base's queue apart", () => {
		const queues = landingQueues(
			[
				pull(1, { baseRefName: "release", autoMergeRequest: { enabledAt: hours(1) } }),
				pull(2, {
					isMergeQueueEnabled: true,
					mergeQueueEntry: { position: 1, state: "QUEUED", headCommit: null },
				}),
			],
			[],
			[],
			since,
		);
		expect(queues.map((q) => [q.base, q.mode, q.entries.map((e) => e.number)])).toEqual([
			["main", "merge-queue", [2]],
			["release", "own", [1]],
		]);
	});

	it("pairs each drop with the watcher's next word on that pick, newest drop first", () => {
		const queues = landingQueues(
			[pull(1), pull(2)],
			[{ number: 3, title: "PR 3", url: "u3", baseRefName: "release", isMergeQueueEnabled: false }],
			[
				said(
					1,
					"p1",
					"removed",
					hours(5),
					"the queue removed this pull request because it conflicts (`merge_conflict`).",
				),
				said(1, "p1", "requeued", hours(4), "re-enqueued this pull request"),
				said(1, "p1", "removed", hours(3), "removed again (`failed_checks`)."),
				said(1, "p0", "handback", hours(2), "an older pick's handback"),
				said(2, "p2", "removed", hours(30), "too old (`failed_checks`)."),
				said(2, "p2", "handback", hours(1), "after a drop outside the window"),
				said(1, "p1", "removed", hours(1), "forged (`manual`).", false),
				said(3, "p3", "removed", hours(2), "closed since (`checks_timed_out`)."),
				said(3, "p3", "handback", hours(1), "handed back"),
			],
			since,
		);
		const main = queues.find((q) => q.base === "main")!;
		expect(
			main.drops.map((d) => [d.pull.number, d.reason, d.outcome?.kind ?? null, d.outcome?.text ?? null]),
		).toEqual([
			[1, "failed_checks", null, null],
			[1, "merge_conflict", "requeued", "re-enqueued this pull request"],
		]);
		expect(main.drops[1]!.text).toBe(
			"the queue removed this pull request because it conflicts (`merge_conflict`).",
		);
		expect(queues.find((q) => q.base === "release")).toMatchObject({
			mode: "own",
			entries: [],
			drops: [{ pull: { number: 3 }, reason: "checks_timed_out", outcome: { kind: "handback" } }],
		});
	});
});

describe("landing queue page", () => {
	afterEach(() => vi.restoreAllMocks());
	const queuePage = (cookie: string) =>
		app.request(`${origin}/projects/github/upstream/project/queue`, { headers: { Cookie: cookie } }, testEnv);

	it("shows a maintainer each base's queue, build, and drops, and refuses anyone without maintain", async () => {
		const { cookie, repo, pr, other } = await maintainerOf();
		repo.queue = true;
		pr.queued = true;
		pr.group = {
			state: "AWAITING_CHECKS",
			runs: [
				{
					name: "Queue",
					conclusion: "SUCCESS",
					url: "https://github.com/upstream/project/actions/runs/42/job/1",
				},
			],
		};
		const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
		pr.comments = [
			{
				author: "quest-test[bot]",
				body: "quest land watch: the merge queue removed this pull request because it conflicts with `trunk` (`merge_conflict`).\n\n<!-- quest land fixer: 2026-11-07T00:00:00Z removed RFMQE_1 -->",
				at: at(30),
			},
			{
				author: "quest-test[bot]",
				body: "quest land watch: re-enqueued this pull request at the back of the merge queue.\n\n<!-- quest land fixer: 2026-11-07T00:00:00Z requeued watch-job-1.json -->",
				at: at(20),
			},
		];
		const response = await queuePage(cookie);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain('trunk <span class="muted">through GitHub&#39;s merge queue</span>');
		expect(html).toContain('href="https://github.com/upstream/project/actions/runs/42"');
		expect(html).toContain("Dropped for merge_conflict");
		expect(html).toContain("Re-enqueued");

		const reader = await other("read");
		expect((await queuePage(reader.session)).status).toBe(403);
	});
});
