// Representative kix state for checking UI changes locally, and the base for
// stubbed end-to-end tests. Sign-in, enrollment, observations, and webhooks go
// through the Worker's own routes against the fake GitHub, so they follow the
// current code; only runners and jobs, which need a live runner, are written
// to D1 directly.
import {
	type Comment,
	type Pull,
	type Repo,
	type World,
	commitOf,
	databaseId,
	headOf,
	webhookSignature,
} from "./github";

const quest = (title: string, goal: string, required: string[] = []) =>
	`# ${title}\n\n## Goal\n\n${goal}\n` + (required.length ? `\n## Required\n\n${required.join("\n")}\n` : "");
/** A discussion of `count` short comments. */
const remarks = (count: number, author: string): Comment[] =>
	Array.from({ length: count }, (_, i) => ({ author, body: `Seen it too (${i + 1}).`, at: "2026-10-19T12:00:00Z" }));

/** A fresh world: `seed` adds to it, and the fake GitHub answers from it. */
export function world(): World {
	const rocket: Repo = {
		id: 9101,
		owner: "example",
		name: "rocket",
		maintainers: ["dev-maintainer"],
		writers: ["reviewer"],
		files: [
			{ path: "flake.nix", content: "{ outputs = _: { }; }\n" },
			{
				path: "quest/README.md",
				content: quest("Quests", "Plan the rocket app.", [
					"- [M0: Beta](/quest/m0/README.md) - the first public beta",
					"- [M1: Later](/quest/m1/README.md) - after the beta",
				]),
			},
			{
				path: "quest/m0/README.md",
				content: quest("Beta", "Ship the first public beta.", [
					"- [Landing page](/quest/m0/landing.md) - explain the app",
					"- [Passkey sign-in](/quest/m0/sign-in.md) - sign in without a password",
					"- [Getting started](/quest/m0/docs.md) - a first-run guide",
					"- [Crash telemetry](/quest/m0/telemetry.md) - learn about crashes",
					"- [ZIP export](/quest/m0/export.md) - take your data with you",
					"- [ZIP import](/quest/m0/import.md) - bring your data back",
				]),
			},
			{ path: "quest/m0/import.md", content: quest("[S] Import a project from a ZIP archive", "Restore it.") },
			{ path: "quest/m0/landing.md", content: quest("[S] Build the landing page", "Explain the app.") },
			{ path: "quest/m0/sign-in.md", content: quest("[M] Add passkey sign-in", "Sign in without a password.") },
			{ path: "quest/m0/docs.md", content: quest("[XS] Write the getting-started guide", "A first-run guide.") },
			{
				path: "quest/m0/telemetry.md",
				content: quest("[S] Report anonymous crash telemetry", "Learn about crashes.", [
					"- [Passkey sign-in](/quest/m0/sign-in.md) - telemetry is opt-in per account",
				]),
			},
			{ path: "quest/m0/export.md", content: quest("[S] Export a project as a ZIP archive", "Take your data.") },
			{
				path: "quest/m1/README.md",
				content: quest("Later", "Work after the beta.", [
					"- [Offline mode](/quest/m1/offline.md) - keep working without a network",
					"- [Themes](/quest/m1/themes.md) - custom colors",
					"- [Search](/quest/m1/search.md) - find anything",
					"- [Fonts](/quest/m1/fonts.md) - choose the editor font",
				]),
			},
			{ path: "quest/m1/fonts.md", content: quest("[S] Choose the editor font", "Read comfortably.") },
			{ path: "quest/m1/search.md", content: quest("[S] Search across projects", "Find anything.") },
			{
				path: "quest/m1/offline.md",
				content: quest(
					"[L] Keep working offline and sync every change once the phone reconnects to the network",
					"Edits made offline sync without conflicts.",
				),
			},
			{ path: "quest/m1/themes.md", content: quest("[M] Support custom color themes", "Pick your colors.") },
		],
		issues: [
			{ number: 2, title: "Old crash on startup", author: "reporter", closed: true },
			{
				number: 3,
				title: "Crash when the config file is empty",
				author: "reporter",
				body: "The app crashes on startup when `config.toml` exists but is empty.",
				comments: [
					{ author: "maintainer", body: "Reproduced on main.", at: "2026-10-19T12:00:00Z" },
					{ author: null, body: "Same with a file holding only whitespace.", at: "2026-10-19T13:00:00Z" },
				],
			},
			{
				number: 7,
				title: "Settings page loses unsaved changes when the session expires while the browser tab sits in the background on a phone",
				author: "phone-user",
				comments: remarks(5, "phone-user"),
			},
			{ number: 8, title: "Add a dark mode toggle", author: "night-owl" },
		],
		pulls: [
			{
				number: 12,
				title: "Build the landing page hero",
				author: "contributor",
				branch: "quest/m0/landing",
				checks: "SUCCESS",
				review: "APPROVED",
				reviews: [{ state: "APPROVED", author: "reviewer" }],
				comments: remarks(3, "reviewer"),
				merge: "CLEAN",
			},
			{
				number: 14,
				title: "Fix the flaky sign-in redirect",
				author: "contributor",
				branch: "fix/sign-in-redirect",
				checks: "FAILURE",
				review: "CHANGES_REQUESTED",
				reviews: [{ state: "CHANGES_REQUESTED", author: "reviewer" }],
			},
			{
				number: 15,
				title: "Try a shared build cache",
				author: "dev-maintainer",
				branch: "build-cache",
				checks: "PENDING",
				review: null,
				draft: true,
			},
			{
				number: 16,
				title: "Bump dependencies",
				author: "bot",
				branch: "deps",
				checks: null,
				review: "REVIEW_REQUIRED",
			},
			// A claim its starter still holds: work in progress, not a decision.
			{
				number: 17,
				title: "Draft the theme picker",
				author: "contributor",
				branch: "quest/m1/themes",
				checks: "PENDING",
				review: null,
				draft: true,
				body: "Started on the picker.",
			},
			// A draft handed back with decisions: it waits on the maintainer.
			{
				number: 18,
				title: "Search quest titles",
				author: "contributor",
				branch: "quest/m1/search",
				checks: "SUCCESS",
				review: null,
				draft: true,
				body: "Titles are indexed.\n\n## Decisions needed\n\n1. Index quest bodies too?\n",
			},
			// Clean when first read; `seed` rereads it while GitHub reports UNKNOWN.
			{
				number: 19,
				title: "Speed up cold start",
				author: "contributor",
				branch: "perf/cold-start",
				checks: "SUCCESS",
				review: "APPROVED",
				merge: "CLEAN",
			},
		],
		// A claim pushed without a pull request.
		branches: {
			"quest/m0/docs": "d".repeat(40),
			// Changed outside its waiting job, which can start over.
			"quest/m1/fonts": "f".repeat(40),
		},
		commits: {},
		trees: {},
	};
	// kix opened this one from its upstream branch for a job that then failed before recording it.
	const imported: Pull = {
		number: 20,
		title: "Import a project from a ZIP archive",
		author: "quest-dev[bot]",
		branch: "quest/m0/import",
		checks: "PENDING",
		review: null,
		draft: true,
	};
	rocket.pulls.push(imported);
	rocket.branches[imported.branch] = headOf(rocket, imported);
	const archive: Repo = {
		id: 9102,
		owner: "example",
		name: "archive",
		maintainers: ["dev-maintainer"],
		files: [
			{
				path: "quest/README.md",
				content: quest("Quests", "Retire the old site.", ["- [M0: Retire](/quest/m0/README.md) - retire it"]),
			},
			{
				path: "quest/m0/README.md",
				content: quest("Retire", "Retire the old site.", [
					"- [Clean up](/quest/m0/cleanup.md) - remove old pages",
				]),
			},
			{ path: "quest/m0/cleanup.md", content: quest("[S] Remove the old pages", "Nothing links to them.") },
		],
		issues: [{ number: 1, title: "Archive the old site", author: "reporter" }],
		pulls: [],
		branches: {},
		commits: {},
		trees: {},
	};
	return {
		app: { id: 123, slug: "quest-dev" },
		installation: 9201,
		users: [{ id: 9001, login: "dev-maintainer", name: "Dev Maintainer", email: "maintainer@example.test" }],
		repos: [rocket, archive],
	};
}

