// Launch a program that receives credentials by absolute path, never from the
// directory it runs in, on POSIX and native Windows alike.
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { spawnSync } from "node:child_process";

/** Arguments ready for `spawn` or `execFileSync`. */
export interface Command {
	file: string;
	args: string[];
	/** Set when `args` are already quoted for cmd.exe, which Node must then pass unchanged. */
	windowsVerbatimArguments: boolean;
}

/** A variable, matched case-insensitively on Windows as Windows itself matches `Path`. */
function variable(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
	if (platform !== "win32") return env[name];
	return Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
}

/** Extensions Windows can start: programs, and batch files such as npm's `.cmd` shims. */
const LAUNCHABLE = /^\.(com|exe|bat|cmd)$/i;
const BATCH = /\.(bat|cmd)$/i;

function launchable(path: string, platform: NodeJS.Platform): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		if (platform !== "win32") accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * An executable on PATH, as an absolute path with symlinks resolved, trying
 * PATHEXT's launchable extensions on Windows. Relative PATH entries are
 * skipped, and so is the current directory, which Windows searches before
 * PATH: a checkout could otherwise supply its own `claude` and receive a key.
 */
export function which(name: string, env: NodeJS.ProcessEnv): string | undefined {
	const platform = process.platform;
	const path = platform === "win32" ? win32 : posix;
	const extensions =
		platform === "win32"
			? (variable(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD")
					.split(";")
					.filter((ext) => LAUNCHABLE.test(ext))
			: [""];
	for (const entry of (variable(env, "PATH", platform) ?? "").split(path.delimiter)) {
		// Windows accepts a quoted PATH entry, such as one holding a semicolon.
		const dir = platform === "win32" ? entry.replace(/^"(.*)"$/, "$1") : entry;
		if (!path.isAbsolute(dir)) continue;
		for (const ext of extensions) {
			const candidate = path.join(dir, name + ext);
			if (launchable(candidate, platform)) return realpathSync(candidate);
		}
	}
	return undefined;
}

/** `which`, or an error naming the missing program. */
export function requireProgram(name: string, env: NodeJS.ProcessEnv): string {
	const found = which(name, env);
	if (found === undefined) throw new Error(`${name} is not installed: no ${name} on PATH`);
	return found;
}

/** A file in Windows' System32, found from SystemRoot rather than searched for. */
function system32(env: NodeJS.ProcessEnv, file: string): string {
	const root = variable(env, "SYSTEMROOT", "win32") ?? "C:\\Windows";
	if (!win32.isAbsolute(root)) throw new Error(`SystemRoot is not an absolute path: ${root}`);
	return win32.join(root, "System32", file);
}

/** Characters cmd.exe treats specially outside quotes, each escaped with `^`. */
const META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Quote `arg` for a batch file's `%*`: the C runtime's quoting, then `^`
 * before every metacharacter twice, since cmd.exe parses the line once for
 * `/c` and again where the batch file expands `%*`. The approach follows
 * cross-spawn. A line break ends the command and `%` expands a variable
 * before any escape applies, so neither is accepted.
 */
export function batchArgument(arg: string): string {
	if (/[\r\n\0%]/.test(arg)) throw new Error(`cannot pass a line break or % to a Windows batch file: ${arg}`);
	const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
	return quoted.replace(META, "^$1").replace(META, "^$1");
}

/**
 * How to run `program` with `args`. On Windows a batch file, such as the
 * `.cmd` shim npm installs, runs through System32's cmd.exe, since Windows
 * starts only programs and Node refuses to start a batch file without a shell.
 */
export function programCommand(
	program: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): Command {
	if (platform !== "win32" || !BATCH.test(program)) return { file: program, args, windowsVerbatimArguments: false };
	if (/[\r\n\0%"]/.test(program)) throw new Error(`cannot run a Windows batch file from this path: ${program}`);
	const line = [`"${program}"`, ...args.map(batchArgument)].join(" ");
	// /d skips AutoRun commands, /v:off keeps `!` literal, and /s takes the quoted line as is.
	return {
		file: system32(env, "cmd.exe"),
		args: ["/d", "/v:off", "/s", "/c", `"${line}"`],
		windowsVerbatimArguments: true,
	};
}

/**
 * Signal `pid`, ignoring a process that has already exited. Windows has no
 * signals: there the process and its descendants, such as the agent a batch
 * shim started, are terminated at once.
 */
export function signalProcess(pid: number, signal: NodeJS.Signals, env: NodeJS.ProcessEnv = process.env): void {
	if (process.platform === "win32") {
		spawnSync(system32(env, "taskkill.exe"), ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
		return;
	}
	try {
		process.kill(pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}
