import { devNull } from "node:os";

import { defineConfig } from "vitest/config";

// Bun loads Markdown assets as text (bunfig.toml); load them the same way here.
export default defineConfig({
	plugins: [
		{
			name: "markdown-text",
			transform(code, id) {
				if (id.endsWith(".md")) return { code: `export default ${JSON.stringify(code)};`, map: null };
			},
		},
	],
	test: {
		include: ["test/**/*.test.ts"],
		// Git reads none of the caller's own configuration, such as commit signing
		// with a key or program the fixtures cannot reach; each fixture sets its identity.
		env: { GIT_CONFIG_GLOBAL: devNull },
	},
});
