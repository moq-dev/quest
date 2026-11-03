import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as projects from "../src/board/project";
import { app } from "../src/index";
import { identity, oauth } from "./login-fixtures";

afterEach(() => vi.restoreAllMocks());

const origin = "http://localhost:8787";

describe("Worker", () => {
	it("serves health and handles unknown routes", async () => {
		expect(await (await SELF.fetch(`${origin}/health`)).json()).toEqual({ status: "ok" });
		const missing = await SELF.fetch(`${origin}/missing`);
		expect(missing.status).toBe(404);
		expect(await missing.text()).toContain("Uncharted territory");
	});
	it("renders the home page in the shared layout", async () => {
		const html = await (await SELF.fetch(origin)).text();
		expect(html).toContain("A quest log for your repo and your agents");
		expect(html).toContain(`Follow ${origin}/setup to set up Quest here.`);
		expect(html).toContain('href="/theme/theme.css"');
		expect(html).toContain(`content="${origin}/theme/og.png"`);
		for (const section of ["files", "git", "sample", "how", "map", "contribute"]) {
			expect(html).toContain(`id="${section}"`);
		}
	});
	it("maps the repository's own quest tree on the home page", async () => {
		const html = await (await SELF.fetch(origin)).text();
		// Milestones open their section of the board; epics and waypoints open their pages.
		expect(html).toContain('href="/repos/quest#m0"');
		expect(html).not.toContain('href="https://github.com/moq-dev/quest/blob/main/quest/');
		const waypoints = [...html.matchAll(/class="waypoint [^"]+"><a href="(\/repos\/quest\/quest\/[^"]+)"/g)];
		const epics = [...html.matchAll(/<p class="path-name"><a href="(\/repos\/quest\/quest\/[^"]+)"/g)];
		expect(waypoints.length).toBeGreaterThan(0);
		await Promise.all(
			[...waypoints, ...epics].map(async ([, href]) => {
				const response = await SELF.fetch(`${origin}${href}`);
				expect(response.status, href).toBe(200);
				await response.body?.cancel();
			}),
		);
	});
	it("renders the repository's docs", async () => {
		const index = await (await SELF.fetch(`${origin}/docs`)).text();
		expect(index).toContain('href="/docs/getting-started"');
		expect(index).toContain("Use Quest in your repository");

		const page = await SELF.fetch(`${origin}/docs/getting-started`);
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain("<title>Use Quest in your repository · Quest</title>");
		expect(html).toContain('<h2 id="set-it-up">');
		// Relative links that work on GitHub point at GitHub from the site.
		expect(html).toContain('href="https://github.com/moq-dev/quest/blob/main/SETUP.md"');
		expect((await SELF.fetch(`${origin}/docs/missing`)).status).toBe(404);
	});
	it("renders this repository's quest board", async () => {
		const response = await SELF.fetch(`${origin}/repos/quest`);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("<h1>Quest log</h1>");
		expect(html).toContain("moq-dev/quest");
		expect(html).toMatch(/Milestone \d/);
		expect(html).toContain('role="progressbar"');
		expect(html).toContain('href="/repos/quest?show=available"');
		const filtered = await (await SELF.fetch(`${origin}/repos/quest?show=available`)).text();
		expect(filtered).not.toContain("Requires: ");
		expect((await SELF.fetch(`${origin}/repos/missing`)).status).toBe(404);
	});
	it("renders a quest page with breadcrumbs and its next step", async () => {
		const board = await (await SELF.fetch(`${origin}/repos/quest`)).text();
		const href = /<a class="entry-title" href="(\/repos\/quest\/quest\/[^"]+)"/.exec(board)![1];
		const page = await SELF.fetch(`${origin}${href}`);
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain('aria-label="Breadcrumb"');
		expect(html).toContain("<h2>Objectives</h2>");
		expect((await SELF.fetch(`${origin}/repos/quest/quest/missing`)).status).toBe(404);
		const root = await SELF.fetch(`${origin}/repos/quest/quest/README`, { redirect: "manual" });
		expect(root.headers.get("location")).toBe("/repos/quest");
	});
	it("opens encoded quest paths and pins Markdown links to the snapshot", async () => {
		const path = "quest/m0/space #?%/literal%23#?%.md";
		const project = {
			...projects.home,
			commit: "a".repeat(40),
			documents: [
				...projects.home.documents,
				{ path, content: "# [XS] Reserved filename\n\n## Goal\n\n[docs](/docs/a.md#goal)\n" },
			],
		};
		vi.spyOn(projects, "findProject").mockReturnValue(project);
		const href = "/repos/quest/quest/m0/space%20%23%3F%25/literal%2523%23%3F%25";
		for (const page of ["/", "/repos/quest"]) {
			const rendered = await app.fetch(new Request(`${origin}${page}`), env);
			expect(await rendered.text()).toContain(`href="${href}"`);
		}
		const response = await app.fetch(new Request(`${origin}${href}`), env);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("Reserved filename");
		expect(html).toContain(
			`href="https://github.com/moq-dev/quest/blob/${project.commit}/quest/m0/space%20%23%3F%25/literal%2523%23%3F%25.md"`,
		);
		expect(html).toContain(`href="https://github.com/moq-dev/quest/blob/${project.commit}/docs/a.md#goal"`);
		const separator = await app.fetch(new Request(`${origin}${href.replace("/m0/", "/m0%2F")}`), env);
		expect(separator.status).toBe(404);
	});
	it.each([
		["/repos/quest/quest/m0", "/repos/quest/quest/m0"],
		["/repos/quest?show=available", "/repos/quest?show=available"],
		...[
			"//evil.example",
			"/\\evil.example",
			"https://evil.example",
			"/\t/evil.example",
			"/\n/x",
			"/%2F/evil.example",
			"/%5cevil.example",
		].map((next) => [next, "/inbox"]),
	])("returns to a local page after signing in: %j -> %j", async (next, expected) => {
		const response = await SELF.fetch(`${origin}/sign-in`, {
			method: "POST",
			headers: { Origin: origin },
			body: new URLSearchParams({ next }),
			redirect: "manual",
		});
		expect(response.status).toBe(303);
		const row = await env.DB.prepare("SELECT value FROM verification").first<{ value: string }>();
		expect(JSON.parse(row!.value).callbackURL).toBe(expected);
	});
	it("offers to return to the page as requested, still encoded", async () => {
		const response = await SELF.fetch(`${origin}/%09/evil.example`);
		expect(response.status).toBe(404);
		expect(await response.text()).toContain('href="/sign-in?next=%2F%2509%2Fevil.example"');
		for (const path of ["%E0", "%", "m0%2Fcloudflare%2Fboard"]) {
			expect((await SELF.fetch(`${origin}/repos/quest/quest/${path}`)).status).toBe(404);
		}
	});
	it("redirects the setup short link to SETUP.md", async () => {
		const response = await SELF.fetch(`${origin}/setup`, { redirect: "manual" });
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("https://github.com/moq-dev/quest/blob/main/SETUP.md");
	});
	it("links to sign-in without a session", async () => {
		const response = await SELF.fetch(origin);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		// Sign-in form posts must carry this origin, not `null`.
		expect(response.headers.get("referrer-policy")).toBe("same-origin");
		expect(await response.text()).toContain('href="/sign-in?next=%2F"');
	});
	it("starts GitHub App OAuth without OAuth-app scopes, with persisted state and cookies", async () => {
		const response = await SELF.fetch(`${origin}/sign-in`, {
			method: "POST",
			headers: { Origin: origin },
			redirect: "manual",
		});
		expect(response.status).toBe(303);
		const location = new URL(response.headers.get("location")!);
		expect(location.origin).toBe("https://github.com");
		expect(location.searchParams.get("client_id")).toBe("test-client-id");
		expect(location.searchParams.get("scope") ?? "").toBe("");
		expect(location.searchParams.get("redirect_uri")).toBe(`${origin}/api/auth/callback/github`);
		expect(location.searchParams.get("state")).toBeTruthy();
		expect(response.headers.get("set-cookie")).toContain("better-auth.state=");
	});
	it("signs a private-email user in with an expiring GitHub App token and signs out", async () => {
		const start = await SELF.fetch(`${origin}/sign-in`, {
			method: "POST",
			headers: { Origin: origin },
			redirect: "manual",
		});
		const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
		const stateCookie = start.headers.get("set-cookie")!.split(";")[0];
		const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === "https://github.com/login/oauth/access_token") {
				const credentials = new URLSearchParams(String(init?.body));
				expect(credentials.get("client_id")).toBe("test-client-id");
				expect(credentials.get("client_secret")).toBe("test-client-secret");
				return Response.json({
					access_token: "ghu_mock-token",
					refresh_token: "ghr_mock-refresh",
					expires_in: 28800,
					refresh_token_expires_in: 15897600,
					token_type: "bearer",
					scope: "",
				});
			}
			if (url === "https://api.github.com/user") {
				return Response.json({
					id: 1234,
					login: "contributor",
					name: "Contributor",
					email: null,
					avatar_url: null,
				});
			}
			if (url === "https://api.github.com/user/emails") {
				return Response.json([{ email: "contributor@example.com", primary: true, verified: true }]);
			}
			throw new Error(`Unexpected outbound request: ${url}`);
		});
		const callback = await SELF.fetch(`${origin}/api/auth/callback/github?code=mock-code&state=${state}`, {
			headers: { Cookie: stateCookie },
			redirect: "manual",
		});
		expect(callback.status).toBe(302);
		expect(callback.headers.get("location")).toBe("/inbox");
		expect(outbound).toHaveBeenCalled();
		const sessionCookie = callback.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith("better-auth.session_token="))!
			.split(";")[0];
		const session = await SELF.fetch(`${origin}/api/auth/get-session`, { headers: { Cookie: sessionCookie } });
		expect(((await session.json()) as { user: { name: string } }).user.name).toBe("Contributor");
		const home = await SELF.fetch(origin, { headers: { Cookie: sessionCookie } });
		expect(await home.text()).toContain("Signed in as Contributor");
		const logout = await SELF.fetch(`${origin}/sign-out`, {
			method: "POST",
			headers: { Cookie: sessionCookie, Origin: origin },
			redirect: "manual",
		});
		expect(logout.status).toBe(303);
		const expired = await SELF.fetch(`${origin}/api/auth/get-session`, { headers: { Cookie: sessionCookie } });
		expect(await expired.json()).toBeNull();
	});
	it("rejects cross-origin sign-in", async () => {
		const response = await SELF.fetch(`${origin}/sign-in`, {
			method: "POST",
			headers: { Origin: "https://attacker.example" },
			redirect: "manual",
		});
		expect(response.status).toBe(403);
		expect(response.headers.get("location")).toBeNull();
	});
	it("returns installation authorization to state-bound sign-in without exchanging its code", async () => {
		const outbound = vi.spyOn(globalThis, "fetch");
		const before = await env.DB.prepare("SELECT count(*) AS count FROM user").first<{ count: number }>();
		const response = await SELF.fetch(`${origin}/api/auth/callback/github?code=install-code`, {
			redirect: "manual",
		});
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/sign-in?next=/projects");
		expect(outbound).not.toHaveBeenCalled();
		const users = await env.DB.prepare("SELECT count(*) AS count FROM user").first<{ count: number }>();
		expect(users?.count).toBe(before?.count);
	});
	it("returns a signed-in maintainer from installing the App straight to the project picker", async () => {
		const { session } = await oauth(identity("github"));
		const outbound = vi.spyOn(globalThis, "fetch");
		const response = await SELF.fetch(
			`${origin}/api/auth/callback/github?code=install-code&installation_id=5&setup_action=install`,
			{ headers: { Cookie: session! }, redirect: "manual" },
		);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/projects");
		expect(outbound).not.toHaveBeenCalled();
	});
	it("rejects OAuth callbacks without a valid state", async () => {
		const before = await env.DB.prepare("SELECT count(*) AS count FROM user").first<{ count: number }>();
		const response = await SELF.fetch(`${origin}/api/auth/callback/github?code=fake&state=fake`, {
			redirect: "manual",
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toContain("error=");
		const users = await env.DB.prepare("SELECT count(*) AS count FROM user").first<{ count: number }>();
		expect(users?.count).toBe(before?.count);
	});
});
