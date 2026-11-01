import { type Context, Hono } from "hono";
import type { Child } from "hono/jsx";
import { secureHeaders } from "hono/secure-headers";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AccountPage, SignInPage } from "./account";
import { type Provider, createAuth, providers } from "./auth";
import { type Board, findDoc as findQuest, readBoard } from "./board/model";
import { BoardPage, QuestPage, SHOWN, questCrumbs } from "./board/pages";
import { type Project, findProject, home } from "./board/project";
import { DocIndex, DocPage, findDoc } from "./docs";
import { Home } from "./home";
import { type Enrollment, GitHubError, GitHubService } from "./github/service";
import { readActivity } from "./github/state";
import { ProjectsPage, ProjectSetupPage, ProjectStopControls, ProjectStatePage, projectURL } from "./projects";
import { githubWebhooks } from "./github/webhook";
import { activeHighlights, cards, highlights } from "./inbox/activity";
import * as inbox from "./inbox/model";
import { AgentCards, InboxPage } from "./inbox/page";
import { purge, retain } from "./jobs/output";
import { INBOX_HEADER } from "./jobs/hub";
import * as landing from "./jobs/landing";
import { BootstrapRequired, fromForm, hub, inboxURL, jobs, nextURL, resume, stop } from "./jobs/routes";
import { JobError, active, listActivityJobs, listRunners, moveAccount, registerRunner } from "./jobs/store";
import { Layout, type Page, type User } from "./layout";
import { RunnersPage, connectRequest } from "./runners";
import * as push from "./push/notify";

