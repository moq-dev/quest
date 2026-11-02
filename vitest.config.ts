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
	test: live
		? { include: ["test/live/**/*.test.ts"], testTimeout: 30 * 60_000, hookTimeout: 60_000 }
		: { include: ["test/**/*.test.ts"], exclude: [...configDefaults.exclude, "test/live/**"] },
});
