// Serve the real Worker on localhost with seeded data, a fake GitHub, and a
// local sign-in, for checking UI changes in a browser. It runs the bundle that
// `wrangler deploy --dry-run` writes (see the `seeded` package script) on
// Miniflare directly, since `wrangler dev`'s proxy hangs in some sandboxes.
// Storage is in memory, so every run starts from the same seed.
import { readFileSync, readdirSync } from "node:fs";
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
const { values } = parseArgs({ options: { port: { type: "string", default: "8787" } } });
const port = Number(values.port);
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

// GitHub's authorize page would leave localhost, so the entry Worker sends that
// redirect straight to the callback, which the fake GitHub completes as the
// seeded maintainer. Everything else, WebSockets included, passes through.
const entry = `export default {
	async fetch(request, env) {
		const response = await env.APP.fetch(request);
		const location = response.headers.get("Location");
		if (!location?.startsWith("https://github.com/login/oauth/authorize")) return response;
		const callback = new URL("/api/auth/callback/github", request.url);
		callback.searchParams.set("code", "fake");
		callback.searchParams.set("state", new URL(location).searchParams.get("state") ?? "");
		const headers = new Headers(response.headers);
		headers.set("Location", callback.href);
		return new Response(null, { status: response.status, headers });
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
	world: data,
	origin,
	secret,
});
const [login] = data.users.map((user) => user.login);
console.log(`
Seeded kix at ${origin}/inbox, signed in as ${login}. Ctrl-C stops it.
Sign in with GitHub completes locally. From a shell, send the session cookie:
  curl -H 'Cookie: ${cookie}' ${origin}/inbox
or sign in with a cookie jar:
  curl -sL -c jar -b jar -H 'Origin: ${origin}' -d provider=github ${origin}/sign-in
`);