export const app = new Hono<{ Bindings: Env }>();
// Browsers send `Origin: null` on form posts under the default "no-referrer"
// policy, which would fail the origin check on /sign-in and /sign-out.
app.use(secureHeaders({ referrerPolicy: "same-origin" }));
app.route("/", githubWebhooks);
app.get("/health", (c) => c.json({ status: "ok" }));
// Short link for the one-line setup paste.
app.get("/setup", (c) => c.redirect("https://github.com/moq-dev/quest/blob/main/SETUP.md"));
// Installation-initiated authorization has no sign-in state from this site.
// Discard its code and let the visitor start a state-bound sign-in instead.
app.get("/api/auth/callback/github", (c, next) => {
	if (c.req.query("code") && !c.req.query("state")) return c.redirect("/sign-in?next=/projects", 303);
	return next();
});
app.all("/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));
app.route("/", push.subscriptions);

// The page a visitor is on, still percent-encoded, to return to after signing in.
function here(c: Context): string {
	const url = new URL(c.req.url);
	return url.pathname + url.search;
}

// Every HTML page renders in the shared layout, with the visitor's session in the nav.
async function page(
	c: Context<{ Bindings: Env }>,
	props: Omit<Page, "origin" | "path" | "user" | "unread">,
	body: Child | ((user: User | null) => Child),
	status: ContentfulStatusCode = 200,
) {
	const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
	const user = session?.user ?? null;
	const unread = user ? await inbox.unread(c.env, user.id) : 0;
	c.header("Cache-Control", "no-store");
	return c.html(
		<Layout {...props} origin={new URL(c.env.AUTH_URL).origin} path={here(c)} user={user} unread={unread}>
			{typeof body === "function" ? body(user) : body}
		</Layout>,
		status,
	);
}

// A project's board: its milestones, epics, and quests with their statuses.
const boards = new WeakMap<Project, Board>();
function board(name: string): Board | null {
	const project = findProject(name);
	if (!project) return null;
	if (!boards.has(project)) boards.set(project, readBoard(project));
	return boards.get(project)!;
}

// The home page maps the site's own project.
app.get("/", (c) =>
	page(
		c,
		{ description: "Readable plans, explicit dependencies, and reviewable Git changes, for you and your agents." },
		<Home setup={new URL("/setup", c.env.AUTH_URL).href} board={board(home.name)!} />,
	),
);
app.get("/docs", (c) => page(c, { title: "Docs", description: "How to use Quest in your repository." }, <DocIndex />));
app.get("/docs/:slug", (c) => {
	const doc = findDoc(c.req.param("slug"));
	if (!doc) return c.notFound();
	return page(c, { title: doc.title, description: doc.summary }, <DocPage doc={doc} />);
});

// Setup stays separate from the quest board and future decision inbox.
app.use("/projects/*", async (c, next) => {
	if (c.req.method === "POST" && c.req.header("Origin") !== new URL(c.env.AUTH_URL).origin)
		return c.json({ error: "Invalid origin" }, 403);
	await next();
});
app.route("/", jobs);
app.get("/projects", async (c) => {
	const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
	if (!session) return c.redirect("/sign-in?next=/projects", 303);
	const github = new GitHubService(c.env);
	let installation: string | null = null;
	try {
		installation = await github.installationURL();
	} catch (error) {
		if (!(error instanceof GitHubError)) throw error;
	}
	return page(
		c,
		{ title: "Project setup", description: "Opt your Quest repository into contributions." },
		<ProjectsPage
			projects={await github.projects(session.user.id)}
			installation={installation}
			error={c.req.query("error") ? "Use a GitHub owner/repository name." : undefined}
		/>,
	);
});
app.get("/projects/select", (c) => {
	const selected = c.req.query("repository")?.trim();
	const match = selected?.match(/^([a-zA-Z0-9][a-zA-Z0-9_.-]{0,99})\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,99})$/);
	return c.redirect(match ? projectURL(match[1], match[2]) : "/projects?error=repository", 303);
});
app.get("/projects/github/:owner/:repository", async (c) => {
	const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
	if (!session) return c.redirect(`/sign-in?next=${encodeURIComponent(here(c))}`, 303);
	const github = new GitHubService(c.env);
	let enrolled: Enrollment | null = null;
	try {
		enrolled = await github.enrolledProject(c.req.param("owner"), c.req.param("repository"), session.user.id);
		const repository =
			enrolled ?? (await github.resolveRepository(c.req.param("owner"), c.req.param("repository")));
		const preview = await github.previewProject(repository, session.user.id);
		return page(
			c,
			{
				title: `${repository.owner}/${repository.name} setup`,
				description: "Review ready quests and contribution settings.",
			},
			<ProjectSetupPage preview={preview} enrollment={enrolled} />,
		);
	} catch (error) {
		if (!(error instanceof GitHubError)) throw error;
		return page(
			c,
			{ title: "Project unavailable", description: "Check repository access and Quest setup." },
			<section class="wrap docs">
				<h1>Project unavailable</h1>
				<p role="alert">{error.message}</p>
				{enrolled && (
					<>
						<p>You can still pause contributions or disconnect this enrolled project.</p>
						<ProjectStopControls project={enrolled} />
					</>
				)}
				<p>
					<a href="/projects">Return to project setup</a> or <a href="/setup">set up Quest</a>.
				</p>
			</section>,
			403,
		);
	}
});
app.post("/projects/github/:owner/:repository", async (c) => {
	const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
	if (!session) return c.json({ error: "Sign in required" }, 401);
	const { id, state } = await c.req.parseBody();
	if (
		typeof id !== "string" ||
		!/^[1-9]\d*$/.test(id) ||
		(state !== "enabled" && state !== "paused" && state !== "disconnected")
	)
		return c.json({ error: "Invalid project choice" }, 400);
	try {
		const stopped = await new GitHubService(c.env).setContributions(
			{ id: Number(id), owner: c.req.param("owner"), name: c.req.param("repository") },
			session.user.id,
			state,
		);
		if (state === "enabled") await resume(c.env, Number(id));
		await stop(c.env, stopped);
		if (state === "disconnected") await purge(c.env);
		return c.redirect(
			state === "disconnected" ? "/projects" : projectURL(c.req.param("owner"), c.req.param("repository")),
			303,
		);
	} catch (error) {
		if (!(error instanceof GitHubError)) throw error;
		return page(
			c,
			{ title: "Project unchanged", description: "The contribution setting could not be changed." },
			<section class="wrap docs">
				<h1>Project unchanged</h1>
				<p role="alert">{error.message}</p>
				<p>
					<a href="/projects">Return to project setup</a>.
				</p>
			</section>,
			403,
		);
	}
});

