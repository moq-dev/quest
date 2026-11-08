// `quest runner`: one machine's live presence on kix. It reports its seats (its
// opencode accounts and its Claude pool) as accounts, its running attempts, and
// its free slots in a `status` whenever they change, takes `assign` and
// `cancel` pushes, and runs each attempt until it reports.
import type { Round } from "../cli/review";
import type { Adapter } from "./adapter";
import { Connection, type Dial, dialWebSocket } from "./connection";
import type { Login, Pool, RunnerHome, Seat } from "./home";
import { Attempt, type Context } from "./job";
import type { Action, Job, Message, Push } from "./protocol";
import type { RunningProxy } from "./proxy";
import { type ReviewRequest, reviewHead } from "./review";

/** When neither the provider nor the proxy says when a limit resets, the seat or pool sits out this long. */
export const LIMIT_FALLBACK_MS = 60 * 60_000;

export interface RunnerOptions {
	home: RunnerHome;
	login: Login;
	/** How many jobs run at once. */
	slots: number;
	adapter(seat: Seat): Adapter;
	/** The runner's CLIProxyAPI, which pools its Claude and Codex accounts. */
	proxy: Pick<RunningProxy, "origin" | "key" | "reset">;
	devShell(job: Job, repository: string, signal: AbortSignal): Promise<string | null>;
	remote(job: Job): string;
	/** Review a published head; `quest review` on its own checkout by default. */
	review?(request: ReviewRequest): Promise<Round>;
	env?: NodeJS.ProcessEnv;
	dial?: Dial;
	fetch?: typeof fetch;
	now?(): number;
	log(line: string): void;
}

export class Runner {
	readonly options: RunnerOptions;
	readonly connection: Connection;
	/** Each job's current attempt here. */
	#current = new Map<string, Attempt>();
	/** Every attempt whose agent may still be running, including superseded ones. */
	#live = new Set<Attempt>();
	/** Attempts that already ran here, as `job.attempt`, so a late resend never runs one again. */
	#ended = new Set<string>();
	#status: Promise<void> | null = null;
	#dirty = false;
	#closing = false;
	#wake: ReturnType<typeof setTimeout> | undefined;
	#stopped: () => void = () => {};
	/** Settles once the runner shut down or kix replaced its connection, and its agents exited. */
	readonly done: Promise<"stopped" | "replaced">;

