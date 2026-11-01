// The seeded local server's data must load on the current schema and routes,
// and show every inbox state it exists to check.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { commitOf, fakeGitHub, headOf, intercept, type World } from "../dev/github";
import { seed, world } from "../dev/seed";
import { app } from "../src/index";
import { inboxURL } from "../src/jobs/routes";
import { cancel, createJob, createRunner, dispatch, report } from "../src/jobs/store";
import { privateKey } from "./github-key";
import { origin } from "./login-fixtures";

const testEnv = { ...env, GITHUB_APP_PRIVATE_KEY: privateKey };
const db = env.DB;
afterEach(() => vi.restoreAllMocks());

/**
 * Seed a fresh world, after `edit` changes it, against the fake GitHub,
 * returning it, a request helper, and the session cookie.
 */
async function seeded(edit: (world: World) => void = () => {}) {
	const data = { ...world(), forks: env.GITHUB_FORK_OWNER };
	edit(data);
	vi.spyOn(globalThis, "fetch").mockImplementation(fakeGitHub(data));
	// Webhooks read and notify in the background, so each request finishes its `waitUntil` work.
	const request = async (path: string, init?: RequestInit) => {
		const ctx = createExecutionContext();
		const response = await app.request(`${origin}${path}`, init, testEnv, ctx);
		await waitOnExecutionContext(ctx);
		return response;
	};
	const { user, cookie } = await seed({
		fetch: request,
		db,
		world: data,
		origin,
		secret: env.GITHUB_WEBHOOK_SECRET,
	});
	// The first project's inbox items and job forms, as the signed-in maintainer.
	const rocket = data.repos[0]!;
	const page = async (item: string) =>
		(await request(inboxURL(rocket.id, item), { headers: { Cookie: cookie } })).text();
	const post = (path: string, fields: Record<string, string>) =>
		request(`/projects/github/${rocket.owner}/${rocket.name}${path}`, {
			method: "POST",
			redirect: "manual",
			headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(fields).toString(),
		});
	return { data, request, user, cookie, rocket, page, post };
}

const latest = (target: string) =>
	db
		.prepare("SELECT id,state,head,pull,continues FROM jobs WHERE target=? ORDER BY createdAt DESC LIMIT 1")
		.bind(target)
		.first<{ id: string; state: string; head: string; pull: number | null; continues: string | null }>();

/** Start over on the seeded job whose branch changed, returning its open question. */
async function startOver(page: (item: string) => Promise<string>) {
	const blocked = await page("quest/m1/fonts.md");
	expect(blocked).toContain("Start over");
	return blocked.match(/name="question" value="([^"]+)"/)![1]!;
}

/** Run `run` once, ahead of the first request to GitHub matching `when`; a response it returns answers that request. */
function meanwhile(data: World, when: (url: URL, method: string) => boolean, run: () => Promise<Response | void>) {
	vi.mocked(globalThis.fetch).mockImplementation(
		intercept(fakeGitHub(data), when, async (next) => (await run()) ?? next()),
	);
}

