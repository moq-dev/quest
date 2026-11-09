// Windows process ownership for the gate. Node offers no Job Object API and libuv's own job lets
// grandchildren break away silently, so a small Bun program joins a job of its own before it starts
// the command: everything the command starts is created inside that job and cannot break away.

/**
 * Runs as `<Bun> --no-env-file -e STUB`, with `BUN_BE_BUN=1` so a compiled Quest runs it as Bun
 * would, but without loading the working directory's `.env` files into the command. The command
 * and the caller's `BUN_BE_BUN` arrive as JSON in `QUEST_GATE_JOB`, since Bun's `process.argv` for
 * `-e` differs between platforms; the stub restores the caller's environment before the command
 * starts.
 *
 * On Windows it creates a job that kills every process left in it once its last handle closes, and
 * joins it. Only the stub holds that handle, so the job ends with the stub: when the command exits,
 * when the gate terminates the stub, or when the gate dies and libuv's own kill-on-close job ends
 * the stub. Once in a job that forbids breakaway, a process stays in it, and so does everything it
 * starts, including detached processes and those that break away from libuv's nested job.
 *
 * The stub waits out console signals, which reach the command directly, so the command's own
 * handling runs. It exits with the command's status, or 127 when the command cannot start, as a
 * shell would, and 128 plus the signal's number for a command a signal stopped. Without a job it
 * warns and still runs the command, as `direct` would.
 *
 * Joined onto one line of single-quoted strings, so it stays one plain command-line argument.
 */
export const STUB = [
	"const { spawn } = require('node:child_process');",
	"const { keep: original, command: [file, ...args] } = JSON.parse(process.env.QUEST_GATE_JOB);",
	"delete process.env.QUEST_GATE_JOB;",
	"if (original === null) delete process.env.BUN_BE_BUN; else process.env.BUN_BE_BUN = original;",
	"if (process.platform === 'win32') {",
	"  const os = require('node:os');",
	"  os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);",
	"  try {",
	"    const { dlopen, FFIType, ptr } = require('bun:ffi');",
	"    const handle = FFIType.u64;",
	"    const { symbols: kernel } = dlopen('kernel32.dll', {",
	"      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: handle },",
	"      SetInformationJobObject: { args: [handle, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },",
	"      AssignProcessToJobObject: { args: [handle, handle], returns: FFIType.i32 },",
	"      GetCurrentProcess: { args: [], returns: handle },",
	"      GetLastError: { args: [], returns: FFIType.u32 },",
	"    });",
	// JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on 64-bit Windows; its LimitFlags sit at
	// offset 16. Class 9 is JobObjectExtendedLimitInformation, and 0x2000 is
	// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. No breakaway flag is set, so none is allowed.
	"    const limits = new BigUint64Array(18);",
	"    new DataView(limits.buffer).setUint32(16, 0x2000, true);",
	"    const job = kernel.CreateJobObjectW(null, null);",
	"    if (!job || !kernel.SetInformationJobObject(job, 9, ptr(limits), 144) || !kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()))",
	"      throw new Error('Windows error ' + kernel.GetLastError());",
	"  } catch (error) {",
	"    process.stderr.write('quest gate: cannot own descendants of the command: ' + error.message + String.fromCharCode(10));",
	"  }",
	"}",
	"for (const name of ['SIGINT', 'SIGBREAK', 'SIGHUP']) process.on(name, () => {});",
	"const child = spawn(file, args, { stdio: 'inherit' });",
	"child.once('error', (error) => {",
	"  process.stderr.write('quest gate: ' + error.message + String.fromCharCode(10));",
	"  process.exit(127);",
	"});",
	"child.once('exit', (code, signal) => process.exit(code ?? 128 + require('node:os').constants.signals[signal]));",
]
	.map((line) => line.trim())
	.join(" ");

/** The stub's command line and environment for running `command` with `env` in a job of its own. */
export function stubbed(command: string[], env: NodeJS.ProcessEnv): [string[], NodeJS.ProcessEnv] {
	return [
		[process.execPath, "--no-env-file", "-e", STUB],
		{ ...env, BUN_BE_BUN: "1", QUEST_GATE_JOB: JSON.stringify({ keep: env.BUN_BE_BUN ?? null, command }) },
	];
}