	constructor(options: RunnerOptions) {
		this.options = options;
		const ws = `${options.login.url.replace(/^http/, "ws").replace(/\/$/, "")}/api/runner/connect`;
		let resolve!: (value: "stopped" | "replaced") => void;
		this.done = new Promise((r) => (resolve = r));
		this.#stopped = () => resolve("stopped");
		this.connection = new Connection(
			ws,
			options.login.token,
			{
				open: () => {
					for (const attempt of this.#live) attempt.wake();
					this.status();
				},
				push: (push) => this.#push(push),
				replaced: () => {
					this.#closing = true;
					const attempts = [...this.#live];
					for (const attempt of attempts) attempt.abandon();
					clearTimeout(this.#wake);
					this.connection.close();
					// The runner keeps its home until its agents exit, so none outlives its hold on their checkouts.
					void Promise.allSettled(attempts.map((attempt) => attempt.finished)).then(() =>
						resolve("replaced"),
					);
				},
				log: options.log,
			},
			options.dial ?? dialWebSocket,
		);
	}

	start(): void {
		this.connection.start();
		this.#schedule();
	}

	get running(): Attempt[] {
		return [...this.#live];
	}

	/**
	 * Shut down: stop every agent, publish its work to its branch, then tell kix
	 * none are running so their jobs move to another runner at once.
	 */
	async shutdown(): Promise<void> {
		if (this.#closing) return;
		this.#closing = true;
		const attempts = [...this.#live];
		for (const attempt of attempts) attempt.abandon();
		await Promise.allSettled(attempts.map((attempt) => attempt.finished));
		if (this.connection.open)
			await Promise.race([
				this.#send({ type: "status", accounts: this.#accounts(), attempts: [], slots: 0 }).catch(() => {}),
				new Promise((resolve) => setTimeout(resolve, 5000)),
			]);
		clearTimeout(this.#wake);
		this.connection.close();
		this.#stopped();
	}

	#now(): number {
		return this.options.now?.() ?? Date.now();
	}

	#accounts() {
		const now = this.#now();
		const limits = this.options.home.limits();
		return this.options.home.seats().map((seat) => ({
			id: seat.id,
			provider: seat.provider,
			kind: seat.kind,
			label: seat.label,
			limited: (limits[seat.id] ?? 0) > now,
		}));
	}

	#send(message: Message) {
		return this.connection.request(message);
	}

	/** Send a fresh status, coalescing changes that arrive while one is in flight. */
	status(): void {
		if (this.#status) {
			this.#dirty = true;
			return;
		}
		this.#status = (async () => {
			do {
				this.#dirty = false;
				const listed = [...this.#live].filter((attempt) => attempt.listed);
				const message: Message = {
					type: "status",
					accounts: this.#accounts(),
					attempts: listed.map(({ job }) => ({ job: job.id, attempt: job.attempt })),
					slots: this.#closing ? 0 : Math.max(0, this.options.slots - this.#live.size),
				};
				try {
					const reply = await this.#send(message);
					for (const action of (reply.attempts ?? []) as Action[]) this.#act(action);
				} catch (error) {
					this.options.log(`status refused: ${error instanceof Error ? error.message : String(error)}`);
				}
			} while (this.#dirty && !this.#closing);
			this.#status = null;
		})();
	}

	#act({ job, attempt, action }: Action): void {
		const found = [...this.#live].find((a) => a.job.id === job && a.attempt === attempt);
		if (!found || action === "continue") return;
		if (action === "cancel") found.cancel();
		else found.stop();
	}

	#push(push: Push): void {
		if (push.type === "cancel" || push.type === "wake") {
			const attempt = this.#current.get(push.job);
			if (attempt?.attempt === push.attempt) {
				if (push.type === "wake") attempt.wake();
				else attempt.cancel();
			}
			return;
		}
		const { job, instructions } = push;
		const current = this.#current.get(job.id);
		// The hub resends an assignment until a status lists it, which can cross a quick attempt's end.
		if (current?.attempt === job.attempt || this.#ended.has(`${job.id}.${job.attempt}`)) return this.status();
		if (this.#closing) return;
		this.options.log(`${job.id}: ${job.workflow} ${job.target} (attempt ${job.attempt})`);
		// A newer attempt fences out the old one, which must exit before its session resumes.
		current?.stop();
		const attempt = new Attempt(this.#context(), job, instructions);
		this.#current.set(job.id, attempt);
		this.#live.add(attempt);
		this.status();
		attempt.start(current?.finished).finally(() => {
			this.#ended.add(`${job.id}.${job.attempt}`);
			this.#live.delete(attempt);
			if (this.#current.get(job.id) === attempt) this.#current.delete(job.id);
			if (!this.#closing) this.status();
		});
	}

	#context(): Context {
		const { options } = this;
		return {
			root: options.home.dir,
			seats: () => options.home.seats(),
			home: (seat) => options.home.seatHome(seat),
			adapter: options.adapter,
			pools: () => ({
				accounts: options.home.accounts(),
				limits: options.home.limits(),
				home: (pool) => options.home.poolHome(pool),
				proxy: options.proxy,
			}),
			devShell: options.devShell,
			remote: options.remote,
			env: options.env ?? process.env,
			request: (message) => this.#send(message),
			publish: (body) => this.#post("publish", body),
			review: options.review ?? reviewHead,
			reviewed: (body) => this.#post("review", body),
			context: (job, attempt) => this.#target(job, attempt),
			limited: (id, until, model) => this.#limited(id, until, model),
			log: options.log,
		};
	}

	/** `POST /api/runner/<path>`, returning its status and JSON body. */
	async #post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
		const fetcher = this.options.fetch ?? fetch;
		const response = await fetcher(`${this.options.login.url.replace(/\/$/, "")}/api/runner/${path}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.options.login.token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		let parsed: Record<string, unknown> = {};
		try {
			parsed = (await response.json()) as Record<string, unknown>;
		} catch {}
		return { status: response.status, body: parsed };
	}

	async #target(job: string, attempt: number): Promise<unknown> {
		const fetcher = this.options.fetch ?? fetch;
		const query = new URLSearchParams({ job, attempt: String(attempt) });
		const response = await fetcher(`${this.options.login.url.replace(/\/$/, "")}/api/runner/context?${query}`, {
			headers: { Authorization: `Bearer ${this.options.login.token}` },
		});
		const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		if (!response.ok)
			throw new Error(typeof body.error === "string" ? body.error : `kix answered ${response.status}`);
		return body;
	}

	/**
	 * Keep a refused seat or pool out of routing and reviews until it resets,
	 * and report the change. The CLIs show a pool's cooldown without its reset,
	 * so the proxy is asked for it.
	 */
	async #limited(id: string, until: number | null, model?: string): Promise<number> {
		const { home, proxy, log } = this.options;
		if (until === null && model !== undefined && (id === "claude" || id === "codex"))
			until = await proxy.reset(id as Pool, model).catch((error: unknown) => {
				log(`could not ask CLIProxyAPI when the ${id} pool resets: ${(error as Error).message}`);
				return null;
			});
		const now = this.#now();
		const resets = until !== null && until > now ? until : now + LIMIT_FALLBACK_MS;
		home.limit(id, resets);
		const name = home.seats().find((seat) => seat.id === id)?.label ?? `The ${id} pool`;
		log(`${name} is limited until ${new Date(resets).toISOString()}`);
		this.#schedule();
		this.status();
		return resets;
	}

	/** Report again when the next limited account resets. */
	#schedule(): void {
		clearTimeout(this.#wake);
		// A closing runner reports nothing more, and its timer must not keep the process alive.
		if (this.#closing) return;
		const now = this.#now();
		const next = Math.min(...Object.values(this.options.home.limits()).filter((until) => until > now));
		if (!Number.isFinite(next)) return;
		this.#wake = setTimeout(
			() => {
				this.status();
				this.#schedule();
			},
			Math.min(next - now + 1000, 2_147_483_647),
		);
	}
}