// Live enrolled-project observations use the same board model as the bundled
// repository, but every read rechecks current GitHub maintainer authority.
async function liveProject(c: Context<{ Bindings: Env }>, refresh = false) {
	const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
	if (!session) throw new GitHubError("Sign in required");
	const github = new GitHubService(c.env);
	const repo = await github.enrolledProject(c.req.param("owner")!, c.req.param("repository")!, session.user.id);
	if (!repo) throw new GitHubError("Project is not enrolled");
	return { repo, state: await github.projectState(repo, session.user.id, refresh) };
}
app.get("/projects/github/:owner/:repository/state", async (c) => {
	const { repo, state } = await liveProject(c);
	// The activity log is the one view of closed entities, so it pages.
	const log = await readActivity(c.env.DB, repo.id, c.req.query("before") ?? null);
	return page(
		c,
		{ title: "Project activity", description: "Observed GitHub project state." },
		<ProjectStatePage
			owner={c.req.param("owner")}
			repository={c.req.param("repository")}
			state={state}
			log={log}
		/>,
	);
});
app.get("/projects/github/:owner/:repository/data", async (c) => {
	c.header("Cache-Control", "no-store");
	return c.json((await liveProject(c)).state);
});
app.post("/projects/github/:owner/:repository/refresh", async (c) => {
	await liveProject(c, true);
	if ((await c.req.parseBody()).next === "inbox") return c.redirect("/inbox", 303);
	return c.redirect(`${projectURL(c.req.param("owner"), c.req.param("repository"))}/state`, 303);
});
// Skipping is the maintainer's own triage, never a decision on the project.
app.post("/projects/github/:owner/:repository/skip", async (c) => {
	const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
	if (!session) throw new GitHubError("Sign in required");
	const repo = await new GitHubService(c.env).enrolledProject(
		c.req.param("owner"),
		c.req.param("repository"),
		session.user.id,
	);
	if (!repo) throw new GitHubError("Project is not enrolled");
	const { item, version } = await c.req.parseBody();
	if (typeof item !== "string" || typeof version !== "string" || item.length > 300 || version.length > 100)
		return c.json({ error: "Item and version required" }, 400);
	await inbox.skip(c.env.DB, session.user.id, repo.id, item, version);
	return c.redirect(nextURL("skip"), 303);
});
// A merge is the maintainer's own click on the head they saw; it lands once a review counts on that head and GitHub's rules allow it.
app.post("/projects/github/:owner/:repository/pulls/:number/merge", async (c) => {
	const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
	if (!session) throw new GitHubError("Sign in required");
	const github = new GitHubService(c.env);
	const repo = await github.enrolledProject(c.req.param("owner"), c.req.param("repository"), session.user.id);
	if (!repo) throw new GitHubError("Project is not enrolled");
	const number = c.req.param("number");
	const { head, version } = await c.req.parseBody();
	if (!/^[1-9]\d{0,14}$/.test(number) || typeof head !== "string")
		return c.json({ error: "Pull request and head required" }, 400);
	const target = `pulls/${number}`;
	// A job may still push to the pull request, so it never merges under one.
	if (await active(c.env.DB, repo.id, target)) throw new JobError("Stop this pull request's job before merging it");
	await github.mergePullRequest(repo, session.user.id, Number(number), head);
	// The merged item is finished for this maintainer until GitHub's next observation drops it.
	if (typeof version === "string" && version.length <= 100)
		await inbox.skip(c.env.DB, session.user.id, repo.id, target, version);
	return c.redirect(nextURL("merge"), 303);
});

