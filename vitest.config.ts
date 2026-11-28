import { configDefaults, defineConfig } from "vitest/config";

// Tests spawn `process.execPath` with Bun's own flags and loaders. Under Node, as `bunx vitest`
// runs it by following vitest's shebang, those children die at once and each test that waits on
// them hangs to its timeout, so refuse the run up front.
if (process.versions.bun === undefined)
	throw new Error("the tests run on Bun: use `just test` or `bun run test`, not `bunx vitest` or `npx vitest`");

// `test/live` runs the real agent CLIs, so it runs only with QUEST_LIVE=1, and
// alone: `just review-sandbox` on the user's logins. A reviewer turn takes
// minutes; its timeout only bounds a hung CLI.
const live = process.env.QUEST_LIVE === "1";

export default defineConfig({
	plugins: [
		// Bun loads Markdown assets as text (bunfig.toml); load them the same way here.
		{
			name: "markdown-text",
			transform(code, id) {
				if (id.endsWith(".md")) return { code: `export default ${JSON.stringify(code)};`, map: null };
			},
		},
	],
	test: {
		// Git reads none of the caller's own configuration, such as commit signing
		// with a key or program the fixtures cannot reach; each fixture sets its identity.
		// Git for Windows maps "/dev/null" to its null device but rejects os.devNull's "\\.\nul".
		// An agent session's ID would log the gates tests run as that session's waits (src/cli/waits.ts).
		// The developer's own quest login would send reads to Kixel Quest where it serves this repository.
		// Each test gets its own XDG_STATE_HOME and XDG_CONFIG_HOME (test/state.ts).
		// An exported QUEST_FORGE=github would skip the Kixel Quest fakes the forge tests serve.
		// A `quest run` task inherits QUEST_GATE_GROUP=1, which would tell the gates under test that an
		// enclosing owner signals their group, so the signal tests would wait for signals that never come.
		env: {
			GIT_CONFIG_GLOBAL: "/dev/null",
			QUEST_FORGE: "",
			QUEST_GATE_GROUP: "",
			CLAUDE_CODE_SESSION_ID: "",
			CODEX_THREAD_ID: "",
		},
		...(live
			? {
					include: ["test/live/**/*.test.ts"],
					setupFiles: ["test/state.ts"],
					testTimeout: 30 * 60_000,
					hookTimeout: 60_000,
				}
			: {
					include: ["test/**/*.test.ts"],
					exclude: [...configDefaults.exclude, "test/live/**"],
					// A test's CPU budget (test/budget.ts) bounds how slow it may be; this wall-clock
					// limit only catches a test awaiting what never comes, so a loaded host never reaches it.
					setupFiles: ["test/state.ts", "test/budget.ts"],
					globalSetup: ["test/scopes.ts", "test/fixers.ts"],
					testTimeout: 5 * 60_000,
					hookTimeout: 5 * 60_000,
				}),
	},
});
