import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { hostedForge } from "../src/cli/forge";
import { HELPER, credential, helperKey } from "../src/cli/git-credential";
import { type LoginDependencies, TRANSCRIPTS_QUESTION, login, logout } from "../src/cli/login";
import { kixelPath, kixelUrl, tokenFor, tokensPath } from "../src/cli/tokens";
import { tempDir } from "./fixture";
import { FakeLogin, KIXEL, REPOSITORY, writeTokens } from "./kixel-fakes";

/** A host about to sign in to the fake, answering `answer` to the transcripts question, approved after `pending` polls. */
function host(server: FakeLogin, answer: string | null = "n", env: NodeJS.ProcessEnv = user(), pending = 2) {
	let now = 0;
	const said: string[] = [];
	const asked: string[] = [];
	const deps: LoginDependencies = {
		env,
		fetch: server.fetch,
		now: () => now,
		sleep: async (ms) => {
			now += ms;
			if (server.polls === pending) server.approve();
		},
		hostname: "workstation",
		ask: async (question) => {
			asked.push(question);
			return answer;
		},
		say: (line) => said.push(line),
	};
	return { deps, env, said, asked, clock: () => now };
}

/** A user signing in to the fake, with a global git config of their own and none of the caller's environment. */
const user = (): NodeJS.ProcessEnv => {
	const home = tempDir();
	return {
		PATH: process.env.PATH,
		XDG_CONFIG_HOME: join(home, ".config"),
		GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		QUEST_KIXEL_URL: KIXEL,
	};
};

test("an approved code stores a token named after the host", async () => {
	const server = new FakeLogin();
	const { deps, env, said, asked, clock } = host(server);
	expect(await login(deps)).toEqual({
		url: KIXEL,
		label: "workstation",
		transcripts: false,
		git: [`${helperKey(KIXEL)} = ""`, `${helperKey(KIXEL)} = ${HELPER}`],
	});
	expect(asked).toEqual([TRANSCRIPTS_QUESTION]);
	expect(server.labels).toEqual(["workstation"]);
	expect(said).toEqual([
		`Open ${KIXEL}/login, sign in with GitHub, and enter the code BCDF-GHJK.`,
		"Waiting for its approval; the code expires in 10 minutes.",
	]);
	// Asked at the interval the code names: twice pending, then approved.
	expect(server.polls).toBe(3);
	expect(clock()).toBe(15_000);
	expect(tokenFor(KIXEL, env)).toBe("issued-1");
});

// Windows has no POSIX modes: a file reads as 0o666 whatever it was created with.
test.skipIf(process.platform === "win32")("the token file is readable only by the user", async () => {
	const { deps, env } = host(new FakeLogin());
	await login(deps);
	expect(statSync(tokensPath(env)).mode & 0o777).toBe(0o600);
});

test("only a yes uploads transcripts, and no answer signs nothing in", async () => {
	for (const [answer, transcripts] of [
		["y", true],
		[" YES ", true],
		["", false],
		["sure", false],
	] as const) {
		const { deps, env } = host(new FakeLogin(), answer);
		expect((await login(deps)).transcripts).toBe(transcripts);
		expect(JSON.parse(readFileSync(tokensPath(env), "utf8"))[KIXEL].transcripts).toBe(transcripts);
	}
	const server = new FakeLogin();
	const { deps, env } = host(server, null);
	await expect(login(deps)).rejects.toThrow("no answer to whether to upload transcripts");
	expect(server.labels).toEqual([]);
	expect(existsSync(tokensPath(env))).toBe(false);
});

test("a code nobody approves expires, storing nothing", async () => {
	const server = new FakeLogin();
	const { deps, env, clock } = host(server, "n", user(), Infinity);
	await expect(login(deps)).rejects.toThrow("the code expired before anyone approved it; run `quest login` again");
	expect(server.polls).toBe(119);
	expect(clock()).toBe(600_000);
	expect(existsSync(tokensPath(env))).toBe(false);
});