/** Send a request to the Worker by path, as a browser on its origin would. */
export type Fetch = (path: string, init?: RequestInit) => Response | Promise<Response>;

async function expect(response: Response | Promise<Response>, status: number, step: string) {
	const result = await response;
	if (result.status !== status)
		throw new Error(`Seed step "${step}" returned ${result.status}: ${(await result.text()).slice(0, 300)}`);
	return result;
}

const cookies = (response: Response) =>
	response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");

const form = (fields: Record<string, string>) => ({
	headers: { "Content-Type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams(fields).toString(),
});

/**
 * Sign in as the world's first user, enroll its repositories (the second one
 * paused), observe them, and add jobs in every state the inbox shows.
 * Returns the signed-in user and session cookie.
 */
export async function seed(options: { fetch: Fetch; db: D1Database; world: World; origin: string; secret: string }) {
	const { db, world, origin } = options;
	const post = (path: string, fields: Record<string, string>, cookie: string) => {
		const body = form(fields);
		return options.fetch(path, {
			method: "POST",
			redirect: "manual",
			headers: { ...body.headers, Origin: origin, Cookie: cookie },
			body: body.body,
		});
	};

	const start = await expect(post("/sign-in", { provider: "github" }, ""), 303, "sign in");
	const state = new URL(start.headers.get("Location")!).searchParams.get("state");
	const callback = await expect(
		options.fetch(`/api/auth/callback/github?code=fake&state=${state}`, {
			headers: { Cookie: cookies(start) },
			redirect: "manual",
		}),
		302,
		"OAuth callback",
	);
	const cookie = cookies(callback)
		.split("; ")
		.filter((c) => c.startsWith("better-auth.session_token="))
		.join("; ");
	if (!cookie) throw new Error("Seed sign-in returned no session");
	const me = world.users[0]!;
	const user = (await db
		.prepare("SELECT userId FROM account WHERE providerId='github' AND accountId=?")
		.bind(String(me.id))
		.first<{ userId: string }>())!.userId;

	const [rocket, archive] = world.repos as [Repo, Repo];
	for (const repo of world.repos) {
		const path = `/projects/github/${repo.owner}/${repo.name}`;
		await expect(post(path, { id: String(repo.id), state: "enabled" }, cookie), 303, `enroll ${repo.name}`);
		await expect(post(`${path}/refresh`, {}, cookie), 303, `refresh ${repo.name}`);
	}
	await expect(
		post(`/projects/github/${archive.owner}/${archive.name}`, { id: String(archive.id), state: "paused" }, cookie),
		303,
		"pause archive",
	);

	// GitHub recomputes a recorded PR's mergeability, such as after a push to
	// its base. The read below keeps its last known state rather than marking it new.
	rocket.pulls.find((pull) => pull.number === 19)!.merge = "UNKNOWN";
	// An issue opened since the refresh: its webhook rereads the project in the background.
	const pointer = { number: 9, title: "Sync stops after the laptop sleeps", author: "reporter" };
	rocket.issues.push(pointer);
	const body = JSON.stringify({
		action: "opened",
		installation: { id: world.installation },
		repository: { id: rocket.id },
		issue: { id: Number(databaseId(rocket, pointer.number)), number: pointer.number },
	});
	await expect(
		options.fetch("/webhooks/github", {
			method: "POST",
			headers: {
				"X-GitHub-Event": "issues",
				"X-GitHub-Delivery": crypto.randomUUID(),
				"X-Hub-Signature-256": await webhookSignature(options.secret, body),
			},
			body,
		}),
		202,
		"issue webhook",
	);

	await jobs(db, user, rocket);
	return { user, cookie };
}

// Runners and jobs a live runner would have reported, in each state the inbox shows.
async function jobs(db: D1Database, user: string, repo: Repo) {
	const now = Date.now();
	const commit = commitOf(repo);
	const head = (n: number) =>
		headOf(
			repo,
			repo.pulls.find((p) => p.number === n)!,
		);
	const runners = [
		["workstation", "workstation", "linux", 1],
		["laptop", "laptop", "darwin", 0],
	] as const;
	const accounts = [
		["workstation", "claude-max", "claude", "subscription", "Claude Max", 0, 0],
		["laptop", "claude-pro", "claude", "subscription", "Claude Pro", 1, 1],
		["workstation", "api", "anthropic", "api-key", "Anthropic API key", 2, 0],
	] as const;
	type Job = {
		id: string;
		workflow: "plan" | "start" | "iterate";
		target: string;
		revision: string;
		branch: string;
		state: "queued" | "running" | "waiting" | "failed" | "completed";
		/** The commit the job last published to its branch. */
		head?: string;
		runner?: string;
		account?: string;
		summary?: string;
		/** What a completed job reported, such as its suggested follow-ups. */
		result?: unknown;
		/** A new plan's request: the maintainer's idea and what they pasted with it. */
		idea?: string;
		context?: string;
		question?: { kind: "agent" | "account" | "publication"; prompt: unknown };
	};
	const list: Job[] = [
		{
			id: "seed-plan-config",
			workflow: "plan",
			target: "issues/3",
			revision: commit,
			branch: "plan/issue-3",
			state: "waiting",
			runner: "workstation",
			account: "claude-max",
			summary: "Read the issue and the config loader. Three choices need you before planning.",
			question: {
				kind: "agent",
				prompt: {
					kind: "decision",
					questions: [
						{
							header: "Behavior",
							question: "What should an empty config file do?",
							options: [
								{
									label: "Use defaults",
									description: "Treat it like a missing file.",
									recommended: true,
								},
								{ label: "Fail with an error", description: "Name the file and the expected format." },
							],
						},
						{
							header: "Scope",
							question: "Which other config edge cases should the quest cover?",
							multiple: true,
							options: [
								{ label: "Whitespace only", recommended: true },
								{ label: "Comments only" },
								{ label: "Byte order mark" },
							],
						},
						{
							question: "Should the fix ship as a patch release?",
							options: [{ label: "Yes", recommended: true }, { label: "No, wait for the beta" }],
						},
					],
				},
			},
		},
		{
			id: "seed-start-sign-in",
			workflow: "start",
			target: "quest/m0/sign-in.md",
			revision: commit,
			branch: "quest/m0/sign-in",
			state: "waiting",
			runner: "laptop",
			account: "claude-pro",
			summary: "Stopped at the account's usage limit after adding the passkey routes.",
			question: { kind: "account", prompt: { runner: "laptop", account: "claude-pro" } },
		},
		{
			id: "seed-iterate-cache",
			workflow: "iterate",
			target: "pulls/15",
			revision: head(15),
			branch: "build-cache",
			state: "waiting",
			runner: "workstation",
			account: "claude-max",
			summary: "Wants to populate the build cache.",
			question: {
				kind: "agent",
				prompt: {
					kind: "permission",
					questions: [
						{
							question: "Allow `nix build .#cache` to write to the shared cache?",
							options: [{ label: "Allow once" }, { label: "Deny" }],
						},
					],
				},
			},
		},
		{
			id: "seed-iterate-redirect",
			workflow: "iterate",
			target: "pulls/14",
			revision: head(14),
			branch: "fix/sign-in-redirect",
			state: "failed",
			runner: "workstation",
			account: "claude-max",
			summary: "just test failed: two sign-in tests time out against the new redirect.",
		},
		{
			id: "seed-start-import",
			workflow: "start",
			target: "quest/m0/import.md",
			revision: commit,
			branch: "quest/m0/import",
			state: "failed",
			// It opened pull request 20 at this commit, then failed before recording it.
			head: head(20),
			runner: "workstation",
			account: "claude-max",
			summary: "just check failed after the pull request opened: the importer skips empty folders.",
		},
		{
			id: "seed-start-fonts",
			workflow: "start",
			target: "quest/m1/fonts.md",
			revision: commit,
			branch: "quest/m1/fonts",
			state: "waiting",
			head: "e".repeat(40),
			runner: "workstation",
			account: "claude-max",
			summary: "Added the font picker; publishing it found the branch moved.",
			question: {
				kind: "publication",
				prompt: {
					type: "publication",
					blocked: "The branch quest/m1/fonts changed outside this job.",
					restart: true,
				},
			},
		},
		{
			id: "seed-plan-settings",
			workflow: "plan",
			target: "issues/7",
			revision: commit,
			branch: "plan/issue-7",
			state: "running",
			runner: "workstation",
			account: "claude-max",
			summary: "Reproducing the lost settings in a background tab.",
		},
		{
			id: "00000000-5eed-4000-8000-000000000001",
			workflow: "plan",
			target: "plans/00000000-5eed-4000-8000-000000000001",
			revision: commit,
			branch: "plan/00000000",
			state: "waiting",
			runner: "workstation",
			account: "claude-max",
			idea: "Let people share a read-only link to a project",
			context: "From the call with the design team:\n- links should expire\n- no sign-in to view",
			summary: "Read the call notes and the project pages. One choice decides the quests.",
			question: {
				kind: "agent",
				prompt: {
					kind: "decision",
					questions: [
						{
							header: "Expiry",
							question: "How long should a shared link last?",
							options: [
								{ label: "Until revoked" },
								{ label: "30 days", description: "Matches the call notes.", recommended: true },
							],
						},
					],
				},
			},
		},
		{
			id: "00000000-5eed-4000-8000-000000000002",
			workflow: "start",
			target: "quest/m0/cli.md",
			revision: commit,
			branch: "quest/m0/cli",
			state: "completed",
			runner: "workstation",
			account: "claude-max",
			summary: "Added the command-line entry point and its tests.",
			result: {
				head: null,
				followups: ["Shell completions for bash, zsh, and fish", "A --json flag on every listing command"],
			},
		},
		{
			id: "seed-start-offline",
			workflow: "start",
			target: "quest/m1/offline.md",
			revision: commit,
			branch: "quest/m1/offline",
			state: "queued",
		},
	];
	await db.batch([
		...runners.map(([id, name, platform, vm]) =>
			db
				.prepare(
					"INSERT INTO runners(id,owner,name,tokenHash,platform,vm,createdAt,seenAt) VALUES(?,?,?,?,?,?,?,?)",
				)
				.bind(id, user, name, `seed-${id}`, platform, vm, now, now),
		),
		...accounts.map(([runner, id, provider, kind, label, rank, limited]) =>
			db
				.prepare(
					"INSERT INTO runner_accounts(runner,id,provider,kind,label,rank,limited) VALUES(?,?,?,?,?,?,?)",
				)
				.bind(runner, id, provider, kind, label, rank, limited),
		),
		...list.flatMap((job, i) => {
			const attempt = job.runner ? 1 : 0;
			// Older jobs first, so each one's question keeps a stable order.
			const at = now - (list.length - i) * 60_000;
			return [
				db
					.prepare(
						"INSERT INTO jobs(id,repository,workflow,target,revision,branch,head,actor,trusted,state,attempt,runner,account,delivered,summary,result,idea,context,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
					)
					.bind(
						job.id,
						repo.id,
						job.workflow,
						job.target,
						job.revision,
						job.branch,
						job.head ?? null,
						user,
						job.workflow === "iterate" ? 0 : 1,
						job.state,
						attempt,
						job.runner ?? null,
						job.account ?? null,
						attempt,
						job.summary ?? null,
						job.result === undefined ? null : JSON.stringify(job.result),
						job.idea ?? null,
						job.context ?? null,
						at,
						now,
					),
				...(job.state === "completed"
					? [
							db
								.prepare("INSERT INTO job_events(job,attempt,kind,body,at) VALUES(?,?,'result',?,?)")
								.bind(
									job.id,
									attempt,
									JSON.stringify({ outcome: "completed", summary: job.summary ?? "" }),
									at,
								),
						]
					: []),
				...(job.question
					? [
							db
								.prepare(
									"INSERT INTO job_questions(id,job,attempt,kind,prompt,askedAt) VALUES(?,?,?,?,?,?)",
								)
								.bind(
									`${job.id}-q`,
									job.id,
									attempt,
									job.question.kind,
									JSON.stringify(job.question.prompt),
									at,
								),
						]
					: []),
			];
		}),
	]);
}
