// The OS sandbox every job's commands run in: bubblewrap on Linux, Seatbelt
// on macOS, through Claude Code's own sandbox or, for opencode, the same
// sandbox-runtime run as its shell. Commands write only to the
// job's checkout and a private temporary directory, read no account home,
// runner state, or shared temporary files, and have no Nix daemon. A trusted
// revision's commands reach only the package registries; an untrusted one's
// reach no network host. The project's devShell is evaluated by the runner from the
// job's revision, never the checkout an agent edited, and its environment,
// shellHook included, is sourced inside the sandbox before each command.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Sandbox {
	/** The job's checkout, which commands read and write. */
	cwd: string;
	/** The bare clone the checkout's `.git` points into, which commands read. */
	repository: string;
	/** The attempt's private directory: commands' TMPDIR and HOME, and nothing else writable besides the checkout. */
	tmp: string;
	/** A script sourced inside the sandbox before each command: the private HOME and the devShell's environment. */
	env: string;
	/** Paths commands cannot read: every account home, the runner's state, and shared temporary directories. */
	deny: string[];
	/** Hosts commands may reach: the package registries for a trusted revision, otherwise none. */
	domains: string[];
}

/**
 * The package registries a trusted revision's commands may reach, so its
 * checks can install dependencies: npm (also under yarn's name), crates.io's
 * index and downloads, and PyPI. Nothing else needs the network: kix
 * publishes, and the runner builds the devShell before the job runs.
 * crates.io's own host, which serves only its publishing API, stays out.
 */
export const REGISTRIES = [
	"registry.npmjs.org",
	"registry.yarnpkg.com",
	"index.crates.io",
	"static.crates.io",
	"pypi.org",
	"files.pythonhosted.org",
];

/** Where other users' and this user's private files live, per platform. */
function hidden(platform: NodeJS.Platform): string[] {
	return platform === "darwin"
		? ["/Users", "/var/root", "/tmp", "/private/tmp", "/private/var/folders"]
		: ["/home", "/root", "/tmp", "/var/tmp", "/run/user"];
}

/**
 * Make an attempt's sandbox. `devShell` is the script `nix print-dev-env`
 * printed for the job's revision, or null to run in the runner's own
 * environment. Only a `trusted` revision's commands reach the registries. The temporary directory sits directly under /tmp, since the
 * sandbox's bridge sockets live in it and a socket path is at most 104 bytes.
 */
export function openSandbox(options: {
	cwd: string;
	repository: string;
	runnerHome: string;
	devShell: string | null;
	trusted: boolean;
	platform?: NodeJS.Platform;
	home?: string;
}): Sandbox {
	const platform = options.platform ?? process.platform;
	const tmp = realpathSync(mkdtempSync("/tmp/quest-job-"));
	const home = join(tmp, "home");
	mkdirSync(home);
	const lines = [`export HOME=${quote(home)}`];
	if (options.devShell !== null) {
		const script = join(tmp, "devshell.sh");
		writeFileSync(script, options.devShell);
		// The shellHook's chatter would otherwise open every command's output.
		lines.push(`. ${quote(script)} >/dev/null`);
	}
	const env = join(tmp, "env.sh");
	writeFileSync(env, `${lines.join("\n")}\n`);
	const deny = [...new Set([...hidden(platform), options.home ?? homedir(), options.runnerHome])];
	const domains = options.trusted ? [...REGISTRIES] : [];
	return { cwd: options.cwd, repository: options.repository, tmp, env, deny, domains };
}

/**
 * The variables a job's commands keep from the runner's environment, so
 * anything else, such as a cloud credential, stays out of their reach.
 */
const KEPT =
	/^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_\w+|TZ|TERM|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy|SSL_CERT_(FILE|DIR)|NIX_SSL_CERT_FILE|NODE_EXTRA_CA_CERTS|__CF_USER_TEXT_ENCODING)$/;

/** The runner's variables a job's commands may see. */
export function keptEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
	return Object.fromEntries(
		Object.entries(env).filter((entry): entry is [string, string] => KEPT.test(entry[0]) && entry[1] !== undefined),
	);
}

/**
 * sandbox-runtime (`srt`) settings that confine commands as Claude Code's
 * sandbox settings do, which name the checkout's writes implicitly, and keep
 * them from writing `denyWrite`, even where it does not exist yet.
 */
export function runtimeSettings(sandbox: Sandbox, denyWrite: string[] = []): Record<string, unknown> {
	return {
		network: { allowedDomains: sandbox.domains, deniedDomains: [], strictAllowlist: true },
		filesystem: {
			denyRead: sandbox.deny,
			allowRead: [sandbox.cwd, sandbox.repository, sandbox.tmp],
			allowWrite: [sandbox.cwd, sandbox.tmp],
			denyWrite,
		},
		enableWeakerNestedSandbox: false,
	};
}

export function closeSandbox(sandbox: Sandbox): void {
	rmSync(sandbox.tmp, { recursive: true, force: true });
}

/** `value` as one word in a POSIX shell. */
export function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
