// Serve the real Worker on localhost with seeded data, a fake GitHub, and a
// local sign-in, for checking UI changes in a browser. It runs the bundle that
// `wrangler deploy --dry-run` writes (see the `seeded` package script) on
// Miniflare directly, since `wrangler dev`'s proxy hangs in some sandboxes.
// Storage is in memory, so every run starts from the same seed. With --check,
// it checks what only this server wires up, on a free port, and exits.
import { readFileSync, readdirSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	Miniflare,
	Response as MiniflareResponse,
	type V4WorkerOptionsShape,
	convertV4MiniflareOptions,
} from "miniflare";
import { unstable_getMiniflareWorkerOptions, unstable_splitSqlQuery } from "wrangler";
import { privateKey } from "../test/github-key";
import { fakeGitHub } from "./github";
import { seed, world } from "./seed";

const root = join(import.meta.dirname, "..");
const { values } = parseArgs({
	options: { port: { type: "string", default: "8787" }, check: { type: "boolean", default: false } },
});

/** A port nothing listens on, so checks run beside other seeded servers. */
async function freePort() {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

const port = values.check ? await freePort() : Number(values.port);
const prefix = `seeded-${port}.`;
const origin = `http://localhost:${port}`;
const secret = "dev-webhook-secret";
const data = world();
const github = fakeGitHub(data);

// Bindings, assets, and Durable Objects come from the deploy config. Wrangler
// types these with its own copy of Miniflare's types; the version is the same.
const { workerOptions } = unstable_getMiniflareWorkerOptions(join(root, "wrangler.jsonc")) as unknown as {
	workerOptions: V4WorkerOptionsShape & { modulesRules?: unknown };
};
// The bundle is a single ES module, and Miniflare 5 cannot convert module rules.
const { modulesRules: _, ...app } = workerOptions;

// Browsers share localhost's cookies across ports, so seeded servers on two
// ports would sign each other out. The entry Worker gives this server's cookies
// their own names: it prefixes each cookie the app sets with COOKIES, and
// passes the app only the cookies so prefixed, without it.
//
// GitHub's authorize page would leave localhost, so the entry Worker also sends
// that redirect straight to the callback, which the fake GitHub completes as
// the seeded maintainer. Everything else, WebSockets included, passes through.
const entry = `export default {
	async fetch(request, env) {
		const sent = (request.headers.get("Cookie") ?? "")
			.split(/;\\s*/)
			.filter((cookie) => cookie.startsWith(env.COOKIES))
			.map((cookie) => cookie.slice(env.COOKIES.length));
		const forwarded = new Headers(request.headers);
		if (sent.length) forwarded.set("Cookie", sent.join("; "));
		else forwarded.delete("Cookie");
		const response = await env.APP.fetch(new Request(request, { headers: forwarded }));

		const cookies = response.headers.getSetCookie();
		const location = response.headers.get("Location");
		const authorize = location?.startsWith("https://github.com/login/oauth/authorize");
		if (!cookies.length && !authorize) return response;
		const headers = new Headers(response.headers);
		headers.delete("Set-Cookie");
		for (const cookie of cookies) headers.append("Set-Cookie", env.COOKIES + cookie);
		if (authorize) {
			const callback = new URL("/api/auth/callback/github", request.url);
			callback.searchParams.set("code", "fake");
			callback.searchParams.set("state", new URL(location).searchParams.get("state") ?? "");
			headers.set("Location", callback.href);
		}
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
			webSocket: response.webSocket,
		});
	},
};`;

const mf = new Miniflare(
	convertV4MiniflareOptions({
		host: "127.0.0.1",
		port,
		workers: [
			{
				name: "entry",
				modules: true,
				script: entry,
				compatibilityDate: app.compatibilityDate,
				bindings: { COOKIES: prefix },
				serviceBindings: { APP: "app" },
			},
			{
				...app,
				name: "app",
				modules: true,
				scriptPath: join(root, ".wrangler/seeded/index.js"),
				// Local values only: never a credential from .dev.vars, and no Google sign-in.
				bindings: {
					...app.bindings,
					AUTH_URL: origin,
					AUTH_SECRET: "dev-only-secret-that-is-at-least-32-characters",
					GITHUB_CLIENT_ID: "dev-client-id",
					GITHUB_CLIENT_SECRET: "dev-client-secret",
					GITHUB_APP_ID: String(data.app.id),
					GITHUB_APP_PRIVATE_KEY: privateKey,
					GITHUB_WEBHOOK_SECRET: secret,
					GOOGLE_CLIENT_ID: "",
					GOOGLE_CLIENT_SECRET: "",
					// Notifications stay off: a push would leave localhost for a real push service.
					VAPID_PUBLIC_KEY: "",
					VAPID_PRIVATE_KEY: "",
				},
				// Every outbound request goes to the fake; nothing reaches the network.
				outboundService: async (request) => {
					const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.text();
					const response = await github(request.url, {
						method: request.method,
						headers: [...request.headers],
						body,
					});
					return new MiniflareResponse(await response.arrayBuffer(), {
						status: response.status,
						headers: [...response.headers],
					});
				},
			},
		],
	}),
);
const stop = async () => {
	await mf.dispose();
	process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await mf.ready;

// Apply the checked-in migrations in order, as `wrangler d1 migrations apply` does.
const db = (await mf.getD1Database("DB", "app")) as unknown as D1Database;
const migrations = join(root, "migrations");
for (const file of readdirSync(migrations)
	.filter((f) => f.endsWith(".sql"))
	.sort()) {
	const statements = unstable_splitSqlQuery(readFileSync(join(migrations, file), "utf8"));
	await db.batch(statements.map((sql) => db.prepare(sql)));
}

const { cookie } = await seed({
	fetch: (path, init) => mf.dispatchFetch(`${origin}${path}`, init as never) as unknown as Promise<Response>,
	db,
	output: (await mf.getR2Bucket("OUTPUT", "app")) as unknown as R2Bucket,
	world: data,
	origin,
	secret,
});

if (values.check) {
	// Over the listening socket, as a browser would reach it.
	const problems: string[] = [];
	const css = await fetch(`${origin}/site.css`);
	if (!css.ok || !css.headers.get("Content-Type")?.startsWith("text/css"))
		problems.push(`/site.css returned ${css.status} ${css.headers.get("Content-Type")}, not the built stylesheet`);
	if (!cookie.startsWith(prefix)) problems.push(`the session cookie is not named after the port: ${cookie}`);
	const inbox = async (sent: string) =>
		(await fetch(`${origin}/inbox`, { headers: { Cookie: sent }, redirect: "manual" })).status;
	const own = await inbox(cookie);
	if (own !== 200) problems.push(`/inbox returned ${own} with the session cookie`);
	// Another server's cookie, as a browser sends every localhost port's, is not this server's session.
	const foreign = await inbox(cookie.slice(prefix.length));
	if (foreign === 200) problems.push("/inbox accepted the session under another server's cookie name");
	await mf.dispose();
	for (const problem of problems) console.error(`Seeded server check failed: ${problem}`);
	process.exit(problems.length ? 1 : 0);
}

const [login] = data.users.map((user) => user.login);
console.log(`
Seeded kix at ${origin}/inbox, signed in as ${login}. Ctrl-C stops it.
Sign in with GitHub completes locally. From a shell, send the session cookie:
  curl -H 'Cookie: ${cookie}' ${origin}/inbox
or sign in with a cookie jar:
  curl -sL -c jar -b jar -H 'Origin: ${origin}' -d provider=github ${origin}/sign-in
`);
