import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { installSender, serviceDefinition, uninstallSender } from "../src/cli/service";
import { tempDir } from "./fixture";

/** A user whose PATH holds an executable `quest` in a directory named `bin`, with a `%` and `$` to escape. */
function user(): NodeJS.ProcessEnv {
	const bin = join(tempDir(), "b%in$x");
	mkdirSync(bin);
	writeFileSync(join(bin, "quest"), "#!/bin/sh\n");
	chmodSync(join(bin, "quest"), 0o755);
	return { HOME: tempDir(), XDG_CONFIG_HOME: tempDir(), XDG_STATE_HOME: tempDir(), PATH: `relative:${bin}:/usr/bin` };
}

function deps(platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
	const ran: string[] = [];
	return {
		ran,
		deps: {
			platform,
			env,
			uid: 501,
			run: (command: string, args: string[]) => void ran.push([command, ...args].join(" ")),
			tryRun: (command: string, args: string[]) => void ran.push(`try ${[command, ...args].join(" ")}`),
		},
	};
}

test("on Linux, the sender is a systemd user service running quest from PATH, escaped", () => {
	const env = user();
	const { deps: linux, ran } = deps("linux", env);
	const path = installSender(linux);
	expect(path).toBe(join(env.XDG_CONFIG_HOME!, "systemd", "user", "quest-records.service"));
	const unit = readFileSync(path, "utf8");
	const bin = env.PATH!.split(":")[1]!;
	expect(unit).toContain(`ExecStart="${bin.replace("%", "%%").replace("$", () => "$$")}/quest" records sender`);
	expect(unit).toContain(`Environment="PATH=${env.PATH!.replace("%", "%%")}"`);
	expect(unit).toContain("Restart=always");
	expect(ran).toEqual([
		"systemctl --user daemon-reload",
		"systemctl --user enable quest-records.service",
		"systemctl --user restart quest-records.service",
	]);
	ran.length = 0;
	expect(uninstallSender(linux)).toBe(path);
	expect(existsSync(path)).toBe(false);
	expect(ran).toEqual(["systemctl --user disable --now quest-records.service", "systemctl --user daemon-reload"]);
	expect(uninstallSender(linux)).toBeNull();
});

test("on macOS, the sender is a launchd agent, replaced on reinstall", () => {
	const env: NodeJS.ProcessEnv = { ...user(), PATH: `${user().PATH}:/a&b` };
	const { deps: mac, ran } = deps("darwin", env);
	const path = installSender(mac);
	expect(path).toBe(join(env.HOME!, "Library", "LaunchAgents", "dev.moq.quest.records.plist"));
	const plist = readFileSync(path, "utf8");
	expect(plist).toContain("<string>records</string><string>sender</string>");
	expect(plist).toContain("/a&amp;b</string>");
	expect(plist).toContain("<key>KeepAlive</key><true/>");
	expect(ran).toEqual(["try launchctl bootout gui/501/dev.moq.quest.records", `launchctl bootstrap gui/501 ${path}`]);
});

test("installing fails loud without quest on PATH or a supported service manager", () => {
	expect(() => serviceDefinition("linux", { ...user(), PATH: "/nonexistent" })).toThrow("quest is not on PATH");
	expect(() => installSender(deps("win32", user()).deps)).toThrow("which win32 lacks");
});