it("seeds a representative inbox through the Worker's own routes", async () => {
	const { data, request, cookie } = await seeded();
	const inbox = await request("/inbox", { headers: { Cookie: cookie } });
	expect(inbox.status).toBe(200);
	const html = await inbox.text();
	for (const text of [
		// The active decision: the oldest agent prompt, with its three questions.
		"What should an empty config file do?",
		"Which other config edge cases should the quest cover?",
		"Should the fix ship as a patch release?",
		// Up next and in progress.
		"Add passkey sign-in",
		"Try a shared build cache",
		"Fix the flaky sign-in redirect",
		"Build the landing page hero",
		"Bump dependencies",
		"Add a dark mode toggle",
		// Read by number after its webhook.
		"Sync stops after the laptop sleeps",
		"Export a project as a ZIP archive",
		"Settings page loses unsaved changes when the session expires",
		"Keep working offline",
		// A new plan named by its idea, and a finished job's follow-ups to plan.
		"Let people share a read-only link to a project",
		"Follow-ups from quest/m0/cli.md",
		// The paused project.
		"example/archive",
	])
		expect(html).toContain(text);
	// Claimed and blocked quests, and closed issues, are not offered.
	for (const text of ["Write the getting-started guide", "Report anonymous crash telemetry", "Old crash on startup"])
		expect(html).not.toContain(text);
	// A draft its starter holds is in progress; one handed back with decisions waits on the maintainer.
	const section = (heading: string) => html.match(new RegExp(`<h2>${heading}</h2>[\\s\\S]*?</ol>`))?.[0] ?? "";
	expect(section("In progress")).toMatch(/Draft the theme picker<\/a><span class="entry-meta"><span>Claimed draft/);
	expect(section("Up next")).toContain("Search quest titles");

	// The board agrees: a held draft claims its quest, a handed-back one is turned in.
	const board = await (
		await request("/projects/github/example/rocket/board", { headers: { Cookie: cookie } })
	).text();
	const row = (title: string) => board.match(new RegExp(`${title}</a>[\\s\\S]*?</li>`))?.[0] ?? "";
	expect(row("Support custom color themes")).toContain("Claimed");
	expect(row("Search across projects")).toContain("Ready to turn in");

	// The items this test checks open on their own. Each inbox page rechecks
	// GitHub authority, so the inbox tests cover the other threads.
	const open = async (target: string) => {
		const response = await request(inboxURL(9101, target), { headers: { Cookie: cookie } });
		expect(response.status).toBe(200);
		return response.text();
	};
	expect(await open("pulls/17")).toContain("Its starter holds this draft");
	// GitHub's UNKNOWN on a recorded pull request keeps the clean state it last reported.
	expect(await open("pulls/19")).toContain("/pulls/19/merge");

	// The clean pull request merges through the fake GitHub.
	const head = (await open("pulls/12")).match(
		/action="([^"]+\/pulls\/12\/merge)"[\s\S]*?name="head" value="([0-9a-f]{40})"/,
	);
	expect(head).not.toBeNull();
	const merged = await request(head![1]!, {
		method: "POST",
		redirect: "manual",
		headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ head: head![2]! }).toString(),
	});
	expect(merged.status).toBe(303);
	expect(data.repos[0]!.pulls.find((p) => p.number === 12)!.closed).toBe(true);
});

it("lists the seeded maintainer's repositories in the project picker", async () => {
	const { data, request, cookie } = await seeded();
	// Repositories installed after seeding, which seeding would otherwise enroll.
	const archive = data.repos.find((repo) => repo.name === "archive")!;
	data.repos.push({ ...archive, id: 9103, name: "launchpad", issues: [], pulls: [] });
	data.repos.push({ ...archive, id: 9104, name: "bare", files: [], issues: [], pulls: [] });
	data.repos.push({ ...archive, id: 9105, name: "others", maintainers: [], issues: [], pulls: [] });
	const html = await (await request("/projects", { headers: { Cookie: cookie } })).text();
	const row = (name: string) => html.match(new RegExp(`example/${name}</a>[\\s\\S]*?</li>`))?.[0] ?? "";
	expect(row("rocket")).toContain("Contributions enabled");
	expect(row("archive")).toContain("Contributions paused");
	expect(row("launchpad")).toContain('action="/projects/github/example/launchpad"');
	expect(row("bare")).toContain("No Quest files on the default branch yet.");
	// A repository the user does not maintain is not offered.
	expect(html).not.toContain("example/others");
});

