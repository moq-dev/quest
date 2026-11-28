import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

// A Windows path's drive colon breaks the colon-separated PATH of POSIX directories these definitions are built from.
const posix = test.skipIf(process.platform === "win32");

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

/** Dependencies on a mock clock, where the launchd job stays listed until `listedMs` pass after the bootout. */
function deps(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, listedMs = 0) {
	const ran: string[] = [];
	let clock = 0;
	let booted: number | null = null;
	return {
		ran,
		deps: {
			platform,
			env,
			uid: 501,
			run: (command: string, args: string[]) => void ran.push([command, ...args].join(" ")),
			tryRun: (command: string, args: string[]) => {
				ran.push(`try ${[command, ...args].join(" ")}`);
				if (args[0] === "bootout") booted = clock;
				return args[0] === "print" && booted !== null && clock - booted < listedMs;
			},
			now: () => clock,
			sleep: (ms: number) => void (clock += ms),
		},
	};
}

posix("on Linux, the sender is a systemd user service running quest from PATH, escaped", () => {
	const env: NodeJS.ProcessEnv = { ...user(), QUEST_KIXEL_URL: "http://localhost:8787" };
	const { deps: linux, ran } = deps("linux", env);
	const path = installSender(linux);
	expect(path).toBe(join(env.XDG_CONFIG_HOME!, "systemd", "user", "quest-records.service"));
	const unit = readFileSync(path, "utf8");
	const bin = env.PATH!.split(":")[1]!;
	expect(unit).toContain(`ExecStart="${bin.replace("%", "%%").replace("$", () => "$$")}/quest" records sender`);
	expect(unit).toContain(`Environment="PATH=${env.PATH!.replace("%", "%%")}"`);
	expect(unit).toContain(`Environment="XDG_STATE_HOME=${env.XDG_STATE_HOME}"`);
	expect(unit).toContain(`Environment="XDG_CONFIG_HOME=${env.XDG_CONFIG_HOME}"`);
	expect(unit).not.toContain("CODEX_HOME");
	// Each queued record names its own Kixel Quest, so the service needs none.
	expect(unit).not.toContain("QUEST_KIXEL_URL");
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

posix("on macOS, the sender is a launchd agent, replaced on reinstall", () => {
	const env: NodeJS.ProcessEnv = { ...user(), PATH: `${user().PATH}:/a&b` };
	const { deps: mac, ran } = deps("darwin", env);
	const path = installSender(mac);
	expect(path).toBe(join(env.HOME!, "Library", "LaunchAgents", "dev.moq.quest.records.plist"));
	const plist = readFileSync(path, "utf8");
	expect(plist).toContain("<string>records</string><string>sender</string>");
	expect(plist).toContain("/a&amp;b</string>");
	expect(plist).toContain(`<key>XDG_STATE_HOME</key><string>${env.XDG_STATE_HOME}</string>`);
	expect(plist).toContain("<key>KeepAlive</key><true/>");
	expect(ran).toEqual([
		"try launchctl bootout gui/501/dev.moq.quest.records",
		"try launchctl print gui/501/dev.moq.quest.records",
		`launchctl bootstrap gui/501 ${path}`,
	]);
});

posix("on macOS, a reinstall waits for launchd to drop the stopping job before bootstrapping", () => {
	const print = "try launchctl print gui/501/dev.moq.quest.records";
	const bootout = "try launchctl bootout gui/501/dev.moq.quest.records";
	// Listed for two polls, then gone.
	const quick = deps("darwin", user(), 500);
	const path = installSender(quick.deps);
	expect(quick.ran).toEqual([bootout, print, print, print, `launchctl bootstrap gui/501 ${path}`]);
	// Listed past ExitTimeOut, until launchd SIGKILLs and reaps the job within the grace.
	const slow = deps("darwin", user(), 22_000);
	installSender(slow.deps);
	expect(slow.ran.at(-1)).toMatch(/^launchctl bootstrap/);
	// Never dropped: an error, and no bootstrap.
	const stuck = deps("darwin", user(), Infinity);
	expect(() => installSender(stuck.deps)).toThrow(
		"still lists gui/501/dev.moq.quest.records 25 seconds after bootout",
	);
	expect(stuck.ran.some((line) => line.includes("bootstrap"))).toBe(false);
});

test("installing fails loud without quest on PATH or a supported service manager", () => {
	expect(() => serviceDefinition("linux", { ...user(), PATH: "/nonexistent" })).toThrow("quest is not on PATH");
	expect(() => installSender(deps("win32", user()).deps)).toThrow("which win32 lacks");
});
