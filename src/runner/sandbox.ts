// The OS sandbox every job's commands run in: bubblewrap on Linux, Seatbelt
// on macOS, through Claude Code's own sandbox or, for opencode, the same
// sandbox-runtime run as its shell. Commands write only to the
// job's checkout and a private temporary directory, read no account home,
// runner state, or shared temporary files, and have no Nix daemon. A trusted
// revision's commands reach only the package registries; an untrusted one's
// reach no network host. The project's devShell is evaluated by the runner from the
// job's revision, never the checkout an agent edited, and its environment,
// shellHook included, is sourced inside the sandbox before each command.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * An AppArmor profile that lets `bwrap` and the commands it runs make user
 * namespaces on a system restricting unprivileged ones, as Ubuntu 23.10 and
 * later do: the form Ubuntu gives other programs that sandbox themselves.
 * Ubuntu's own `bwrap-userns-restrict` takes capabilities from the commands
 * bwrap runs, which breaks the seccomp helper Claude Code runs inside it, since
 * that makes a nested user namespace for its capabilities. The job's commands
 * still get none of their own: the helper's filter refuses them one, and
 * bubblewrap does where sandbox-runtime runs no helper. It attaches to one exact
 * path rather than a glob, since anyone who can build with Nix can put a
 * matching name in the store.
 */
export function bwrapProfile(bwrap: string): string {
	return `abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile quest-bwrap ${bwrap} flags=(unconfined) {\n  userns,\n}\n`;
}

/** Whether AppArmor keeps unprivileged user namespaces to programs whose profile allows them. */
function restrictsUserNamespaces(): boolean {
	try {
		return readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim() === "1";
	} catch {
		return false;
	}
}

/** Namespaces as Claude Code's sandbox and sandbox-runtime make them, around `command`. */
function namespaces(command: string[]): string[] {
	return [
		"--new-session",
		"--die-with-parent",
		"--unshare-user",
		"--unshare-pid",
		"--unshare-net",
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		...command,
	];
}

/**
 * Why `bwrap` cannot make a sandbox here, or null when it can, so a runner
 * refuses to start rather than fail every job. It runs a trivial command in
 * the sandbox's namespaces, nested in a second bwrap, since Claude Code's
 * seccomp helper makes a nested user namespace inside the sandbox.
 */
export function sandboxRefusal(bwrap: string, restricted: boolean = restrictsUserNamespaces()): string | null {
	const probe = spawnSync(bwrap, namespaces([bwrap, ...namespaces(["true"])]), {
		stdio: ["ignore", "ignore", "pipe"],
		encoding: "utf8",
		timeout: 10_000,
	});
	if (!probe.error && probe.status === 0) return null;
	const said =
		probe.error?.message ?? (probe.stderr.trim().split("\n").at(-1) || `exit ${probe.status ?? probe.signal}`);
	return refusalReason(bwrap, said, restricted);
}

/**
 * The refusal for a `bwrap` that failed the probe saying `said`. Where AppArmor
 * restricts user namespaces, it carries the profile to install for a bwrap in
 * the Nix store, such as the runner package's. A system bwrap gets none, since
 * AppArmor attaches neither of two profiles for one path, and the distribution
 * may already ship one for it, as Ubuntu does for `/usr/bin/bwrap`.
 */
export function refusalReason(bwrap: string, said: string, restricted: boolean): string {
	const reason = `${bwrap} cannot make the sandbox's namespaces (${said})`;
	if (!restricted)
		return `${reason}; jobs run their commands in a bubblewrap sandbox, which needs unprivileged user namespaces`;
	const apparmor = `${reason}. AppArmor allows unprivileged user namespaces only to programs whose profile grants them`;
	if (!bwrap.startsWith("/nix/store/"))
		return `${apparmor}; run the flake's runner package (\`nix run github:moq-dev/quest#runner -- runner\`), which prints the profile for its own bubblewrap`;
	return (
		`${apparmor}; install this profile for the runner's bubblewrap, then start the runner again:\n\n` +
		`sudo tee /etc/apparmor.d/quest-bwrap >/dev/null <<'EOF'\n${bwrapProfile(bwrap)}EOF\n` +
		"sudo apparmor_parser -r /etc/apparmor.d/quest-bwrap"
	);
}

export function closeSandbox(sandbox: Sandbox): void {
	rmSync(sandbox.tmp, { recursive: true, force: true });
}

/** `value` as one word in a POSIX shell. */
export function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