it("ignores a quest branch left at the head of its merged pull request", async () => {
	const { request, cookie } = await seeded((data) => {
		const rocket = data.repos[0]!;
		const closed = { author: "contributor", checks: "SUCCESS", review: "APPROVED", closed: true } as const;
		rocket.pulls.push(
			// Its work landed, so the branch holds nothing.
			{ ...closed, number: 21, title: "Passkeys", branch: "quest/m0/sign-in", merged: true },
			// Closed unmerged: that work may be wanted back.
			{ ...closed, number: 22, title: "Offline", branch: "quest/m1/offline" },
			// Pushed to after its merge: new work.
			{ ...closed, number: 23, title: "Export", branch: "quest/m0/export", merged: true, head: "e".repeat(40) },
		);
		// Each branch outlived its pull request.
		Object.assign(rocket.branches, {
			"quest/m0/sign-in": "a".repeat(40),
			"quest/m1/offline": "b".repeat(40),
			"quest/m0/export": "c".repeat(40),
		});
	});
	const board = await (
		await request("/projects/github/example/rocket/board", { headers: { Cookie: cookie } })
	).text();
	const row = (title: string) => board.match(new RegExp(`${title}[^<]*</a>[\\s\\S]*?</li>`))?.[0] ?? "";
	expect(row("Add passkey sign-in")).toContain("Account limited");
	expect(row("Keep working offline")).toContain("Queued");
	expect(row("Export a project as a ZIP archive")).toContain("Claimed");
	// The inbox agrees: it offers the landed quest, and not the one new work claims.
	const inbox = await (await request("/inbox", { headers: { Cookie: cookie } })).text();
	expect(inbox).toContain("Add passkey sign-in");
	expect(inbox).not.toContain("Export a project as a ZIP archive");
});

it("gets failed and blocked jobs moving again from the inbox", async () => {
	const { rocket, page, post } = await seeded();

	// The failed job opened pull request 20 without recording it; that claim does not block its retry.
	const failed = await page("quest/m0/import.md");
	expect(failed).not.toContain("no longer ready to start");
	const form = failed.match(
		/name="target" value="quest\/m0\/import.md"[\s\S]*?name="revision" value="([0-9a-f]{40})"/,
	);
	expect(form).not.toBeNull();
	const retried = await post("/jobs", {
		workflow: "start",
		target: "quest/m0/import.md",
		revision: form![1]!,
	});
	expect(retried.status).toBe(303);
	expect(await latest("quest/m0/import.md")).toMatchObject({
		state: "queued",
		head: headOf(
			rocket,
			rocket.pulls.find((p) => p.number === 20)!,
		),
		pull: null,
		continues: "seed-start-import",
	});

	// A branch changed outside its job starts over from the job's revision.
	const question = await startOver(page);
	const restarted = await post("/jobs/seed-start-fonts/answer", { question, restart: "1" });
	expect(restarted.status).toBe(303);
	expect(rocket.fork["quest/m1/fonts"]).toBe(commitOf(rocket));
	expect(await db.prepare("SELECT state FROM jobs WHERE id='seed-start-fonts'").first()).toEqual({
		state: "cancelled",
	});
	expect(await latest("quest/m1/fonts.md")).toMatchObject({
		state: "queued",
		head: commitOf(rocket),
		pull: null,
		continues: null,
	});
	// The decision is spent, so a repeated Start over is refused.
	const again = await post("/jobs/seed-start-fonts/answer", { question, restart: "1" });
	expect(again.status).not.toBe(303);

	// A finished job's follow-ups start their interview from the form the inbox shows.
	const followups = "plans/00000000-5eed-4000-8000-000000000002";
	const offer = (await page(followups)).match(
		/name="target" value="([^"]+)"[\s\S]*?name="revision" value="([0-9a-f]{40})"[\s\S]*?Plan these follow-ups/,
	);
	expect(offer?.[1]).toBe(followups);
	const planned = await post("/jobs", { workflow: "plan", target: followups, revision: offer![2]! });
	expect(planned.status).toBe(303);
	expect(await latest(followups)).toMatchObject({ state: "queued" });
});

it("never resets the branch for a Start over that a concurrent cancel beat", async () => {
	const { data, rocket, page, post } = await seeded();
	const question = await startOver(page);
	// Another maintainer cancels the job after this request read it, while it rechecks GitHub.
	meanwhile(
		data,
		(url) => url.pathname === `/repos/${data.forks}/${rocket.name}`,
		() => cancel(db, "seed-start-fonts", "another-maintainer", Date.now()),
	);
	const restarted = await post("/jobs/seed-start-fonts/answer", { question, restart: "1" });
	expect(restarted.status).toBe(409);
	expect(rocket.fork["quest/m1/fonts"]).toBe("f".repeat(40));
	expect(await latest("quest/m1/fonts.md")).toMatchObject({ id: "seed-start-fonts", state: "cancelled" });
});

