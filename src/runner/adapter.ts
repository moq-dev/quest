// How a runner drives one agent CLI, Claude Code or opencode. The interface
// stays small: sign an account in, start or resume a session with the kix
// tools attached, stream its raw output, stop it, and read how it ended.
// Questions, checkpoints, and delivery reach kix through those tools, not
// through anything CLI-specific.
import { strippedEnvironment } from "../cli/agent";
import type { AccountKind } from "./home";
import type { Sandbox } from "./sandbox";

/** The agent CLIs a runner drives. */
export type AdapterName = "claude" | "opencode";

/** How long a stopped agent has to exit before it is killed. */
export const STOP_GRACE_MS = 10_000;

/**
 * Signal the process group a detached CLI leads, so stopping it also stops
 * the devShell and every tool it started.
 */
export function signalGroup(pid: number | undefined, name: NodeJS.Signals): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, name);
	} catch {}
}

/**
 * The user's environment for an account's CLI, without other harnesses'
 * state, keys, or GitHub tokens: kix publishes, and the agent never pushes.
 */
export function baseEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const kept = strippedEnvironment(env);
	delete kept.GH_TOKEN;
	delete kept.GITHUB_TOKEN;
	return kept;
}

export interface Launch {
	/** The job's checkout, where the agent works. */
	cwd: string;
	/** The account's isolated home, which holds its CLI login and sessions. */
	home: string;
	session: string;
	/** Resume `session` rather than starting it. */
	resume: boolean;
	/** The turn's message: the workflow on a new session, or the maintainer's answers on a resumed one. */
	prompt: string;
	/** Standing instructions appended to the CLI's own system prompt. */
	system: string;
	/** The kix tools' MCP endpoint and bearer token. */
	tools: { url: string; token: string };
	/** The OS sandbox every command the agent runs is confined to. */
	sandbox: Sandbox;
	env: NodeJS.ProcessEnv;
	/** Receives each line of the CLI's raw output. */
	output(line: string): void;
}

export interface Exit {
	/** The provider refused the account for its usage limit, until this time if known. */
	limited: { until: number | null } | null;
	/** The turn ended in an error rather than a reply. */
	failed: boolean;
	/** The agent's last reply, or the error it ended with. */
	reply?: string;
}

export interface Running {
	done: Promise<Exit>;
	/** Ask the CLI to stop, killing it after a grace period. */
	stop(): void;
	/** The model and effort the session runs on, each `unknown` where the CLI does not show it. */
	ran(): Promise<{ model: string; effort: string }>;
}

export interface SignedIn {
	/** The provider kix shows for the account, such as anthropic or openai. */
	provider: string;
	kind: AccountKind;
	/** A label for the account, such as its email. */
	label: string;
}

export interface Adapter {
	readonly name: AdapterName;
	/** Run the CLI's own interactive sign-in in `home`. `console` picks Claude Code's Console billing. */
	login(home: string, options: { console: boolean }): Promise<void>;
	/** Whether `home` holds a signed-in account, and what kind. */
	status(home: string): Promise<SignedIn | null>;
	launch(launch: Launch): Running;
}