// The browser may subscribe only to its signed-in user's notification hub, never as a runner.
app.get("/inbox/live", async (c) => {
	if (c.req.header("Origin") !== new URL(c.env.AUTH_URL).origin) return c.json({ error: "Invalid origin" }, 403);
	const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
	if (!session) return c.json({ error: "Sign in required" }, 401);
	if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "WebSocket required" }, 426);
	const response = await hub(c.env, session.user.id).fetch(
		new Request(c.req.url, {
			headers: { Upgrade: "websocket", [INBOX_HEADER]: session.user.id },
		}),
	);
	return new Response(null, {
		status: response.status,
		webSocket: response.webSocket,
		headers: new Headers(response.headers),
	});
});

// Every live fragment read repeats the same current-maintainer checks as the full inbox.
app.get("/inbox/agents", async (c) => {
	c.header("Cache-Control", "no-store");
	const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
	if (!session) return c.json({ error: "Sign in required" }, 401);
	const user = session.user.id;
	const { readable, items, activity, runners } = await inbox.load(c.env, user);
	const now = Date.now();
	return c.html(
		<AgentCards cards={cards(readable, activity, runners, items, now)} runners={runners} user={user} now={now} />,
	);
});

// The signed-in home: one decision at a time across the maintainer's projects.
app.get("/inbox", async (c) => {
	const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
	if (!session) return c.redirect("/sign-in?next=/inbox", 303);
	const user = session.user.id;
	const { projects, readable, items, activity, runners } = await inbox.load(c.env, user);
	const now = Date.now();
	const { decisions, working, skipped } = inbox.arrange(items);
	const project = c.req.query("project");
	const target = c.req.query("item");
	const chosen = target ? items.find((i) => String(i.project.id) === project && i.target === target) : undefined;
	const active = chosen ?? decisions[0] ?? null;
	// Seen once shown, before the nav and the app badge count what is new.
	if (active?.need) {
		await inbox.markSeen(c.env.DB, user, active);
		active.unread = false;
	}
	return page(
		c,
		{ title: "Decisions", description: "Your decision inbox: questions, issues, pull requests, and ready quests." },
		<InboxPage
			user={user}
			projects={projects}
			active={active}
			missing={!!target && !chosen}
			done={c.req.query("done")}
			decisions={decisions}
			working={working}
			skipped={skipped}
			runners={runners}
			cards={cards(readable, activity, runners, items, now)}
			now={now}
			notifications={push.keys(c.env)?.publicKey ?? null}
		/>,
	);
});
// The signed-in user's runners and accounts, and approval of a `quest runner login` link.
app.get("/runners", async (c) => {
	const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
	if (!session) return c.redirect(`/sign-in?${new URLSearchParams({ next: here(c) })}`, 303);
	const owner = session.user.id;
	const online = new Set(await hub(c.env, owner).online());
	return page(
		c,
		{ title: "Runners", description: "Your runners, their agent accounts, and the order jobs use them in." },
		<RunnersPage
			runners={await listRunners(c.env.DB, owner, online)}
			connect={connectRequest(c.req.query())}
			connected={c.req.query("connected")}
		/>,
	);
});
/** The signed-in user behind a runner form, which must come from this site. */
async function signedIn(c: Context<{ Bindings: Env }>) {
	if (c.req.header("Origin") !== new URL(c.env.AUTH_URL).origin) throw new GitHubError("Invalid origin");
	const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
	if (!session) throw new GitHubError("Sign in required");
	return session.user.id;
}
app.post("/runners/connect", async (c) => {
	const owner = await signedIn(c);
	const body = await c.req.parseBody();
	const request = connectRequest(
		Object.fromEntries(Object.entries(body).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : []))),
	);
	if (!request) throw new JobError("Name, platform, and key required");
	// Logins never declare VM builds; the job sandbox adds that.
	await registerRunner(c.env.DB, owner, request.name, request.platform, false, request.key, Date.now());
	return c.redirect(`/runners?${new URLSearchParams({ connected: request.name })}`, 303);
});
app.post("/runners/accounts", async (c) => {
	const owner = await signedIn(c);
	const { runner, account, move } = await c.req.parseBody();
	if (typeof runner !== "string" || typeof account !== "string" || (move !== "up" && move !== "down"))
		throw new JobError("Runner, account, and direction required");
	await moveAccount(c.env.DB, owner, runner, account, move);
	// A new order can route queued work that was waiting on another account.
	await hub(c.env, owner).dispatch(owner);
	return c.redirect("/runners", 303);
});
/** Active quest state and map highlights come from the inbox's authorized card data. */
async function readLiveBoard(env: Env, view: inbox.ProjectView) {
	const jobs = await listActivityJobs(env.DB, view.project.id, inbox.openPulls(view));
	const runners = await inbox.presence(
		env,
		jobs.map((job) => job.actor),
	);
	const list = cards([view], [jobs], runners, [], Date.now());
	return { board: readBoard(view.state!.project, activeHighlights(list)), agents: highlights(list) };
}

