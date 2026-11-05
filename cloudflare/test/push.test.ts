import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repo } from "../dev/github";
import { app } from "../src/index";
import * as store from "../src/jobs/store";
import * as push from "../src/push/notify";
import { base64url, encrypt, unbase64url, vapid } from "../src/push/webpush";
import { privateKey } from "./github-key";
import { identity, oauth, origin } from "./login-fixtures";
import { commit, delivery, maintainerOf } from "./project-fixtures";

const testEnv = { ...env, GITHUB_APP_PRIVATE_KEY: privateKey };
const db = env.DB;
const keys = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };

describe("Web Push encryption and signing", () => {
	it("matches RFC 8291's worked example", async () => {
		const body = await encrypt(
			{
				endpoint: "https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV",
				p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
				auth: "BTBZMqHH6r4Tts7J_aSIgg",
			},
			new TextEncoder().encode("When I grow up, I want to be a watermelon"),
			{
				sender: {
					publicKey:
						"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
					privateKey: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
				},
				salt: unbase64url("DGv6ra1nlYgDCS1FRnbzlw"),
			},
		);
		expect(base64url(body)).toBe(
			"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
		);
	});

	it("signs a VAPID token the push service can verify", async () => {
		const header = await vapid("https://fcm.googleapis.com/fcm/send/abc", keys, "https://kix.quest", 1_000_000);
		const [, token, key] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
		expect(key).toBe(keys.publicKey);
		const [head, claims, signature] = token!.split(".");
		expect(JSON.parse(new TextDecoder().decode(unbase64url(claims!)))).toEqual({
			aud: "https://fcm.googleapis.com",
			exp: 1000 + 12 * 3600,
			sub: "https://kix.quest",
		});
		const verifier = await crypto.subtle.importKey(
			"raw",
			unbase64url(keys.publicKey),
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
		const valid = await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			verifier,
			unbase64url(signature!),
			new TextEncoder().encode(`${head}.${claims}`),
		);
		expect(valid).toBe(true);
	});
});

