// The OS sandbox an opencode reviewer's commands run in, through sandbox-runtime (`srt`): bubblewrap
// on Linux, Seatbelt on macOS. Commands read the checkout, its Git directory, and a private temporary
// directory, write only that directory, read no account home or shared temporary files, reach no
// network host, and on Linux make no Unix sockets, so not the Nix daemon's either.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { requireProgram } from "./program";

/** Where other users' and this user's private files live, per platform. */
function hidden(platform: NodeJS.Platform): string[] {
	return platform === "darwin"
		? ["/Users", "/var/root", "/tmp", "/private/tmp", "/private/var/folders"]
		: ["/home", "/root", "/tmp", "/var/tmp", "/run/user"];
}

/** The variables commands keep from the reviewer's environment, so a credential stays out of their reach. */
const KEPT =
	/^(PATH|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_\w+|TZ|TERM|SSL_CERT_(FILE|DIR)|NIX_SSL_CERT_FILE|__CF_USER_TEXT_ENCODING)$/;

/** What a sandbox lets commands read and write. */
export interface Paths {
	/** Read only: the checkout and its Git directories. */
	reads: string[];
	/** The private directory, the only one commands write. */
	tmp: string;
}

const inside = (path: string, dir: string) => {
	const rel = relative(dir, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * The whole environment `srt` runs commands with: the kept variables, with
 * HOME and TMPDIR the private directory, and `CLAUDE_CODE_TMPDIR` too, since
 * srt replaces a command's TMPDIR with it, or `/tmp/claude` without it. PATH
 * keeps only absolute directories outside `reads`, so a command such as `git`
 * never resolves to a program the checkout holds.
 */
export function sandboxEnvironment(env: NodeJS.ProcessEnv, paths: Paths): Record<string, string> {
	const kept = Object.fromEntries(
		Object.entries(env).filter((entry): entry is [string, string] => KEPT.test(entry[0]) && entry[1] !== undefined),
	);
	if (kept.PATH !== undefined)
		kept.PATH = kept.PATH.split(":")
			.filter((entry) => isAbsolute(entry) && !paths.reads.some((dir) => inside(entry, dir)))
			.join(":");
	const { tmp } = paths;
	return { ...kept, HOME: tmp, TMPDIR: tmp, CLAUDE_CODE_TMPDIR: tmp };
}

/** srt's settings: no network host, and the account homes and shared temporary directories hidden but `paths`. */
export function sandboxSettings(paths: Paths, platform = process.platform, home = homedir()): Record<string, unknown> {
	return {
		network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
		filesystem: {
			denyRead: [...new Set([...hidden(platform), home])],
			allowRead: [...paths.reads, paths.tmp],
			allowWrite: [paths.tmp],
			// srt binds its own /tmp/claude in whenever it exists, whoever made it, and no
			// denyRead hides it; this keeps commands from writing there, though not from reading it.
			denyWrite: ["/tmp/claude"],
		},
		enableWeakerNestedSandbox: false,
	};
}

/** `value` as one word in a POSIX shell. */
export function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The shell opencode runs every command through, as `<shell> -c <command>`. It
 * starts the command from `env` rather than opencode's own environment, which
 * may hold provider keys.
 */
export function shellScript(srt: string, settings: string, env: Record<string, string>): string {
	const kept = Object.entries(env).map(([name, value]) => quote(`${name}=${value}`));
	return `#!/bin/sh
if [ "$#" -ne 2 ] || [ "$1" != -c ]; then
	echo "usage: $0 -c <command>" >&2
	exit 2
fi
exec /usr/bin/env -i ${kept.join(" ")} ${quote(srt)} --settings ${quote(settings)} -c "$2"
`;
}

/**
 * Why `srt` would let commands make Unix sockets, or null when it refuses
 * them. On Linux, srt refuses them only through its seccomp helper,
 * `apply-seccomp`, and runs commands without it when its package lacks one,
 * as nixpkgs' does. It runs socat under the sandbox's policy and passes only
 * on the filter's own refusal.
 */
export function unixSocketRefusal(srt: string, env: NodeJS.ProcessEnv): string | null {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "quest-probe-")));
	try {
		const paths = { reads: [], tmp: dir };
		const settings = join(dir, "srt.json");
		writeFileSync(settings, JSON.stringify(sandboxSettings(paths, "linux")));
		const probe = spawnSync(
			srt,
			["--settings", settings, "-c", `exec socat -u OPEN:/dev/null UNIX-CONNECT:${quote(join(dir, "missing"))}`],
			{ cwd: dir, env: sandboxEnvironment(env, paths), stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
		);
		if (
			!probe.error &&
			probe.status !== 0 &&
			/\bsocket\(1, \d+, \d+\): Operation not permitted$/m.test(probe.stderr)
		)
			return null;
		const said =
			probe.error?.message ?? (probe.stderr.trim().split("\n").at(-1) || `exit ${probe.status ?? probe.signal}`);
		if (/\bconnect\(.*\): No such file or directory$/m.test(probe.stderr))
			return `${srt} lets commands make Unix sockets, such as the Nix daemon's: it has no seccomp helper (apply-seccomp, which it looks for in its package's vendor/seccomp/). Use sandbox-runtime from npm, which ships it, or this repository's dev shell, which builds it`;
		return `could not check that ${srt} keeps commands from making Unix sockets (${said})`;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** A round's sandbox: the shell opencode runs commands through. */
export interface Sandbox {
	shell: string;
	/**
	 * Holds the shell, its settings, and in `tmp/` the commands' HOME and
	 * TMPDIR, the only part commands write; `close` removes it.
	 */
	dir: string;
	close(): void;
}

/**
 * Make a sandbox whose commands read `reads`. It sits directly in the
 * temporary directory, since srt's bridge sockets live in it and a socket path
 * is at most 104 bytes on macOS. Refuses an `srt` missing from PATH, or one
 * that would let commands make Unix sockets.
 */
export function openSandbox(reads: string[], env: NodeJS.ProcessEnv): Sandbox {
	const srt = requireProgram("srt", env);
	if (process.platform === "linux") {
		const refused = unixSocketRefusal(srt, env);
		if (refused !== null) throw new Error(refused);
	}
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "quest-review-")));
	const paths = { reads, tmp: join(dir, "tmp") };
	mkdirSync(paths.tmp, { mode: 0o700 });
	const settings = join(dir, "srt.json");
	writeFileSync(settings, JSON.stringify(sandboxSettings(paths)), { mode: 0o600 });
	const shell = join(dir, "sandboxed-sh");
	writeFileSync(shell, shellScript(srt, settings, sandboxEnvironment(env, paths)), { mode: 0o700 });
	return { shell, dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}