app.get("/projects/github/:owner/:repository/board", async (c) => {
	const { repo, state } = await liveProject(c);
	if (!state) return c.redirect(`${projectURL(c.req.param("owner"), c.req.param("repository"))}/state`, 303);
	const live = await readLiveBoard(c.env, { project: repo, state, error: null });
	return page(
		c,
		{ title: `${state.project.title} quest log`, description: "Pinned repository quest tree." },
		<BoardPage
			board={live.board}
			show={SHOWN.find(([kind]) => kind === c.req.query("show"))?.[0] ?? null}
			agents={live.agents}
		/>,
	);
});
app.get("/projects/github/:owner/:repository/board/quest/*", async (c) => {
	const { repo, state } = await liveProject(c);
	if (!state) return c.notFound();
	let segments: string[];
	try {
		segments = new URL(c.req.url).pathname.split("/").slice(6).map(decodeURIComponent);
	} catch {
		return c.notFound();
	}
	if (segments.some((segment) => segment.includes("/"))) return c.notFound();
	const { board } = await readLiveBoard(c.env, { project: repo, state, error: null });
	const doc = findQuest(board, segments.join("/"));
	if (!doc) return c.notFound();
	if (doc.path === "quest/README.md") return c.redirect(state.project.href!);
	const content = state.project.documents.find((d) => d.path === doc.path)!.content;
	return page(
		c,
		{
			title: doc.title?.text ?? doc.path,
			description: "A pinned repository quest.",
			crumbs: questCrumbs(board, doc),
		},
		(user) => <QuestPage board={board} doc={doc} content={content} user={user} path={here(c)} />,
	);
});

// The quest board: a project's milestones, then each quest's page at its path
// without `.md`, the way its branch is named.
app.get("/repos/:repository", (c) => {
	const found = board(c.req.param("repository"));
	if (!found) return c.notFound();
	const { project } = found;
	const show = SHOWN.find(([kind]) => kind === c.req.query("show"))?.[0] ?? null;
	return page(
		c,
		{
			title: `${project.title} quest log`,
			description: `What is available, in progress, and finished in ${project.title}.`,
		},
		<BoardPage board={found} show={show} />,
	);
});
app.get("/repos/:repository/quest/*", (c) => {
	const found = board(c.req.param("repository"));
	// Hono's routing path has already decoded some escapes. Start from the
	// original URL so a literal percent escape in a filename is decoded once.
	let segments: string[];
	try {
		segments = new URL(c.req.url).pathname.split("/").slice(3).map(decodeURIComponent);
	} catch {
		return c.notFound();
	}
	if (segments.some((segment) => segment.includes("/"))) return c.notFound();
	const doc = found && findQuest(found, segments.join("/"));
	if (!found || !doc) return c.notFound();
	const href = `/repos/${found.project.name}`;
	if (doc.path === "quest/README.md") return c.redirect(href);
	const content = found.project.documents.find((d) => d.path === doc.path)!.content;
	const crumbs = questCrumbs(found, doc);
	return page(
		c,
		{
			title: crumbs.at(-1)!.label,
			description: `A quest in ${found.project.title}.`,
			crumbs,
		},
		(user) => <QuestPage board={found} doc={doc} content={content} user={user} path={here(c)} />,
	);
});
app.get("/repos/:repository/quest", (c) => c.redirect(`/repos/${c.req.param("repository")}`));

