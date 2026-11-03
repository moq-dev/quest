// Run each Worker test case in its own vitest process. The suite shares one
// runtime and resets only storage between tests (vitest.config.ts), so a test
// can still lean on module-level state another left behind. Each case alone is
// too slow for every PR (seconds of startup apiece), so a scheduled CI job runs
// this instead. Cases declared on one line, such as a loop's, run together.
//
//   bun scripts/isolated.ts [--jobs N] [filter...]
//
// Filters keep the cases whose file path contains one of them. Run it after
// `bun run build`, as `vitest run` is.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

const root = join(import.meta.dirname, "..");
const { values, positionals: filters } = parseArgs({
	options: { jobs: { type: "string", default: String(Math.max(1, Math.floor(availableParallelism() / 2))) } },
	allowPositionals: true,
});
const jobs = Number(values.jobs);
if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`--jobs must be a positive integer, not ${values.jobs}`);

/** Run vitest with `args` in the Worker's directory, returning its exit code and combined output. */
function vitest(args: string[]) {
	return new Promise<{ code: number; output: string }>((resolve, reject) => {
		const child = spawn("bun", ["x", "vitest", ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (chunk) => (output += chunk));
		child.stderr.on("data", (chunk) => (output += chunk));
		child.on("error", reject);
		child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), output }));
	});
}

// Every case's location, from vitest's own collection.
const scratch = mkdtempSync(join(tmpdir(), "quest-isolated-"));
let cases: string[];
try {
	const file = join(scratch, "cases.json");
	const listed = await vitest(["list", `--json=${file}`]);
	if (listed.code !== 0) {
		process.stderr.write(listed.output);
		throw new Error("vitest list failed");
	}
	const tests = JSON.parse(readFileSync(file, "utf8")) as { file: string; location?: { line: number } }[];
	cases = [
		...new Set(
			tests.map((test) => {
				if (!test.location) throw new Error(`vitest listed ${test.file} without a location`);
				return `${relative(root, test.file)}:${test.location.line}`;
			}),
		),
	].filter((location) => !filters.length || filters.some((filter) => location.includes(filter)));
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
if (!cases.length) throw new Error("No test cases matched");

console.log(`Running ${cases.length} test cases, each in its own process, ${jobs} at a time.`);
const failed: string[] = [];
let done = 0;
const queue = [...cases];
await Promise.all(
	Array.from({ length: Math.min(jobs, queue.length) }, async () => {
		for (let location = queue.shift(); location; location = queue.shift()) {
			// A location matching no test fails too, so a stale listing cannot pass.
			const { code, output } = await vitest(["run", location]);
			done++;
			if (code === 0) continue;
			failed.push(location);
			console.log(`\n✗ ${location} (${done}/${cases.length})\n${output}`);
		}
	}),
);

if (failed.length) {
	console.log(`\n${failed.length} of ${cases.length} test cases failed on their own:`);
	for (const location of failed.sort()) console.log(`  ${location}`);
	process.exit(1);
}
console.log(`All ${cases.length} test cases passed on their own.`);
