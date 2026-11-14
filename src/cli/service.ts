// Installing the per-user record sender as a systemd user service or a launchd agent, so the service manager runs
// exactly one and restarts it.
import { accessSync, constants, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import { stateDirectory } from "./send";

/** The systemd unit and launchd label the sender runs as. */
const UNIT = "quest-records.service";
const LABEL = "dev.moq.quest.records";

/** What installing the sender reads and runs. */
export interface ServiceDependencies {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	/** The user's ID, for launchd's per-user domain. */
	uid: number;
	/** Run a service manager command, throwing when it fails. */
	run(command: string, args: string[]): void;
	/** Run one whose failure is expected, such as stopping a service that is not loaded. */
	tryRun(command: string, args: string[]): void;
}

const home = (env: NodeJS.ProcessEnv) => env.HOME || homedir();

function supported(platform: NodeJS.Platform): "linux" | "darwin" {
	if (platform === "linux" || platform === "darwin") return platform;
	throw new Error(`the record sender runs as a systemd user service or a launchd agent, which ${platform} lacks`);
}

/** Where the service's definition lives. */
export function servicePath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
	return supported(platform) === "linux"
		? join(env.XDG_CONFIG_HOME || join(home(env), ".config"), "systemd", "user", UNIT)
		: join(home(env), "Library", "LaunchAgents", `${LABEL}.plist`);
}

/** `quest` as PATH finds it, unresolved, so an upgrade that moves the target behind a profile link is followed. */
function questOnPath(env: NodeJS.ProcessEnv): string {
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!isAbsolute(dir)) continue;
		const path = join(dir, "quest");
		try {
			accessSync(path, constants.X_OK);
			return path;
		} catch {
			// Not here.
		}
	}
	throw new Error("quest is not on PATH, so no service can run it");
}

const xml = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** systemd's quoting for one word, its specifiers and, for ExecStart, its variables escaped. */
const systemdWord = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
const execWord = (text: string) => systemdWord(text).replace(/\$/g, "$$$$");

/**
 * What the sender reads beyond PATH, kept from the installer's environment, since the service manager's may lack
 * them: where the hooks queue and the tokens live, where token-max finds transcripts, and gh's login. Secrets such
 * as GH_TOKEN are never written into the definition.
 */
const KEPT = ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GH_CONFIG_DIR"];

/**
 * The service definition running `quest records sender` with the installer's PATH, so it finds token-max, gh, and the
 * runtime `quest` needs, as the hooks do, and the directories `KEPT` names.
 */
export function serviceDefinition(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
	const kind = supported(platform);
	const quest = questOnPath(env);
	const vars: [string, string][] = [["PATH", env.PATH ?? ""]];
	for (const name of KEPT) if (env[name]) vars.push([name, env[name]!]);
	if (kind === "linux")
		return [
			"[Unit]",
			"Description=Send agent session records (quest records sender)",
			"",
			"[Service]",
			`ExecStart=${execWord(quest)} records sender`,
			...vars.map(([name, value]) => `Environment=${systemdWord(`${name}=${value}`)}`),
			"Restart=always",
			"RestartSec=60",
			"",
			"[Install]",
			"WantedBy=default.target",
			"",
		].join("\n");
	const log = join(stateDirectory(env), "sender.log");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array><string>${xml(quest)}</string><string>records</string><string>sender</string></array>
	<key>EnvironmentVariables</key>
	<dict>${vars.map(([name, value]) => `<key>${name}</key><string>${xml(value)}</string>`).join("")}</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>60</integer>
	<key>ProcessType</key><string>Background</string>
	<key>StandardOutPath</key><string>${xml(log)}</string>
	<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** Write the sender's service and (re)start it, so a reinstall after an upgrade runs the new `quest`. */
export function installSender(deps: ServiceDependencies): string {
	const path = servicePath(deps.platform, deps.env);
	const definition = serviceDefinition(deps.platform, deps.env);
	mkdirSync(join(path, ".."), { recursive: true });
	mkdirSync(stateDirectory(deps.env), { recursive: true, mode: 0o700 });
	writeFileSync(path, definition);
	if (deps.platform === "linux") {
		deps.run("systemctl", ["--user", "daemon-reload"]);
		deps.run("systemctl", ["--user", "enable", UNIT]);
		deps.run("systemctl", ["--user", "restart", UNIT]);
	} else {
		deps.tryRun("launchctl", ["bootout", `gui/${deps.uid}/${LABEL}`]);
		deps.run("launchctl", ["bootstrap", `gui/${deps.uid}`, path]);
	}
	return path;
}

/** Stop the sender and remove its service; queued records stay until a sender runs again. */
export function uninstallSender(deps: ServiceDependencies): string | null {
	const path = servicePath(deps.platform, deps.env);
	if (!existsSync(path)) return null;
	if (deps.platform === "linux") {
		deps.run("systemctl", ["--user", "disable", "--now", UNIT]);
		rmSync(path);
		deps.run("systemctl", ["--user", "daemon-reload"]);
	} else {
		deps.tryRun("launchctl", ["bootout", `gui/${deps.uid}/${LABEL}`]);
		rmSync(path);
	}
	return path;
}