app.notFound((c) =>
	page(
		c,
		{ title: "Not found", description: "This page is not on the map." },
		<section class="wrap lost">
			<h1>Uncharted territory</h1>
			<p>
				This page is not on the map. Head back <a href="/">home</a> or read <a href="/docs">the docs</a>.
			</p>
		</section>,
		404,
	),
);

/** The inbox item a refused form was posted from, or the inbox itself. */
function back(c: Context<{ Bindings: Env }>) {
	try {
		const from = new URL(c.req.header("Referer") ?? "");
		const project = from.searchParams.get("project");
		const item = from.searchParams.get("item");
		const here = from.origin === new URL(c.env.AUTH_URL).origin && from.pathname === "/inbox";
		if (here && /^\d{1,15}$/.test(project ?? "") && item)
			return { href: inboxURL(Number(project), item), label: "Return to the item" };
	} catch {}
	return { href: "/inbox", label: "Return to your decisions" };
}

// Any action can be refused, not only an answer, so the page names none.
function refused(c: Context<{ Bindings: Env }>, message: string, bootstrap: boolean, status: 403 | 409) {
	const to = back(c);
	return page(
		c,
		{ title: "Couldn't do that", description: "The request was refused." },
		<section class="wrap docs">
			<h1>Couldn't do that</h1>
			<p role="alert">{message}</p>
			{bootstrap && (
				<form method="post" action={c.req.path}>
					<input type="hidden" name="workflow" value="bootstrap" />
					<p>
						<button class="button primary">Start a bootstrap job</button>
					</p>
				</form>
			)}
			<p>
				<a href={to.href}>{to.label}</a>.
			</p>
		</section>,
		status,
	);
}

// The server API bypasses Better Auth's HTTP middleware. Guard form routes
// before calling it; the /api/auth/* handler enforces its own Origin/CSRF checks.
for (const path of ["/sign-in", "/sign-out", "/link", "/passkeys/delete"]) {
	app.use(path, async (c, next) => {
		if (c.req.method === "POST" && c.req.header("Origin") !== new URL(c.env.AUTH_URL).origin) {
			return c.json({ error: "Invalid origin" }, 403);
		}
		await next();
	});
}

/**
 * Whether `path` stays on this site. Calling the server API skips Better
 * Auth's own callback checks, so this mirrors them: browsers drop control
 * characters and read a backslash as a slash, and a decoded `%2F` or `%5C`
 * is one too, any of which can turn `/` into `//` and another origin.
 */
function local(path: string): boolean {
	return /^\/(?![/\\])[^\\\0-\x1f\x7f]*$/.test(path) && !/%(2f|5c)/i.test(path);
}

// A configured provider named by a form field.
function provider(c: Context<{ Bindings: Env }>, value: unknown): Provider | undefined {
	return providers(c.env).find((p) => p === value);
}

// Turn a Better Auth JSON response into a redirect, keeping its cookies.
function redirect(response: Response, location: string) {
	const headers = new Headers(response.headers);
	headers.delete("content-type");
	headers.delete("content-length");
	headers.set("Location", location);
	headers.set("Cache-Control", "no-store");
	return new Response(null, { status: 303, headers });
}

// Start an OAuth flow, either signing in or linking to the signed-in account.
async function oauth(response: Response) {
	if (!response.ok) return response;
	const result: { url?: string } = await response.json();
	if (!result.url) return Response.json({ error: "Sign in unavailable" }, { status: 502 });
	return redirect(response, result.url);
}