test("an answer quest cannot trust or read fails the login", async () => {
	for (const [code, error] of [
		[{ verification_uri: "" }, "verification_uri is not a string"],
		[{ interval: 0 }, "interval is not a positive whole number"],
		[{ expires_in: "600" }, "expires_in is not a positive whole number"],
	] as const) {
		const { deps } = host(new FakeLogin(KIXEL, code));
		await expect(login(deps)).rejects.toThrow(error);
	}
	const { deps } = host(new FakeLogin());
	deps.hostname = "";
	await expect(login(deps)).rejects.toThrow(`${KIXEL}/login/device answered HTTP 400: invalid_request`);
	const expired = host(new FakeLogin());
	expired.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
		String(input).endsWith("/login/token")
			? new Response(JSON.stringify({ error: "expired_token" }), { status: 400 })
			: new FakeLogin().fetch(input, init)) as typeof fetch;
	await expect(login(expired.deps)).rejects.toThrow("the code expired");
});

test("signing in again replaces this Kixel Quest's token and keeps another's", async () => {
	const env = user();
	writeTokens(env, { [KIXEL]: "old", "https://kixel.quest": "theirs" });
	await login(host(new FakeLogin(), "y", env).deps);
	expect(tokenFor(KIXEL, env)).toBe("issued-1");
	expect(tokenFor("https://kixel.quest", env)).toBe("theirs");
});

test("logout removes the token, after which a command needing Kixel Quest names quest login", async () => {
	const env = user();
	await login(host(new FakeLogin(), "n", env).deps);
	writeTokens(env, { [KIXEL]: "mine", "https://kixel.quest": "theirs" });
	expect(logout(env)).toEqual({ url: KIXEL, removed: true });
	expect(tokenFor(KIXEL, env)).toBeNull();
	expect(tokenFor("https://kixel.quest", env)).toBe("theirs");
	const deps = { env, fetch, now: () => 0, sleep: async () => {}, github: () => ({}) as never, warn: () => {} };
	expect(() => hostedForge(REPOSITORY, deps)).toThrow(
		`Kixel Quest hosts example/project, but this host is not signed in to ${KIXEL}; run \`quest login\``,
	);
	expect(logout(env)).toEqual({ url: KIXEL, removed: false });
	expect(logout({ ...env, QUEST_KIXEL_URL: "https://kixel.quest" }).removed).toBe(true);
	expect(JSON.parse(readFileSync(tokensPath(env), "utf8"))).toEqual({});
});

test("a token file an earlier quest wrote is moved once, uploading no transcripts", () => {
	const env = user();
	const old = join(dirname(tokensPath(env)), "records.json");
	mkdirSync(dirname(old), { recursive: true });
	writeFileSync(old, JSON.stringify({ [KIXEL]: "pasted", "https://kixel.quest": "theirs" }));
	expect(tokenFor(KIXEL, env)).toBe("pasted");
	expect(JSON.parse(readFileSync(tokensPath(env), "utf8"))).toEqual({
		[KIXEL]: { token: "pasted", transcripts: false },
		"https://kixel.quest": { token: "theirs", transcripts: false },
	});
	expect(existsSync(old)).toBe(false);
	expect(logout(env).removed).toBe(true);
	expect(tokenFor(KIXEL, env)).toBeNull();
});

test("a malformed sign-ins file fails, naming it", () => {
	const env = user();
	mkdirSync(dirname(tokensPath(env)), { recursive: true });
	for (const [content, error] of [
		["{", "is not JSON"],
		["[]", "does not hold an object by Kixel Quest URL"],
		[JSON.stringify({ [KIXEL]: "bare" }), `the sign-in to ${KIXEL} is not {"token"`],
		[JSON.stringify({ [KIXEL]: { token: "t" } }), `the sign-in to ${KIXEL} is not {"token"`],
		[JSON.stringify({ [KIXEL]: { token: "", transcripts: false } }), `the sign-in to ${KIXEL} is not {"token"`],
	]) {
		writeFileSync(tokensPath(env), content!);
		expect(() => tokenFor(KIXEL, env)).toThrow(`${tokensPath(env)}`);
		expect(() => tokenFor(KIXEL, env)).toThrow(error!);
	}
});