it("leaves a Start over whose reset failed waiting to start over again", async () => {
	const { data, rocket, page, post } = await seeded();
	const question = await startOver(page);
	meanwhile(
		data,
		(url, method) => method === "PATCH" && url.pathname.startsWith(`/repos/${data.forks}/${rocket.name}/git/refs/`),
		async () => Response.json({ message: "Server Error" }, { status: 502 }),
	);
	const restarted = await post("/jobs/seed-start-fonts/answer", { question, restart: "1" });
	expect(restarted.status).not.toBe(303);
	expect(rocket.fork["quest/m1/fonts"]).toBe("f".repeat(40));
	// The claim stands: the old job ended, and its replacement waits on the same decision instead of running.
	expect(await db.prepare("SELECT state FROM jobs WHERE id='seed-start-fonts'").first()).toEqual({
		state: "cancelled",
	});
	const held = await latest("quest/m1/fonts.md");
	expect(held).toMatchObject({ state: "waiting", head: commitOf(rocket), continues: null });

	// Starting the replacement over resets the branch once GitHub accepts it.
	vi.mocked(globalThis.fetch).mockImplementation(fakeGitHub(data));
	const retry = await startOver(page);
	expect(retry).not.toBe(question);
	const again = await post(`/jobs/${held!.id}/answer`, { question: retry, restart: "1" });
	expect(again.status).toBe(303);
	expect(rocket.fork["quest/m1/fonts"]).toBe(commitOf(rocket));
	expect(await latest("quest/m1/fonts.md")).toMatchObject({ state: "queued", head: commitOf(rocket) });
});

it("publishes jobs' work end to end, through the fork branch to the pull request", async () => {
	const { request, user, rocket } = await seeded();
	const now = Date.now();
	// A retry of the failed import job continues from the branch and pull request it left.
	const retry = await createJob(
		db,
		{
			repository: rocket.id,
			actor: user,
			workflow: "start",
			target: "quest/m0/import.md",
			revision: commitOf(rocket),
			branch: "quest/m0/import",
			trusted: true,
		},
		now,
	);
	const { id, token } = await createRunner(db, user, "test", "linux", true, now);
	const machine = { id, owner: user, name: "test", platform: "linux" as const, vm: 1 };
	await report(
		db,
		machine,
		[{ id: "main", provider: "anthropic", kind: "subscription", label: "main", limited: false }],
		[],
		now,
	);
	await dispatch(db, user, new Map([[id, 2]]), now);
	const publish = async (body: Record<string, unknown>) => {
		const text = JSON.stringify({ attempt: 1, ...body });
		const response = await request("/api/runner/publish", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"Content-Length": String(new TextEncoder().encode(text).length),
			},
			body: text,
		});
		expect(response.status).toBe(200);
		return (await response.json()) as { head: string; pull?: { number: number; draft: boolean } };
	};
	const pull = { title: "Keep working offline", body: "Queues edits while offline." };

	// The queued job commits on a new fork branch, then opens a draft pull request from it.
	const first = await publish({
		job: "seed-start-offline",
		head: null,
		message: "feat: queue offline edits",
		changes: [{ path: "src/offline.ts", content: Buffer.from("export {};\n").toString("base64") }],
	});
	expect(rocket.fork["quest/m1/offline"]).toBe(first.head);
	expect(rocket.commits[first.head]!.parents).toEqual([commitOf(rocket)]);
	const opened = await publish({ job: "seed-start-offline", head: first.head, pull });
	expect(opened.pull).toMatchObject({ number: 21, draft: true });
	expect(rocket.pulls.at(-1)).toMatchObject({ number: 21, branch: "quest/m1/offline", fork: true, draft: true });
	// Finished work marks it ready for review.
	await publish({ job: "seed-start-offline", head: first.head, pull: { ...pull, draft: false } });
	expect(rocket.pulls.at(-1)!.draft).toBe(false);

	const continued = await latest("quest/m0/import.md");
	expect(continued).toMatchObject({ id: retry.id, state: "running", head: rocket.fork["quest/m0/import"] });
	const adopted = await publish({ job: retry.id, head: continued!.head, pull: { title: "Import", body: "Done" } });
	expect(adopted.pull).toMatchObject({ number: 20 });
	expect(rocket.pulls.filter((p) => p.branch === "quest/m0/import")).toHaveLength(1);
});
