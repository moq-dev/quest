// `quest setup` against temporary Claude Code settings.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { BASH_MAX_TIMEOUT_MS, claudeSettings, setup } from "../src/cli/setup";
import { tempDir } from "./fixture";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("setup creates missing settings and is idempotent", () => {
	const path = join(tempDir(), "profile", "settings.json");
	expect(setup(path)).toEqual([`${path}: env.BASH_MAX_TIMEOUT_MS=${BASH_MAX_TIMEOUT_MS}`]);
	expect(read(path)).toEqual({ env: { BASH_MAX_TIMEOUT_MS } });
	expect(setup(path)).toEqual([]);
});

test("setup keeps other settings and replaces a different cap", () => {
	const path = join(tempDir(), "settings.json");
	writeFileSync(path, JSON.stringify({ theme: "dark", env: { FOO: "1", BASH_MAX_TIMEOUT_MS: "600000" } }));
	expect(setup(path)).toEqual([`${path}: env.BASH_MAX_TIMEOUT_MS=${BASH_MAX_TIMEOUT_MS} (was "600000")`]);
	expect(read(path)).toEqual({ theme: "dark", env: { FOO: "1", BASH_MAX_TIMEOUT_MS } });
});

test("setup refuses malformed settings without writing", () => {
	const dir = tempDir();
	for (const content of ["{", "[]", '{"env":"x"}']) {
		const path = join(dir, "settings.json");
		writeFileSync(path, content);
		expect(() => setup(path)).toThrow();
		expect(readFileSync(path, "utf8")).toBe(content);
	}
});

test("settings live under CLAUDE_CONFIG_DIR when set", () => {
	expect(claudeSettings({ CLAUDE_CONFIG_DIR: "/profile" })).toBe(join("/profile", "settings.json"));
});
