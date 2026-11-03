import { configDefaults, defineConfig } from "vitest/config";

// `test/live` runs the real agent CLIs on the user's logins, so it runs only
// with QUEST_LIVE=1, as `just review-sandbox` sets, and alone. A reviewer turn
// takes minutes; its timeout only bounds a hung CLI.
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
		env: { GIT_CONFIG_GLOBAL: "/dev/null" },
		...(live
			? { include: ["test/live/**/*.test.ts"], testTimeout: 30 * 60_000, hookTimeout: 60_000 }
			: { include: ["test/**/*.test.ts"], exclude: [...configDefaults.exclude, "test/live/**"] }),
	},
});