/** A browser's side of a push subscription, which can read what the Worker sends it. */
async function browser(endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`) {
	const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
		"deriveBits",
	])) as CryptoKeyPair;
	const p256dh = base64url(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer));
	const auth = crypto.getRandomValues(new Uint8Array(16));
	const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: string | Uint8Array, bytes: number) => {
		const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
		const data = typeof info === "string" ? new TextEncoder().encode(info) : info;
		return new Uint8Array(
			await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: data }, key, bytes * 8),
		);
	};
	return {
		endpoint,
		json: { endpoint, keys: { p256dh, auth: base64url(auth) } },
		/** Decrypt an aes128gcm body as the browser would. */
		async read(body: Uint8Array) {
			const salt = body.slice(0, 16);
			const sender = body.slice(21, 21 + body[20]!);
			const peer = await crypto.subtle.importKey("raw", sender, { name: "ECDH", namedCurve: "P-256" }, false, []);
			const shared = new Uint8Array(
				await crypto.subtle.deriveBits(
					{ name: "ECDH", public: peer } as SubtleCryptoDeriveKeyAlgorithm,
					pair.privateKey,
					256,
				),
			);
			const info = new Uint8Array([
				...new TextEncoder().encode("WebPush: info\0"),
				...unbase64url(p256dh),
				...sender,
			]);
			const ikm = await hkdf(auth, shared, info, 32);
			const cek = await crypto.subtle.importKey(
				"raw",
				await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16),
				"AES-GCM",
				false,
				["decrypt"],
			);
			const iv = await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12);
			const plain = new Uint8Array(
				await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cek, body.slice(21 + body[20]!)),
			);
			expect(plain.at(-1)).toBe(2);
			return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
		},
	};
}

type Sent = { endpoint: string; headers: Headers; body: Uint8Array };

describe("decision notifications", () => {
	let user = "";
	let cookie = "";
	let sent: Sent[] = [];
	let status = 201;
	let login = "";
	let repo: Repo;
	let signIn: Awaited<ReturnType<typeof maintainerOf>>["other"];

	beforeEach(async () => {
		const maintainer = await maintainerOf();
		const { github } = maintainer;
		({ user, cookie, login, repo, other: signIn } = maintainer);
		sent = [];
		status = 201;
		// Push services answer here; everything else goes to the fake GitHub.
		vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
			const url = String(input instanceof Request ? input.url : input);
			if (!url.startsWith("https://fcm.googleapis.com/")) return github(input, init);
			sent.push({
				endpoint: url,
				headers: new Headers(init?.headers),
				body: new Uint8Array(await new Response(init?.body).arrayBuffer()),
			});
			return new Response(null, { status });
		});
	});
	afterEach(() => vi.restoreAllMocks());

	function post(path: string, body: unknown, headers: Record<string, string> = { Cookie: cookie, Origin: origin }) {
		return app.request(
			`${origin}${path}`,
			{ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) },
			testEnv,
		);
	}
	async function subscribe() {
		const device = await browser();
		expect((await post("/push/subscribe", device.json)).status).toBe(204);
		return device;
	}
	const subscriptions = async () =>
		(await db.prepare("SELECT endpoint,user FROM push_subscriptions").all<{ endpoint: string; user: string }>())
			.results;

	it("stores a signed-in device's subscription only from this site and a known push service", async () => {
		const device = await browser();
		expect((await post("/push/subscribe", device.json, { Origin: origin })).status).toBe(401);
		expect(
			(await post("/push/subscribe", device.json, { Cookie: cookie, Origin: "https://evil.test" })).status,
		).toBe(403);
		const elsewhere = { ...device.json, endpoint: "https://evil.test/push" };
		expect((await post("/push/subscribe", elsewhere)).status).toBe(400);
		const short = { ...device.json, keys: { ...device.json.keys, auth: "AAAA" } };
		expect((await post("/push/subscribe", short)).status).toBe(400);
		expect((await post("/push/subscribe", device.json)).status).toBe(204);
		expect(await subscriptions()).toEqual([{ endpoint: device.endpoint, user }]);
		// A rotated subscription replaces the one it names.
		const rotated = await browser();
		expect((await post("/push/subscribe", { ...rotated.json, replaces: device.endpoint })).status).toBe(204);
		expect(await subscriptions()).toEqual([{ endpoint: rotated.endpoint, user }]);
		// A rotation while someone else is signed in does not opt them in.
		const other = (await oauth(identity("github"))).session!;
		const again = await browser();
		const theirs = { ...again.json, replaces: rotated.endpoint };
		expect((await post("/push/subscribe", theirs, { Cookie: other, Origin: origin })).status).toBe(403);
		const unknown = { ...again.json, replaces: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}` };
		expect((await post("/push/subscribe", unknown)).status).toBe(403);
		expect(await subscriptions()).toEqual([{ endpoint: rotated.endpoint, user }]);
		expect((await post("/push/unsubscribe", { endpoint: rotated.endpoint })).status).toBe(204);
		expect(await subscriptions()).toEqual([]);
	});

	it("stops notifying a device once it signs out", async () => {
		await subscribe();
		const account = await (await app.request(`${origin}/account`, { headers: { Cookie: cookie } }, testEnv)).text();
		expect(account).toContain("1 device is notified.");
		expect(account).toContain(`data-push="${env.VAPID_PUBLIC_KEY}"`);
		const out = await app.request(
			`${origin}/sign-out`,
			{ method: "POST", headers: { Cookie: cookie, Origin: origin } },
			testEnv,
		);
		expect(out.status).toBe(303);
		expect(await subscriptions()).toEqual([]);
	});

	it("shows a device as notified only while its subscription is stored for the signed-in user", async () => {
		const device = await subscribe();
		const check = async (headers?: Record<string, string>) =>
			(await post("/push/check", { endpoint: device.endpoint }, headers)).json();
		// A session that expired leaves its device notifying; a check moves it to the
		// current session, so signing out here forgets it.
		await db.prepare("UPDATE push_subscriptions SET session='expired'").run();
		expect(await check()).toEqual({ stored: true });
		// Another person signing in on this browser does not take the device over.
		const other = (await oauth(identity("github"))).session!;
		expect(await check({ Cookie: other, Origin: origin })).toEqual({ stored: false });
		expect(await subscriptions()).toEqual([{ endpoint: device.endpoint, user }]);
		await app.request(
			`${origin}/sign-out`,
			{ method: "POST", headers: { Cookie: cookie, Origin: origin } },
			testEnv,
		);
		expect(await subscriptions()).toEqual([]);
	});

	it("does not push to someone who no longer maintains the project", async () => {
		await subscribe();
		repo.roles![login] = "write";
		await delivery("issues", {
			action: "opened",
			installation: { id: 5 },
			repository: { id: 10 },
			issue: { id: 13, number: 3, title: "Crash on start" },
		});
		expect(sent).toHaveLength(0);
		expect(await subscriptions()).toHaveLength(1);
	});

	it("pushes to every member of the project, and drops one who no longer maintains it", async () => {
		const mine = await subscribe();
		const { session, login: co, id: member } = await signIn("maintain");
		await db.prepare("INSERT INTO github_project_members(repository,user) VALUES(10,?)").bind(member).run();
		const theirs = await browser();
		expect((await post("/push/subscribe", theirs.json, { Cookie: session, Origin: origin })).status).toBe(204);
		const opened = (number: number) => ({
			action: "opened",
			installation: { id: 5 },
			repository: { id: 10 },
			issue: { id: 10 + number, number, title: `Issue ${number}` },
		});
		await delivery("issues", opened(3));
		expect(sent.map((s) => s.endpoint).sort()).toEqual([mine.endpoint, theirs.endpoint].sort());
		// A co-maintainer who lost the role is not notified, and leaves the project's inbox.
		repo.roles![co] = "read";
		await delivery("issues", opened(4));
		expect(sent.slice(2).map((s) => s.endpoint)).toEqual([mine.endpoint]);
		const members = await db.prepare("SELECT user FROM github_project_members WHERE repository=10").all();
		expect(members.results).toEqual([{ user }]);
	});

	it("pushes a new issue once, opening its decision, and never other updates", async () => {
		const device = await subscribe();
		const opened = {
			action: "opened",
			installation: { id: 5 },
			repository: { id: 10 },
			issue: { id: 13, number: 3, title: "Crash on start" },
		};
		repo.issues.push({ number: 3, title: "Crash on start", author: "reporter" });
		const id = crypto.randomUUID();
		expect((await delivery("issues", opened, id)).status).toBe(202);
		expect((await delivery("issues", opened, id)).status).toBe(200);
		expect((await delivery("issues", { ...opened, action: "edited" })).status).toBe(202);
		expect((await delivery("issue_comment", { ...opened, action: "created" })).status).toBe(202);
		expect(sent).toHaveLength(1);
		const [message] = sent;
		expect(message!.endpoint).toBe(device.endpoint);
		expect(message!.headers.get("Content-Encoding")).toBe("aes128gcm");
		expect(message!.headers.get("Authorization")).toMatch(/^vapid t=.+, k=/);
		expect(message!.headers.get("Topic")).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(await device.read(message!.body)).toEqual({
			title: "upstream/project",
			body: "New issue: Crash on start",
			tag: "10/issues/3",
			url: "/inbox?project=10&item=issues%2F3",
			// The open issue and pull request, the ready quest, and the new issue. A new
			// issue cannot change which quests are ready, so they stay available.
			badge: 4,
		});
	});

	it("pushes a pull request when it is ready for review, not while it is a draft", async () => {
		const device = await subscribe();
		const event = (action: string, draft: boolean) => ({
			action,
			installation: { id: 5 },
			repository: { id: 10 },
			pull_request: { id: 22, number: 4, title: "Add <b>it</b>", draft },
		});
		await delivery("pull_request", event("opened", true));
		expect(sent).toHaveLength(0);
		await delivery("pull_request", event("ready_for_review", false));
		await delivery("pull_request", event("opened", false));
		expect(sent).toHaveLength(2);
		const message = await device.read(sent[0]!.body);
		expect(message).toMatchObject({ body: "Ready for review: Add <b>it</b>", tag: "10/pulls/4" });
		// The same item shares one topic, so the push service replaces rather than queues.
		expect(sent[0]!.headers.get("Topic")).toBe(sent[1]!.headers.get("Topic"));
	});

	it("does not push for a paused project", async () => {
		await subscribe();
		await db.prepare("UPDATE github_projects SET state='paused' WHERE id=10").run();
		await delivery("issues", {
			action: "opened",
			installation: { id: 5 },
			repository: { id: 10 },
			issue: { id: 13, number: 3 },
		});
		expect(sent).toHaveLength(0);
	});

	it("pushes an agent's question with the item's title and forgets a device that is gone", async () => {
		const device = await subscribe();
		const machine = await store.createRunner(db, user, "laptop", "linux", false, 0);
		const runner = { ...machine, owner: user, name: "laptop", platform: "linux" as const, vm: 0 };
		await store.report(
			db,
			runner,
			[{ id: "main", provider: "anthropic", kind: "subscription", label: "Main", limited: false }],
			[],
			0,
		);
		const { id } = await store.createJob(
			db,
			{
				repository: 10,
				actor: user,
				workflow: "start",
				target: "quest/first.md",
				revision: commit,
				branch: "quest/first",
				trusted: true,
			},
			1,
		);
		await store.dispatch(db, user, new Map([[runner.id, 1]]), 2);
		const asked = await store.ask(db, runner, id, 1, { summary: "Which?", session: "s", prompt: {} }, 3);
		expect(asked.asked).toBe(true);
		await push.job(env, id, "question");
		expect(await device.read(sent[0]!.body)).toMatchObject({
			body: "Agent question: [S] First",
			url: "/inbox?project=10&item=quest%2Ffirst.md",
		});
		// A project paused while its job runs stops notifying.
		await db.prepare("UPDATE github_projects SET state='paused' WHERE id=10").run();
		await push.job(env, id, "question");
		expect(sent).toHaveLength(1);
		await db.prepare("UPDATE github_projects SET state='enabled' WHERE id=10").run();
		status = 410;
		await push.job(env, id, "question");
		expect(await subscriptions()).toEqual([]);
	});

	it("shows new decisions in the nav and offers notifications in the inbox", async () => {
		await subscribe();
		const html = await (await app.request(`${origin}/account`, { headers: { Cookie: cookie } }, testEnv)).text();
		expect(html).toContain('aria-label="Decisions, 3 new"');
		expect(html).toContain('<span class="count">3</span>');
		expect(html).toContain('data-unread="3"');
		expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"/>');
		const inbox = await (await app.request(`${origin}/inbox`, { headers: { Cookie: cookie } }, testEnv)).text();
		expect(inbox).toContain("data-compact");
		// The inbox marks its active decision seen before the nav and badge count it.
		expect(inbox).toContain('<span class="count">2</span>');
		expect(inbox).toContain('data-unread="2"');
		expect(inbox).toContain("3 waiting on you, 2 new.");
		const after = await (await app.request(`${origin}/docs`, { headers: { Cookie: cookie } }, testEnv)).text();
		expect(after).toContain('<span class="count">2</span>');
	});
});
