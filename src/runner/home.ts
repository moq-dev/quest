// A runner's state on disk: its kix sign-in, its agent accounts and their
// limits, its CLIProxyAPI's pool, the repositories it fetched, and its jobs'
// checkouts. Everything lives in one user-only directory, so two runners on one
// machine just use two homes.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { privateDirectory } from "../cli/agent";
import { type Owner, alive, currentOwner } from "../cli/supervise";
import { save } from "../cli/worktree";
import type { AdapterName } from "./adapter";

/** The runner's kix sign-in, from `quest runner login`. */
export interface Login {
	/** The kix origin, such as https://quest.moq.dev. */
	url: string;
	/** The bearer token this machine made; kix stores only its hash. */
	token: string;
	id: string;
	name: string;
}

export type AccountKind = "subscription" | "api-key";

/** The CLI an account signs in for: Claude Code and Codex pool their accounts, and opencode keeps a home per account. */
export type Cli = AdapterName | "codex";

/** The vendors whose accounts pool behind the runner's CLIProxyAPI, one pool each. */
export type Pool = Exclude<Cli, "opencode">;

/** The provider each pool's models come from, as accounts report it. */
export const POOL_PROVIDER: Record<Pool, string> = { claude: "anthropic", codex: "openai" };

/** One account the user added: an opencode home under `accounts/<id>`, or a credential in the proxy's pool. */
export interface Account {
	/** Opaque and stable across restarts. */
	id: string;
	cli: Cli;
	provider: string;
	kind: AccountKind;
	label: string;
	/** A pooled OAuth login's file in the proxy's auth directory. */
	credential?: string;
	/** A pooled Anthropic Console API key, which the proxy's config lists. */
	key?: string;
}

/**
 * What kix routes a job to: one opencode account, or the Claude pool as a
 * whole. Codex's pool only reviews, since no adapter runs Codex jobs.
 */
export interface Seat {
	/** An opencode account's id, or the pool's name; kix keeps its preference rank and paused sessions. */
	id: string;
	adapter: AdapterName;
	provider: string;
	kind: AccountKind;
	label: string;
}

/** The longest label kix stores. */
const LABEL = 100;

/** The Claude pool's label: its accounts' labels, cut to fit. */
function poolLabel(accounts: Account[]): string {
	const label = `Claude pool: ${accounts.map((account) => account.label).join(", ")}`;
	return label.length <= LABEL ? label : `${label.slice(0, LABEL - 1)}…`;
}

function load<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** `QUEST_RUNNER_HOME`, or the user's data directory. */
export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
	if (env.QUEST_RUNNER_HOME) return env.QUEST_RUNNER_HOME;
	return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "quest", "runner");
}

export class RunnerHome {
	readonly dir: string;

	constructor(dir: string) {
		// Absolute, since the sandbox and opencode's OPENCODE_DB take the paths under it as they are.
		this.dir = privateDirectory(resolve(dir));
	}

	login(): Login | undefined {
		return load<Login>(join(this.dir, "login.json"));
	}

	saveLogin(login: Login): void {
		save(join(this.dir, "login.json"), login);
	}

	accounts(): Account[] {
		const path = join(this.dir, "accounts.json");
		const accounts = load<Account[]>(path) ?? [];
		if (accounts.some((account) => typeof account.cli !== "string"))
			throw new Error(
				`${path} is from an earlier quest runner, before Claude Code accounts pooled in the runner's own CLIProxyAPI; delete it and ${join(this.dir, "accounts")}, then add each account again with \`quest runner account add\``,
			);
		return accounts;
	}

	saveAccounts(accounts: Account[]): void {
		save(join(this.dir, "accounts.json"), accounts);
	}

	/** What kix routes jobs to, in the order the accounts were added: the Claude pool where its first account was. */
	seats(): Seat[] {
		const accounts = this.accounts();
		const claude = accounts.filter((account) => account.cli === "claude");
		const seats: Seat[] = [];
		for (const account of accounts) {
			if (account.cli === "opencode") {
				const { id, provider, kind, label } = account;
				seats.push({ id, adapter: "opencode", provider, kind, label });
			} else if (account === claude[0]) {
				seats.push({
					id: "claude",
					adapter: "claude",
					provider: POOL_PROVIDER.claude,
					kind: claude.some((a) => a.kind === "subscription") ? "subscription" : "api-key",
					label: poolLabel(claude),
				});
			}
		}
		return seats;
	}

	/** A new account's id. */
	newId(): string {
		return randomBytes(8).toString("hex");
	}

	/** An opencode account's user-only home. */
	accountHome(id: string): string {
		return privateDirectory(join(this.dir, "accounts", id));
	}

	/** The CLI home a seat's jobs run in: its opencode account's, or its pool's, which holds sessions but no login. */
	seatHome(seat: Seat): string {
		return seat.adapter === "opencode" ? this.accountHome(seat.id) : this.poolHome(seat.adapter);
	}

	/** The pool's CLI home, `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, which keeps sessions and never a login. */
	poolHome(pool: Pool): string {
		return privateDirectory(join(this.dir, "pools", pool));
	}

	/** Where the runner's CLIProxyAPI keeps its config, client key, logs, and pooled credentials. */
	proxyDir(): string {
		return privateDirectory(join(this.dir, "proxy"));
	}

	removeAccount(id: string): Account | undefined {
		const accounts = this.accounts();
		const found = accounts.find((account) => account.id === id);
		if (!found) return undefined;
		this.saveAccounts(accounts.filter((account) => account !== found));
		if (found.cli === "opencode") {
			rmSync(join(this.dir, "accounts", id), { recursive: true, force: true });
			this.limit(id, null);
		}
		if (found.credential) rmSync(join(this.proxyDir(), "auth", found.credential), { force: true });
		return found;
	}

	/** When each seat or pool the provider refused resets, in milliseconds. */
	limits(): Record<string, number> {
		return load<Record<string, number>>(join(this.dir, "limits.json")) ?? {};
	}

	/** Record that a seat or pool is limited until `until`, or no longer limited. */
	limit(id: string, until: number | null): void {
		const { [id]: _, ...limits } = this.limits();
		save(join(this.dir, "limits.json"), until === null ? limits : { ...limits, [id]: until });
	}

	/**
	 * Take this home for one `quest runner` process until `release`, so no two
	 * runners reuse one job checkout. The process records itself before looking
	 * for others, so of two that start at once at least one sees the other and
	 * refuses; neither ever works alongside the other. A record whose process
	 * has exited, such as one that crashed, is removed instead.
	 */
	hold(): { release(): void } {
		const dir = privateDirectory(join(this.dir, "running"));
		const record = join(dir, `${randomUUID()}.json`);
		save(record, currentOwner());
		const release = () => rmSync(record, { force: true });
		for (const name of readdirSync(dir)) {
			const other = join(dir, name);
			if (other === record || !name.endsWith(".json")) continue;
			const owner = load<Owner>(other);
			if (owner === undefined) continue;
			if (!alive(owner)) {
				rmSync(other, { force: true });
				continue;
			}
			release();
			throw new Error(
				`another \`quest runner\` is running in ${this.dir} (process ${owner.pid} on ${owner.host}); stop it first`,
			);
		}
		return { release };
	}

	/** Where fetched repositories and job checkouts live. */
	path(...parts: string[]): string {
		return join(this.dir, ...parts);
	}
}