const bin = fileURLToPath(new URL("../src/cli/bin.ts", import.meta.url));
const bunfig = fileURLToPath(new URL("../bunfig.toml", import.meta.url));

/** What `git credential fill` answers for `url` as `env`'s user, with this checkout's quest on PATH. */
function fill(env: NodeJS.ProcessEnv, url: string) {
	const tools = tempDir();
	writeFileSync(join(tools, "quest"), `#!/bin/sh\nexec bun --config='${bunfig}' '${bin}' "$@"\n`);
	chmodSync(join(tools, "quest"), 0o755);
	const { protocol, host } = new URL(url);
	return spawnSync("git", ["credential", "fill"], {
		encoding: "utf8",
		input: `protocol=${protocol.slice(0, -1)}\nhost=${host}\n\n`,
		env: { ...env, PATH: `${tools}${delimiter}${env.PATH}`, GIT_TERMINAL_PROMPT: "0" },
	});
}

describe.skipIf(process.platform === "win32")("git's sign-in", () => {
	test("login answers git for its Kixel Quest alone, and logout leaves the config as before", async () => {
		const env = user();
		// The person's own helpers, global and for this URL, which the empty entry masks without deleting.
		const before = `[credential]\n\thelper = cache\n[credential "${KIXEL}"]\n\thelper = osxkeychain\n[user]\n\tname = Someone\n`;
		writeFileSync(env.GIT_CONFIG_GLOBAL!, before);
		await login(host(new FakeLogin(), "n", env).deps);
		const answered = fill(env, `${KIXEL}/example/project.git`);
		expect(answered.stdout, answered.stderr).toBe(
			"protocol=http\nhost=localhost:8787\nusername=quest\npassword=issued-1\n",
		);
		// Quest's helper is configured for this URL alone, so another host is not answered.
		expect(fill(env, "https://example.com/other.git").stdout).not.toContain("password=");
		// Signing in again adds no entries, and the helper reads the token on every call.
		await login(host(new FakeLogin(), "n", env).deps);
		expect(readFileSync(env.GIT_CONFIG_GLOBAL!, "utf8").match(/helper = !quest/g)).toHaveLength(1);
		writeTokens(env, { [KIXEL]: "rotated" });
		expect(fill(env, KIXEL).stdout).toContain("password=rotated\n");
		expect(logout(env).removed).toBe(true);
		expect(readFileSync(env.GIT_CONFIG_GLOBAL!, "utf8")).toBe(before);
		const signedOut = fill(env, KIXEL);
		expect(signedOut.stdout).not.toContain("password=");
		expect(logout(env).removed).toBe(false);
	});

	test("a git config quest cannot write fails login, naming the entries, and one declaring them already passes", async () => {
		const env = user();
		const entries = `${helperKey(KIXEL)} = "", ${helperKey(KIXEL)} = ${HELPER}`;
		const home = dirname(env.GIT_CONFIG_GLOBAL!);
		env.GIT_CONFIG_GLOBAL = join(home, "missing", ".gitconfig");
		await expect(login(host(new FakeLogin(), "n", env).deps)).rejects.toThrow(
			`could not write git's global credential entries for ${KIXEL} (${entries})`,
		);
		// Logout finds none of quest's entries, so it writes nothing and removes the token.
		expect(logout(env).removed).toBe(true);
		// A read-only config declaring the entries, as home-manager links into place.
		const declared = join(home, "declared");
		mkdirSync(declared);
		env.GIT_CONFIG_GLOBAL = join(declared, ".gitconfig");
		writeFileSync(env.GIT_CONFIG_GLOBAL, `[credential "${KIXEL}/"]\n\thelper =\n\thelper = ${HELPER}\n`);
		chmodSync(declared, 0o555);
		try {
			await login(host(new FakeLogin(), "n", env).deps);
			expect(fill(env, KIXEL).stdout).toContain("password=issued-1\n");
			expect(() => logout(env)).toThrow(
				`could not remove git's global credential entries for ${KIXEL} (${entries})`,
			);
			expect(tokenFor(KIXEL, env)).toBe("issued-1");
		} finally {
			chmodSync(declared, 0o755);
		}
	});

	test("login and logout leave every helper the person listed for the URL where it was", async () => {
		const env = user();
		// An empty reset, an escaped multi-line helper, and URL sections on either side of a global one.
		const before =
			`[credential "${KIXEL}"]\n\thelper = \n\thelper = "!f() { echo; }\\nf"\n` +
			`[credential]\n\thelper = store\n[credential "${KIXEL}"]\n\thelper = cache\n`;
		writeFileSync(env.GIT_CONFIG_GLOBAL!, before);
		expect(logout(env).removed).toBe(false);
		expect(readFileSync(env.GIT_CONFIG_GLOBAL!, "utf8")).toBe(before);
		await login(host(new FakeLogin(), "n", env).deps);
		await login(host(new FakeLogin(), "n", env).deps);
		expect(readFileSync(env.GIT_CONFIG_GLOBAL!, "utf8")).toBe(
			`${before}[credential "${KIXEL}/"]\n\thelper = \n\thelper = ${HELPER}\n`,
		);
		expect(fill(env, KIXEL).stdout).toContain("password=issued-1\n");
		expect(logout(env).removed).toBe(true);
		expect(readFileSync(env.GIT_CONFIG_GLOBAL!, "utf8")).toBe(before);
	});
});

