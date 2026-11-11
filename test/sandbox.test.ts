import { expect, test } from "vitest";

import { sandboxEnvironment, sandboxSettings, shellScript } from "../src/cli/sandbox";

test("commands keep no credential, and PATH keeps no directory the checkout holds", () => {
	const env = sandboxEnvironment(
		{
			PATH: "/repo/node_modules/.bin:bin:/usr/bin:/repo/.git/hooks:/nix/bin",
			OPENAI_API_KEY: "secret",
			OPENCODE_CONFIG_CONTENT: "{}",
			LANG: "C.UTF-8",
		},
		{ reads: ["/repo", "/repo/.git"], tmp: "/t/tmp" },
	);
	expect(env).toEqual({
		PATH: "/usr/bin:/nix/bin",
		LANG: "C.UTF-8",
		HOME: "/t/tmp",
		TMPDIR: "/t/tmp",
		CLAUDE_CODE_TMPDIR: "/t/tmp",
	});
});

test("commands reach no host, read the homes only where named, and write only the private directory", () => {
	expect(sandboxSettings({ reads: ["/home/u/repo"], tmp: "/tmp/q/tmp" }, "linux", "/home/u")).toEqual({
		network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
		filesystem: {
			denyRead: ["/home", "/root", "/tmp", "/var/tmp", "/run/user", "/home/u"],
			allowRead: ["/home/u/repo", "/tmp/q/tmp"],
			allowWrite: ["/tmp/q/tmp"],
			denyWrite: ["/tmp/claude"],
		},
		enableWeakerNestedSandbox: false,
	});
});

test("the shell runs the command alone under srt, from a cleared environment", () => {
	const script = shellScript("/bin/srt", "/q/srt.json", { HOME: "/q/it's" });
	expect(script).toContain(`exec /usr/bin/env -i 'HOME=/q/it'\\''s' '/bin/srt' --settings '/q/srt.json' -c "$2"`);
	expect(script).toContain(`[ "$1" != -c ]`);
});
