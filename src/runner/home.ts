// A runner's state on disk: its kix sign-in, its agent accounts, the
// repositories it fetched, and its jobs' checkouts. Everything lives in one
// user-only directory, so two runners on one machine just use two homes.
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

/** One agent account, signed in by its CLI in its own home under `accounts/<id>`. */
export interface Account {
	/** Opaque and stable across restarts, so kix keeps its preference rank and paused sessions. */
	id: string;
	/** The CLI that drives it. */
	adapter: AdapterName;
	provider: string;
	kind: AccountKind;
	label: string;
	/** While the provider refuses the account, until this time in milliseconds. */
	limitedUntil?: number;
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
		return load<Account[]>(join(this.dir, "accounts.json")) ?? [];
	}

	saveAccounts(accounts: Account[]): void {
		save(join(this.dir, "accounts.json"), accounts);
	}

	/** A new account's id and its empty, user-only home. */
	newAccount(): { id: string; home: string } {
		const id = randomBytes(8).toString("hex");
		return { id, home: this.accountHome(id) };
	}

	accountHome(id: string): string {
		return privateDirectory(join(this.dir, "accounts", id));
	}

	removeAccount(id: string): Account | undefined {
		const accounts = this.accounts();
		const found = accounts.find((account) => account.id === id);
		if (!found) return undefined;
		this.saveAccounts(accounts.filter((account) => account !== found));
		rmSync(join(this.dir, "accounts", id), { recursive: true, force: true });
		return found;
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