test("the helper answers only get, and without a token tells git to stop, naming quest login", () => {
	const env = user();
	writeTokens(env, { [KIXEL]: "mine" });
	const warned: string[] = [];
	const request = "protocol=http\nhost=localhost:8787\npath=example/project.git\n\n";
	expect(credential("get", request, env, (line) => warned.push(line))).toBe("username=quest\npassword=mine\n");
	expect(credential("store", `${request}username=quest\npassword=mine\n`, env, () => {})).toBe("");
	expect(credential("erase", request, env, () => {})).toBe("");
	const written = "protocol=http\nhost=LOCALHOST:8787\n\n";
	expect(credential("get", written, env, () => {})).toBe("username=quest\npassword=mine\n");
	writeTokens(env, { "https://kixel.quest": "theirs", [KIXEL]: "mine" });
	expect(credential("get", "protocol=https\nhost=kixel.quest:443\n", env, () => {})).toBe(
		"username=quest\npassword=theirs\n",
	);
	writeTokens(env, { [KIXEL]: "mine" });
	expect(credential("get", "protocol=https\nhost=kixel.quest\n", env, (line) => warned.push(line))).toBe("quit=1\n");
	expect(warned).toEqual(["this host is not signed in to https://kixel.quest; run `quest login`"]);
	writeTokens(env, { [KIXEL]: "two\nlines" });
	expect(credential("get", request, env, (line) => warned.push(line))).toBe("quit=1\n");
	expect(warned.at(-1)).toBe(`the token this host holds for ${KIXEL} is not one line; run \`quest login\``);
});

test("a Kixel Quest URL is its origin, as git names it", () => {
	expect(kixelUrl({ QUEST_KIXEL_URL: "https://Kixel.Quest:443/" })).toBe("https://kixel.quest");
	expect(kixelUrl({ QUEST_KIXEL_URL: "http://localhost:8787" })).toBe(KIXEL);
	expect(() => kixelUrl({ QUEST_KIXEL_URL: "https://kixel.quest/prefix" })).toThrow("is not an origin");
	expect(kixelPath("https://Kixel.Quest:443/o/r/pull/1?x#y", "https://kixel.quest")).toBe("o/r/pull/1?x#y");
	expect(kixelPath("https://kixel.quest.example/o/r", "https://kixel.quest")).toBeNull();
	expect(kixelPath("o/r", "https://kixel.quest")).toBeNull();
});
