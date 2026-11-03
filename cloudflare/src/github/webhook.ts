import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as landing from "../jobs/landing";
import { wake } from "../jobs/wake";
import { arrived } from "../push/notify";
import { admitted, GitHubService } from "./service";

export function positiveId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export async function webhookSignature(secret: string, signature: string | undefined, bytes: ArrayBuffer) {
	if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	const digest = Uint8Array.from(signature.slice(7).match(/../g)!, (value) => parseInt(value, 16));
	return crypto.subtle.verify("HMAC", key, digest, bytes);
}

const observed = new Set([
	"push",
	"issues",
	"issue_comment",
	"pull_request",
	"pull_request_review",
	"pull_request_review_thread",
	"pull_request_review_comment",
	"check_run",
	"check_suite",
	"status",
]);
const lifecycle = new Map([
	["created", false],
	["deleted", true],
	["suspend", true],
	["unsuspend", false],
	["new_permissions_accepted", false],
]);
// Only opening, closing, or claiming a quest, or a new quest tree, can change
// availability, and a new PR head changes what iterating on it starts from.
// Checks, comments, and other pushes wait for the history scan, so a busy
// repository cannot keep restarting a refresh or withholding candidates.
function invalidates(event: string, payload: any) {
	if (event === "pull_request") return ["opened", "reopened", "closed", "synchronize"].includes(payload.action);
	if (event !== "push" || typeof payload.ref !== "string") return false;
	if (payload.ref.startsWith("refs/heads/quest/")) return payload.created === true || payload.deleted === true;
	return payload.ref === `refs/heads/${payload.repository.default_branch}`;
}
// Far beyond GitHub's redelivery window. Older IDs could be accepted again,
// which is harmless because observations never authorize or launch work.
export const deliveryRetention = 30 * 24 * 60 * 60 * 1000;

