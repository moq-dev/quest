import { DurableObject } from "cloudflare:workers";
import * as push from "../push/notify";
import * as landing from "./landing";
import * as output from "./output";
import { MessageError, type RunnerMessage, parse } from "./protocol";
import * as store from "./store";
import * as trust from "./trust";
import { JobError } from "./store";
import { instructions } from "./trail";

/** The authenticated runner the Worker forwards a connection for. */
export const RUNNER_HEADER = "X-Quest-Runner";
/** Set only by the authenticated inbox route, never forwarded from a runner. */
export const INBOX_HEADER = "X-Quest-Inbox";

// Free job slots are unknown until the connection's first status.
type RunnerAttachment = { runner: store.Runner; slots: number | null; report?: string };
type Attachment = RunnerAttachment | { viewer: true };

/**
 * One per owner: their runners' live connections, and the single place
 * their jobs are routed. D1 stays the record; the hub pushes assignments
 * and cancellation down each connection and reassigns work after a runner
 * stays disconnected for the grace period.
 */
export class RunnerHub extends DurableObject<Env> {
	// Handlers interleave at each D1 await. Runner messages and dispatch passes
	// run one at a time, so a pass cannot assign from a status it has outlived.
	#serial: Promise<unknown> = Promise.resolve();

	async fetch(request: Request) {
		const viewer = request.headers.get(INBOX_HEADER);
		if (viewer) {
			if (request.headers.has(RUNNER_HEADER)) return new Response("Ambiguous connection", { status: 400 });
			await this.ctx.storage.put("owner", viewer);
			const { 0: client, 1: server } = new WebSocketPair();
			this.ctx.acceptWebSocket(server, ["inbox"]);
			server.serializeAttachment({ viewer: true } satisfies Attachment);
			return new Response(null, { status: 101, webSocket: client });
		}
		const runner = JSON.parse(request.headers.get(RUNNER_HEADER)!) as store.Runner;
		await this.ctx.storage.put("owner", runner.owner);
		const { 0: client, 1: server } = new WebSocketPair();
		// A reconnecting runner replaces its previous connection.
		for (const old of this.ctx.getWebSockets(runner.id)) old.close(4000, "Replaced by a new connection");
		this.ctx.acceptWebSocket(server, [runner.id]);
		server.serializeAttachment({ runner, slots: null } satisfies Attachment);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
		const attachment = ws.deserializeAttachment() as Attachment;
		if ("viewer" in attachment) {
			ws.close(1008, "Inbox connections are read only");
			return;
		}
		const { owner } = attachment.runner;
		let committed = false;
		let statusChanged = false;
		let message: RunnerMessage | undefined;
		try {
			const parsed = (message = parse(raw));
			statusChanged =
				parsed.type === "status" &&
				attachment.report !== JSON.stringify([parsed.accounts, parsed.attempts, parsed.slots]);
			const reply = await this.#run(() => this.#handle(ws, attachment, parsed));
			committed = true;
			ws.send(JSON.stringify({ type: "reply", id: message.id, ...reply }));
		} catch (error) {
			if (!(error instanceof JobError))
				console.error({
					event: "runner_message_failed",
					name: error instanceof Error ? error.name : "unknown",
				});
			const reason = error instanceof JobError ? error.message : "Request failed";
			ws.send(
				JSON.stringify({
					type: "reply",
					id: error instanceof MessageError ? error.id : message?.id,
					error: reason,
				}),
			);
		}
		if (message && message.type !== "output" && message.type !== "checkpoint") await this.#queue(owner);
		if (committed && message && (statusChanged || ["checkpoint", "question", "result"].includes(message.type)))
			await this.#notify(owner);
	}

	async webSocketClose(ws: WebSocket, code: number) {
		try {
			ws.close(code === 1005 ? 1000 : code, "Closed");
		} catch {}
		const attachment = ws.deserializeAttachment() as Attachment;
		if ("viewer" in attachment) return;
		await this.#queue(attachment.runner.owner, ws);
		await this.#notify(attachment.runner.owner);
	}

	async webSocketError(ws: WebSocket) {
		const attachment = ws.deserializeAttachment() as Attachment;
		if ("viewer" in attachment) return;
		await this.#queue(attachment.runner.owner, ws);
		await this.#notify(attachment.runner.owner);
	}

	async alarm() {
		const owner = await this.ctx.storage.get<string>("owner");
		if (owner) await this.dispatch(owner);
	}

