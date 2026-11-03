// Enrolling a repository without Quest files: the App's setup pull request,
// the setting-up state, and enabling once it merges, against the fake GitHub.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOOK_COMMAND, REFERENCE_LINE } from "quest/core";
import { app } from "../src/index";
import { STUBS, setupGoal, treeCheckout } from "../src/github/setup";
import { type Pull, type Repo, type World, fakeGitHub, intercept } from "../dev/github";
import { privateKey } from "./github-key";
import { delivery } from "./project-fixtures";
import { identity, oauth, origin } from "./login-fixtures";

const testEnv = { ...env, GITHUB_APP_PRIVATE_KEY: privateKey };
const db = env.DB;
const route = `${origin}/projects/github/upstream/project`;

let session: string;
let user: string;
let project: Repo;
let world: World;
let github: typeof fetch;

beforeEach(async () => {
	const who = identity("github");
	session = (await oauth(who)).session!;
	user = (await db
		.prepare("SELECT userId FROM account WHERE providerId='github' AND accountId=?")
		.bind(who.id)
		.first<{ userId: string }>())!.userId;
	const login = `person${who.id}`;
	world = {
		app: { id: Number(env.GITHUB_APP_ID), slug: "quest-test" },
		installation: 5,
		users: [{ id: Number(who.id), login, name: "Maintainer", email: who.email }],
		repos: [
			{
				owner: "upstream",
				name: "project",
				id: 10,
				maintainers: [login],
				files: [{ path: "AGENTS.md", content: "# Agents\n\nRun the tests.\n" }],
				issues: [],
				pulls: [],
				branches: {},
				commits: {},
				trees: {},
			},
		],
	};
	project = world.repos[0]!;
	github = fakeGitHub(world);
	vi.spyOn(globalThis, "fetch").mockImplementation(github);
});
afterEach(() => vi.restoreAllMocks());

const post = (path: string, body: Record<string, string>) =>
	app.request(
		`${route}${path}`,
		{ method: "POST", headers: { Cookie: session, Origin: origin }, body: new URLSearchParams(body) },
		testEnv,
	);
const view = () => app.request(route, { headers: { Cookie: session } }, testEnv);
const setup = () => db.prepare("SELECT * FROM github_project_setups WHERE id=10").first<Record<string, unknown>>();
const enrolled = () => db.prepare("SELECT state,enrolledBy FROM github_projects WHERE id=10").first();
const opened = () => project.pulls.filter((pull) => pull.author === "quest-test[bot]");

/** The files on the setup branch's commit, read back through the fake's API. */
async function published(): Promise<Map<string, string | null>> {
	const head = project.branches["kix/setup"]!;
	const commit = project.commits[head]!;
	const entries = project.trees[commit.tree]!.entries as { path: string; content?: string; sha?: string | null }[];
	return new Map(entries.map((entry) => [entry.path, entry.sha === null ? null : (entry.content ?? "")]));
}

/** Merge the setup pull request the way GitHub would: its files land on the default branch. */
async function merge(pull: Pull) {
	for (const [path, content] of await published()) {
		project.files = project.files.filter((file) => file.path !== path);
		if (content !== null) project.files.push({ path, content });
	}
	pull.closed = pull.merged = true;
	return delivery("pull_request", {
		action: "closed",
		installation: { id: 5 },
		repository: { id: 10, name: "project", owner: { login: "upstream" }, default_branch: "main" },
		pull_request: { id: 9001, number: pull.number, merged: true },
	});
}

