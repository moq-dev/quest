// Credentials belong only to trusted Git subprocesses, never repository configuration or child trees.
import { type RemoteRead, tryGit } from "./land";

export function gitAuthentication(token: string): Record<string, string> {
	return {
		GIT_CONFIG_COUNT: "2",
		GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
		GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
		GIT_CONFIG_KEY_1: "credential.helper",
		GIT_CONFIG_VALUE_1: "",
	};
}

/** Refresh before expiry, and retry an authentication refusal once with a newly minted token. */
export function authenticatedRead(mint: () => Promise<string>, now = Date.now): RemoteRead {
	let cached: { token: string; until: number } | undefined;
	return async (root, args) => {
		if (!(["fetch", "ls-remote"].includes(args[0]) && args.some((arg) => arg.startsWith("https://github.com/"))))
			throw new Error("authenticated reads require a GitHub HTTPS fetch or ls-remote");
		for (let attempt = 0; ; attempt++) {
			if (!cached || now() >= cached.until) cached = { token: await mint(), until: now() + 50 * 60_000 };
			const result = tryGit(root, args, { env: gitAuthentication(cached.token) });
			if (result.status === 0) return result.stdout.trim();
			if (
				attempt === 0 &&
				/authentication failed|HTTP (?:401|403)|requested URL returned error: (?:401|403)|invalid username or (?:password|token)/i.test(
					result.stderr,
				)
			) {
				cached = undefined;
				continue;
			}
			// Git errors can include the remote URL, but the token exists only in the environment above.
			throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
		}
	};
}