	/** The runners with an open connection. */
	online(): string[] {
		return [...this.#connections().keys()];
	}

	/** Tell connected runners to stop attempts whose records are gone. */
	stop(attempts: (store.Attempt & { runner: string })[]) {
		const connections = this.#connections();
		for (const { runner, job, attempt } of attempts)
			connections.get(runner)?.send(JSON.stringify({ type: "cancel", job, attempt }));
	}

	/** Webhooks wake only the attempts named by their current durable records. */
	wake(attempts: (store.Attempt & { runner: string })[]) {
		const connections = this.#connections();
		for (const { runner, job, attempt } of attempts)
			connections.get(runner)?.send(JSON.stringify({ type: "wake", job, attempt }));
	}

	/** Reconcile and assign the owner's jobs. The Worker calls this after changing them. */
	async dispatch(owner: string) {
		await this.#queue(owner);
		await this.#notify(owner);
	}

	/**
	 * Reread a queued job's trust after a change outside the job, such as a
	 * head approval. Marking it in turn with dispatch passes keeps a pass that
	 * read the trust before the change from clearing the mark.
	 */
	async recheck(owner: string, job: string) {
		await this.#run(async () => {
			await store.recheck(this.env.DB, job);
			await this.#dispatch(owner);
		});
		await this.#notify(owner);
	}

	/** Only a fixed invalidation hint crosses this browser connection; content is reauthorized over HTTPS. */
	changed() {
		for (const ws of this.ctx.getWebSockets("inbox")) if (ws.readyState === WebSocket.OPEN) ws.send("changed");
	}

	async #notify(owner: string) {
		try {
			const { results } = await this.env.DB.prepare(
				"SELECT DISTINCT m.user FROM github_project_members m JOIN jobs j ON j.repository=m.repository WHERE j.actor=?",
			)
				.bind(owner)
				.all<{ user: string }>();
			for (const { user } of results) {
				if (user === owner) this.changed();
				else await this.env.RUNNERS.get(this.env.RUNNERS.idFromName(user)).changed();
			}
		} catch (error) {
			console.error({ event: "inbox_update_failed", name: error instanceof Error ? error.name : "unknown" });
		}
	}

	#queue(owner: string, closed?: WebSocket) {
		return this.#run(() => this.#dispatch(owner, closed));
	}

	#run<T>(task: () => Promise<T>): Promise<T> {
		const run = this.#serial.then(task);
		this.#serial = run.catch(() => {});
		return run;
	}

	#connections(closed?: WebSocket) {
		const open = new Map<string, WebSocket>();
		for (const ws of this.ctx.getWebSockets()) {
			const attachment = ws.deserializeAttachment() as Attachment;
			if ("runner" in attachment && ws !== closed && ws.readyState === WebSocket.OPEN)
				open.set(attachment.runner.id, ws);
		}
		return open;
	}

	async #dispatch(owner: string, closed?: WebSocket) {
		await this.ctx.storage.put("owner", owner);
		const connections = this.#connections(closed);
		// A connection counts once its first status arrives; until then a runner
		// that reconnects and hangs must not hold its jobs past the grace period.
		const slots = new Map<string, number>();
		for (const [runner, ws] of connections) {
			const reported = (ws.deserializeAttachment() as RunnerAttachment).slots;
			if (reported !== null) slots.set(runner, reported);
		}
		const { assign, cancel, ended, wake } = await store.dispatch(
			this.env.DB,
			owner,
			slots,
			Date.now(),
			trust.verify(this.env),
		);
		for (const { runner, job } of assign) {
			const message = { type: "assign", job, instructions: instructions(job.workflow) };
			connections.get(runner)?.send(JSON.stringify(message));
		}
		for (const { runner, job, attempt } of cancel)
			connections.get(runner)?.send(JSON.stringify({ type: "cancel", job, attempt }));
		// An abandoned attempt that was asked to cancel reports no result, so its hold is released here.
		for (const job of ended) this.ctx.waitUntil(landing.ended(this.env, job));
		if (assign.length || cancel.length || ended.length) await this.#notify(owner);
		if (wake === null) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm(wake);
	}

	async #handle(ws: WebSocket, attachment: RunnerAttachment, message: RunnerMessage) {
		const { runner } = attachment;
		const db = this.env.DB;
		const now = Date.now();
		switch (message.type) {
			case "status": {
				const { attempts, ended } = await store.report(db, runner, message.accounts, message.attempts, now);
				for (const job of ended) this.ctx.waitUntil(landing.ended(this.env, job));
				attachment.slots = message.slots;
				attachment.report = JSON.stringify([message.accounts, message.attempts, message.slots]);
				ws.serializeAttachment(attachment);
				return { attempts };
			}
			case "checkpoint":
				return store.checkpoint(
					db,
					runner,
					message.job,
					message.attempt,
					message.summary,
					message.session,
					now,
				);
			case "question": {
				const { question, cancel, asked } = await store.ask(
					db,
					runner,
					message.job,
					message.attempt,
					message,
					now,
				);
				if (asked && !cancel) this.ctx.waitUntil(push.job(this.env, message.job, "question"));
				return { question, cancel };
			}
			case "output":
				// Past the attempt's cap the reply says `truncated`, and the job carries on.
				return output.append(this.env, runner, message, now);
			case "result": {
				const state = await store.finish(db, runner, message.job, message.attempt, message, now);
				// A limit waits on an account choice; a failure waits on a retry.
				if (state === "waiting" || state === "failed")
					this.ctx.waitUntil(push.job(this.env, message.job, state === "waiting" ? "account" : "failed"));
				// A merge job that ended without a landing in progress gives its pull request back.
				if (state && state !== "waiting") this.ctx.waitUntil(landing.ended(this.env, message.job));
				return {};
			}
		}
	}
}