describe("the setup pull request", () => {
	it("opens on a repository without Quest files, and enabling waits for it to merge", async () => {
		const form = await view();
		expect(form.status).toBe(200);
		const html = await form.text();
		expect(html).toContain("Set up Quest");
		expect(html).toContain('name="goal"');

		const response = await post("/setup", { id: "10", goal: "Ship a fast parser.\n# Not a heading" });
		expect(response.status).toBe(303);
		const [pull] = opened();
		expect(pull).toMatchObject({ branch: "kix/setup", title: "Set up Quest", draft: false });
		expect(pull!.body).toContain("## Left out");
		expect(pull!.body).toContain("Pinning `quest`");
		expect(pull!.body).toContain("bootstrap job");

		const files = await published();
		for (const skill of STUBS) {
			expect(files.get(`.claude/skills/${skill.installed}/SKILL.md`)).toBe(skill.stub);
			expect(files.get(`.agents/skills/${skill.installed}/SKILL.md`)).toBe(skill.stub);
		}
		expect(files.get("quest/README.md")).toBe("# Quests\n\n## Goal\n\nShip a fast parser.\n\\# Not a heading\n");
		expect(files.get("AGENTS.md")).toBe(`# Agents\n\nRun the tests.\n\n${REFERENCE_LINE}\n`);
		expect(files.get(".gitattributes")).toBe("quest/** merge=quest\n");
		expect(files.get(".claude/settings.json")).toContain(HOOK_COMMAND);

		expect(await setup()).toMatchObject({ state: "open", pull: pull!.number, enrolledBy: user, pending: null });
		expect(await enrolled()).toBeNull();
		const page = await (await view()).text();
		expect(page).toContain("Setting up");
		expect(page).toContain(`/pull/${pull!.number}`);
		// Submitting again leaves the open pull request as it is.
		expect((await post("/setup", { id: "10" })).status).toBe(303);
		expect(opened()).toHaveLength(1);

		expect((await merge(pull!)).status).toBe(202);
		expect(await enrolled()).toEqual({ state: "enabled", enrolledBy: user });
		expect(await setup()).toBeNull();
		expect(await db.prepare("SELECT user FROM github_project_members WHERE repository=10").first()).toEqual({
			user,
		});
		expect(await (await view()).text()).toContain("Contributions enabled");
	});

	it("names the path init refuses, and writes nothing", async () => {
		project.files.push({ path: ".claude/skills/quest-start/SKILL.md", content: "# My own start\n" });
		const response = await post("/setup", { id: "10" });
		expect(response.status).toBe(403);
		expect(await response.text()).toContain(".claude/skills/quest-start/SKILL.md is not a Quest stub");
		expect(project.branches["kix/setup"]).toBeUndefined();
		expect(opened()).toEqual([]);
		expect(await setup()).toBeNull();
	});

	it("leaves a branch it did not write alone", async () => {
		const main = Object.keys(project.commits)[0]!;
		project.branches["kix/setup"] = main;
		const response = await post("/setup", { id: "10" });
		expect(response.status).toBe(403);
		expect(await response.text()).toContain("already exists with commits the App did not write");
		expect(project.branches["kix/setup"]).toBe(main);
		expect(opened()).toEqual([]);
	});

	it("offers a retry or a disconnect once the pull request closes", async () => {
		await post("/setup", { id: "10" });
		const [first] = opened();
		const firstHead = project.branches["kix/setup"];
		first!.closed = true;
		const closed = await delivery("pull_request", {
			action: "closed",
			installation: { id: 5 },
			repository: { id: 10, name: "project", owner: { login: "upstream" }, default_branch: "main" },
			pull_request: { id: 9001, number: first!.number, merged: false },
		});
		expect(closed.status).toBe(202);
		expect(await setup()).toMatchObject({ state: "closed", pull: first!.number });
		const html = await (await view()).text();
		expect(html).toContain("was closed without merging");
		expect(html).toContain('name="state" value="disconnected"');
		expect(await enrolled()).toBeNull();

		// A retry replaces kix's own branch and opens a new pull request from it.
		expect((await post("/setup", { id: "10", goal: "Second try" })).status).toBe(303);
		const second = opened().find((pull) => !pull.closed)!;
		expect(second.number).not.toBe(first!.number);
		expect(project.branches["kix/setup"]).not.toBe(firstHead);
		expect((await published()).get("quest/README.md")).toContain("Second try");
		expect(await setup()).toMatchObject({ state: "open", pull: second.number });

		expect((await post("", { id: "10", state: "disconnected" })).status).toBe(303);
		expect(await setup()).toBeNull();
		// The pull request stays for the maintainer to close.
		expect(second.closed).toBeFalsy();
	});

	it("refuses a retry when someone pushes to the branch while it is written", async () => {
		await post("/setup", { id: "10" });
		const [first] = opened();
		first!.closed = true;
		const earlier = project.branches["kix/setup"]!;
		// A maintainer's push lands after the ownership check, while the new commit is created.
		const theirs = "f".repeat(40);
		project.commits[theirs] = { parents: [earlier], tree: project.commits[earlier]!.tree, message: "mine" };
		vi.mocked(globalThis.fetch).mockImplementation(
			intercept(
				github,
				(url, method) => method === "POST" && url.pathname.endsWith("/git/commits"),
				async (next) => {
					const response = await next();
					project.branches["kix/setup"] = theirs;
					return response;
				},
			),
		);
		const response = await post("/setup", { id: "10" });
		expect(response.status).toBe(403);
		expect(await response.text()).toContain("changed while the setup was being written");
		expect(project.branches["kix/setup"]).toBe(theirs);
		expect(opened().filter((pull) => !pull.closed)).toEqual([]);
	});

	it("enables from the page when the merge webhook was missed", async () => {
		await post("/setup", { id: "10" });
		const [pull] = opened();
		for (const [path, content] of await published()) if (content !== null) project.files.push({ path, content });
		pull!.closed = pull!.merged = true;
		const response = await view();
		expect(response.status).toBe(303);
		expect(await enrolled()).toMatchObject({ state: "enabled" });
	});

	it("lists a project setting up on the picker", async () => {
		await post("/setup", { id: "10" });
		const html = await (await app.request(`${origin}/projects`, { headers: { Cookie: session } }, testEnv)).text();
		expect(html).toContain("Setting up");
	});
});

describe("the setup plan on GitHub", () => {
	it("refuses to follow a symlink", () => {
		const checkout = treeCheckout(
			[{ path: ".claude", type: "blob", mode: "120000", sha: "a".repeat(40) }],
			new Map(),
		);
		expect(() => checkout.stat(".claude/skills")).toThrow(".claude is a symbolic link");
	});

	it("keeps a goal inside the Goal section", () => {
		expect(setupGoal("  One\r\n## Required\n   ### Deep\n")).toBe("One\n\\## Required\n   \\### Deep");
		expect(setupGoal("Ship a parser\n---\nThen more\n===  ")).toBe("Ship a parser\n\\---\nThen more\n\\===");
		expect(setupGoal("- a list item\n-- not a rule")).toBe("- a list item\n-- not a rule");
	});
});