app.get("/sign-in", (c) => {
	const next = c.req.query("next");
	return page(
		c,
		{ title: "Sign in", description: "Sign in to Quest with GitHub, Google, or a passkey." },
		<SignInPage
			providers={providers(c.env)}
			next={next && local(next) ? next : "/inbox"}
			error={c.req.query("error")}
		/>,
	);
});
app.post("/sign-in", async (c) => {
	// Return to the page that signed in, if it names a path on this site.
	const body = await c.req.parseBody();
	const callbackURL = typeof body.next === "string" && local(body.next) ? body.next : "/inbox";
	const chosen = body.provider === undefined ? "github" : provider(c, body.provider);
	if (!chosen) return c.json({ error: "Sign-in method unavailable" }, 400);
	return oauth(
		await createAuth(c.env).api.signInSocial({
			body: { provider: chosen, callbackURL, errorCallbackURL: "/sign-in" },
			headers: c.req.raw.headers,
			asResponse: true,
		}),
	);
});
app.post("/sign-out", async (c) => {
	const auth = createAuth(c.env);
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	const response = await auth.api.signOut({
		headers: c.req.raw.headers,
		asResponse: true,
	});
	if (!response.ok) return response;
	// This device stops notifying once it signs out.
	if (session) await push.forget(c.env.DB, session.session.id);
	return redirect(response, "/");
});

// The signed-in account: its linked providers and passkeys.
app.get("/account", async (c) => {
	const auth = createAuth(c.env);
	const headers = c.req.raw.headers;
	const session = await auth.api.getSession({ headers });
	if (!session) return c.redirect("/sign-in?next=/account", 303);
	const [accounts, passkeys, devices] = await Promise.all([
		auth.api.listUserAccounts({ headers }),
		auth.api.listPasskeys({ headers }),
		push.count(c.env.DB, session.user.id),
	]);
	const linked = providers(c.env).filter((p) => accounts.some((account) => account.providerId === p));
	return page(c, { title: "Account", description: "Your Quest sign-in methods and passkeys." }, (user) => (
		<AccountPage
			name={user!.name}
			linked={linked}
			providers={providers(c.env)}
			passkeys={passkeys}
			notifications={push.keys(c.env)?.publicKey ?? null}
			devices={devices}
			error={c.req.query("error")}
		/>
	));
});
// Linking proves ownership of the other provider through its OAuth flow.
app.post("/link", async (c) => {
	const chosen = provider(c, (await c.req.parseBody()).provider);
	if (!chosen) return c.json({ error: "Sign-in method unavailable" }, 400);
	return oauth(
		await createAuth(c.env).api.linkSocialAccount({
			body: { provider: chosen, callbackURL: "/account", errorCallbackURL: "/account" },
			headers: c.req.raw.headers,
			asResponse: true,
		}),
	);
});
app.post("/passkeys/delete", async (c) => {
	const { id } = await c.req.parseBody();
	if (typeof id !== "string") return c.json({ error: "Passkey required" }, 400);
	const response = await createAuth(c.env).api.deletePasskey({
		body: { id },
		headers: c.req.raw.headers,
		asResponse: true,
	});
	if (!response.ok) return response;
	return redirect(response, "/account");
});
app.onError((error, c) => {
	const status = error instanceof GitHubError ? 403 : error instanceof JobError ? 409 : null;
	// A refused inbox form explains itself and leads back, rather than showing JSON.
	if (status && fromForm(c)) return refused(c, error.message, error instanceof BootstrapRequired, status);
	if (error instanceof BootstrapRequired) return c.json({ error: error.message, bootstrap: true }, 409);
	if (status) return c.json({ error: error.message }, status);
	console.error({ event: "request_failed", path: c.req.path, name: error.name });
	return c.json({ error: "Request failed" }, 500);
});
export default {
	fetch: app.fetch,
	async scheduled(controller, env) {
		await landing.sweep(env);
		if (controller.cron !== landing.SWEEP_CRON) await retain(env, Date.now());
	},
} satisfies ExportedHandler<Env>;
export { RunnerHub } from "./jobs/hub";