export const githubWebhooks = new Hono<{ Bindings: Env }>();
githubWebhooks.use("/webhooks/github", bodyLimit({ maxSize: 25 * 1024 * 1024 }));
githubWebhooks.post("/webhooks/github", async (c) => {
	if (!c.env.GITHUB_WEBHOOK_SECRET || !c.env.GITHUB_APP_ID) return c.json({ error: "App not configured" }, 503);
	const bytes = await c.req.arrayBuffer();
	if (!(await webhookSignature(c.env.GITHUB_WEBHOOK_SECRET, c.req.header("X-Hub-Signature-256"), bytes))) {
		return c.json({ error: "Invalid signature" }, 403);
	}
	const delivery = c.req.header("X-GitHub-Delivery");
	const event = c.req.header("X-GitHub-Event");
	if (!delivery || !/^[a-zA-Z0-9-]{1,100}$/.test(delivery) || !event)
		return c.json({ error: "Invalid delivery" }, 400);
	let payload;
	try {
		payload = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
	} catch {
		return c.json({ error: "Invalid payload" }, 400);
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return c.json({ error: "Invalid payload" }, 400);
	if (event !== "ping" && event !== "installation" && event !== "installation_repositories" && !observed.has(event)) {
		return c.json({ status: "ignored" }, 202);
	}
	const installation = payload.installation?.id ?? null;
	const repository = payload.repository?.id ?? null;
	const action = typeof payload.action === "string" ? payload.action : null;
	if (event !== "ping" && !positiveId(installation)) return c.json({ error: "Invalid installation" }, 400);
	if (
		event === "installation" &&
		(String(payload.installation.app_id) !== c.env.GITHUB_APP_ID || !lifecycle.has(action!))
	) {
		return c.json({ error: "Invalid installation event" }, 400);
	}
	if (event === "installation_repositories" && action !== "added" && action !== "removed") {
		return c.json({ error: "Invalid repository event" }, 400);
	}
	if (observed.has(event) && !positiveId(repository)) return c.json({ error: "Invalid repository" }, 400);
	// An owner off the allowlist gets nothing recorded, read, or woken. Installation
	// events name their account; repository events, the repository's owner.
	const owner = observed.has(event) ? payload.repository.owner?.id : payload.installation?.account?.id;
	if (event !== "ping" && !admitted(c.env, owner)) return c.json({ status: "ignored" }, 202);
	const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
	const previous = await c.env.DB.prepare("SELECT digest,event FROM github_deliveries WHERE id=?")
		.bind(delivery)
		.first<{ digest: string; event: string }>();
	if (previous) {
		if (previous.digest !== digest || previous.event !== event) return c.json({ error: "Delivery conflict" }, 409);
		return c.json({ status: "duplicate" });
	}
	const now = Date.now();
	const statements = [
		c.env.DB.prepare(
			"INSERT OR IGNORE INTO github_deliveries(id,digest,event,installation,repository,action,receivedAt) VALUES(?,?,?,?,?,?,?)",
		).bind(delivery, digest, event, installation, repository, action, now),
	];
	// D1 batch is a transaction. The processed predicate prevents concurrent
	// duplicates from applying a lifecycle transition twice.
	if (event === "installation") {
		statements.push(
			c.env.DB.prepare(
				`INSERT INTO github_installations(id,blocked,action)
			SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM github_deliveries WHERE id=? AND digest=? AND event=? AND processed=0)
			ON CONFLICT(id) DO UPDATE SET blocked=excluded.blocked, action=excluded.action, revision=github_installations.revision+1`,
			).bind(installation, lifecycle.get(action!) ? 1 : 0, action, delivery, digest, event),
		);
	} else if (event === "installation_repositories") {
		statements.push(
			c.env.DB.prepare(
				`UPDATE github_installations SET revision=revision+1, action=?
			WHERE id=? AND EXISTS(SELECT 1 FROM github_deliveries WHERE id=? AND digest=? AND event=? AND processed=0)`,
			).bind(`repositories_${action}`, installation, delivery, digest, event),
		);
	}
	// The statement that asks for a background read, if this delivery does.
	let reads: number | null = null;
	if (observed.has(event)) {
		const pending = "EXISTS(SELECT 1 FROM github_deliveries WHERE id=? AND digest=? AND event=? AND processed=0)";
		const enrolled = "EXISTS(SELECT 1 FROM github_projects WHERE id=? AND installation=?)";
		// Only identity pointers are retained from untrusted webhook content.
		// Different delivery IDs and later updates coalesce on the provider ID.
		const pull = payload.pull_request;
		const issue = payload.issue;
		const kind = pull ? "pull" : issue && !issue.pull_request ? "issue" : null;
		const entity = pull ?? issue;
		const named = kind && positiveId(entity.id) && positiveId(entity.number);
		if (named) {
			statements.push(
				c.env.DB.prepare(
					`INSERT INTO github_project_activity(repository,kind,id,number,firstSeen,changedAt,stale)
			SELECT ?,?,?,?,?,?,1 WHERE ${pending} AND ${enrolled}
			ON CONFLICT(repository,kind,id) DO UPDATE SET changedAt=excluded.changedAt,stale=github_project_activity.stale+1`,
				).bind(
					repository,
					kind,
					String(entity.id),
					entity.number,
					now,
					now,
					delivery,
					digest,
					event,
					repository,
					installation,
				),
			);
		}
		// A comment on a PR carries the PR's number, but under its issue ID, so
		// it marks the PR's row by number. An untracked PR waits for history.
		const discussed = !pull && issue?.pull_request && positiveId(issue.number);
		if (discussed)
			statements.push(
				c.env.DB.prepare(
					`UPDATE github_project_activity SET changedAt=?,stale=stale+1
			WHERE repository=? AND kind='pull' AND number=? AND ${pending} AND ${enrolled}`,
				).bind(now, repository, issue.number, delivery, digest, event, repository, installation),
			);
		const invalidating = invalidates(event, payload);
		if (invalidating)
			statements.push(
				c.env.DB.prepare(
					`UPDATE github_project_state SET invalidated=1,revision=revision+1 WHERE repository=? AND ${pending} AND ${enrolled}`,
				).bind(repository, delivery, digest, event, repository, installation),
			);
		// What the inbox shows changed: ask for a background read. CI and other
		// pushes change neither, so they cost no read.
		if (named || discussed || invalidating) {
			reads = statements.length;
			statements.push(
				c.env.DB.prepare(
					`INSERT INTO github_project_state(repository,epoch,requested) SELECT ?,?,1 WHERE ${pending} AND ${enrolled}
			ON CONFLICT(repository) DO UPDATE SET requested=1`,
				).bind(repository, crypto.randomUUID(), delivery, digest, event, repository, installation),
			);
		}
	}

	statements.push(
		c.env.DB.prepare("UPDATE github_deliveries SET processed=1 WHERE id=? AND digest=? AND event=?").bind(
			delivery,
			digest,
			event,
		),
		c.env.DB.prepare("DELETE FROM github_deliveries WHERE receivedAt<?").bind(now - deliveryRetention),
	);
	const committed = await c.env.DB.batch(statements);
	if (committed[0]!.meta.changes === 0) {
		// Another request may have inserted this ID after our initial read.
		// Its digest/event predicate prevents effects; report a conflicting ID
		// instead of acknowledging a different authenticated delivery.
		const winner = await c.env.DB.prepare("SELECT digest,event FROM github_deliveries WHERE id=?")
			.bind(delivery)
			.first<{ digest: string; event: string }>();
		if (winner?.digest !== digest || winner.event !== event) return c.json({ error: "Delivery conflict" }, 409);
		return c.json({ status: "duplicate" });
	}
	// Observations never approve or launch work. The background read reconciles
	// current GitHub state rather than treating delayed webhook bodies as facts.
	// A new decision item still notifies, once, from the first delivery, after
	// the read so a title the webhook lacks can come from GitHub.
	const read = reads !== null && committed[reads]!.meta.changes > 0;
	if (read || observed.has(event))
		c.executionCtx.waitUntil(
			(async () => {
				try {
					if (read) await new GitHubService(c.env).observe(repository);
				} finally {
					if (observed.has(event)) await arrived(c.env, repository, installation, event, payload);
				}
			})(),
		);
	if (observed.has(event)) c.executionCtx.waitUntil(wake(c.env, repository, installation, event, payload));
	// A landing that ended unmerged, such as a merge queue removal, gives a merge job's pull request back.
	const landed = event === "pull_request" && positiveId(payload.pull_request?.number);
	if (landed) c.executionCtx.waitUntil(landing.release(c.env, repository, `pulls/${payload.pull_request.number}`));
	return c.json({ status: "accepted" }, 202);
});
