// Stops the systemd scopes a test starts and leaves running. A scope outlives the process that
// started it, so a test that fails or times out, or a run signalled mid-test (a cancelled
// `quest gate` delivers its signal to every process in the test run), would leave it running.

import { afterEach, beforeAll } from "vitest";

type Supervise = typeof import("../src/cli/supervise");

/** The scopes this file started whose run has not ended. A run that rejects may still hold processes, so it stays. */
const live = new Set<string>();
let supervise: Supervise | undefined;

// Loaded once the test file has registered its mocks, so they apply to the module the tests share.
beforeAll(async () => {
	const loaded = await import("../src/cli/supervise");
	const start = loaded.systemdScopes.run;
	loaded.systemdScopes.run = async (unit, ...rest) => {
		live.add(unit);
		const result = await start(unit, ...rest);
		live.delete(unit);
		return result;
	};
	supervise = loaded;
});

// Stops what a failed or timed-out test left, and the gates bound to it; one failure never hides the rest.
afterEach(async () => {
	const units = [...live];
	// A unit leaves only once stopped, so a later hook or the signal handler retries one whose stop failed.
	const stops = await Promise.allSettled(
		units.map(async (unit) => {
			await supervise!.systemdScopes.stop(unit);
			live.delete(unit);
		}),
	);
	const failed = stops.flatMap((stop) => (stop.status === "rejected" ? [stop.reason] : []));
	if (failed.length) throw new AggregateError(failed, `cannot stop ${failed.length} of ${units.length} test scopes`);
});

// A signalled run never reaches afterEach: kill the scopes, then die of the signal.
if (process.platform === "linux")
	for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const)
		process.once(signal, () => {
			for (const unit of live) {
				// One scope that cannot be killed must not spare the rest, nor keep the run alive.
				try {
					const group = supervise!.scopeGroup(unit);
					if (group) supervise!.kill(group);
				} catch (error) {
					process.stderr.write(`cannot kill test scope ${unit}: ${error}\n`);
				}
			}
			process.kill(process.pid, signal);
		});
