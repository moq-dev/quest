// A fixer resolution GitHub refused to publish travels in the handback comment, and a maintainer's checkout rebuilds it.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
	GitHub,
	type GitHubDependencies,
	type PullRequest,
	object,
	remoteRepository,
	requireRemote,
	string,
} from "./github";
import { contains, git, gitEnvironment, tryGit } from "./land";
import { Refusal } from "./start";

/** GitHub refuses a comment body longer than this many characters. */
export const COMMENT_LIMIT = 65_536;

/**
 * A validated fix as data: the PR head and base it merges, the tree it must produce, and the fixer's edits as a
 * gzipped, base64 patch against the merge's conflicted result, so it stays as small as the resolution itself.
 */
export interface Resolution {
	head: string;
	base: string;
	tree: string;
	patch: string;
}

const SHA = "[0-9a-f]{40}(?:[0-9a-f]{24})?";
const DATA = new RegExp(
	`<!-- quest land apply v1 head=(${SHA}) base=(${SHA}) tree=(${SHA}) patch=([A-Za-z0-9+/]*={0,2}) -->`,
);

/**
 * Settings the merge's conflicted result depends on, pinned so the daemon's bare repository and a maintainer's
 * checkout write the same tree. Attributes would pick merge drivers and conversions, so they come from the empty tree.
 */
function pinned(root: string): string[] {
	const empty = git(root, ["mktree"], { input: "" });
	return [
		`--attr-source=${empty}`,
		"-c",
		"merge.conflictStyle=merge",
		"-c",
		"merge.renames=true",
		"-c",
		"merge.directoryRenames=conflict",
		"-c",
		"merge.renormalize=false",
	];
}

/** The tree `git merge-tree` writes for merging `base` into `head`, conflict markers included. */
export function conflicted(root: string, head: string, base: string): string {
	const merged = tryGit(root, [
		...pinned(root),
		"merge-tree",
		"--write-tree",
		"--name-only",
		"--no-messages",
		head,
		base,
	]);
	const tree = merged.stdout.split("\n")[0];
	if ((merged.status !== 0 && merged.status !== 1) || !new RegExp(`^${SHA}$`).test(tree))
		throw new Error(`cannot merge ${base} into ${head}: ${merged.stderr.trim()}`);
	return tree;
}

/** Run trusted git on bytes, since a patch need not be UTF-8. */
function bytes(root: string, args: string[], input?: Buffer, env: Record<string, string> = {}): Buffer {
	const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd: root,
		input,
		env: { ...gitEnvironment(), ...env },
		maxBuffer: 1 << 30,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
	return result.stdout;
}

/** The fixed head as a resolution of `base` merged into `head`, or nothing when it does not contain that base. */
export function resolution(root: string, head: string, base: string, fixed: string): Resolution | undefined {
	if (!contains(root, base, fixed)) return undefined;
	const patch = bytes(root, [
		"diff",
		"--binary",
		"--full-index",
		"--no-renames",
		"--no-ext-diff",
		"--no-textconv",
		"--no-color",
		"--no-relative",
		"--src-prefix=a/",
		"--dst-prefix=b/",
		conflicted(root, head, base),
		fixed,
	]);
	return { head, base, tree: git(root, ["rev-parse", `${fixed}^{tree}`]), patch: gzipSync(patch).toString("base64") };
}

/** The handback's section carrying `resolution`, or a plain handback when it would not fit in `room` characters. */
export function resolutionSection(number: number, resolution: Resolution, room: number): string {
	const { head, base, tree, patch } = resolution;
	const text =
		`\n\nGitHub refused the fixer's push, so its validated resolution travels in this comment: PR head \`${head}\`, ` +
		`base \`${base}\`, resolved tree \`${tree}\`. A maintainer session rebuilds the commit with ` +
		`\`quest land apply ${number}\`, reviews it, pushes it to the PR branch, and picks the PR again.` +
		`\n\n<!-- quest land apply v1 head=${head} base=${base} tree=${tree} patch=${patch} -->`;
	if (text.length <= room) return text;
	return `\n\nThe fixer's resolution is too large for a comment (${patch.length} characters encoded), so redo the merge by hand.`;
}

/** The resolution a handback comment carries. */
export function parseResolution(body: string): Resolution | undefined {
	const match = DATA.exec(body);
	return match ? { head: match[1], base: match[2], tree: match[3], patch: match[4] } : undefined;
}

/** Merge the resolution's base into its head, apply its patch, and return the tree, refusing any other tree. */
export function rebuild(root: string, resolution: Resolution): string {
	const index = resolve(root, git(root, ["rev-parse", "--git-path", `quest-land-apply-${process.pid}.index`]));
	const env = { GIT_INDEX_FILE: index };
	try {
		git(root, ["read-tree", conflicted(root, resolution.head, resolution.base)], { env });
		const patch = gunzipSync(Buffer.from(resolution.patch, "base64"));
		if (patch.length)
			bytes(root, ["-c", "apply.whitespace=nowarn", "apply", "--cached", "--binary", "-"], patch, env);
		const tree = git(root, ["write-tree"], { env });
		if (tree !== resolution.tree)
			throw new Refusal(
				`the rebuilt tree ${tree} differs from the fixer's ${resolution.tree}; this Git's merge differs from the daemon's, so redo the merge by hand`,
			);
		return tree;
	} finally {
		rmSync(index, { force: true });
	}
}

/** Git as the maintainer runs it, with their credentials, identity, and signing; hooks stay off. */
function userGit(root: string, args: string[], input?: string): string {
	const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd: root,
		input,
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

/** The command that pushes `applied`, each argument shell-quoted: a contributor names the branch. */
export function pushCommand(applied: Applied): string {
	const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
	return ["git", "push", applied.remote, `${applied.commit}:refs/heads/${applied.branch}`].map(quote).join(" ");
}

export interface Applied {
	commit: string;
	/** Where the maintainer pushes the commit: the PR's head repository and branch. */
	remote: string;
	branch: string;
}

/**
 * Rebuild the commit a quest land fixer handed back because GitHub refused its push: the latest resolution an App
 * posted on the PR, while the PR's head is still the one it resolved. The commit is left unpushed.
 */
export async function apply(root: string, pr: PullRequest, deps: GitHubDependencies): Promise<Applied> {
	const github = new GitHub(deps);
	const path = `/repos/${pr.owner}/${pr.repo}`;
	const url = `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;
	// Only an App can post as a `[bot]` login, so a contributor cannot plant a resolution; the fixer's own
	// handback marker sets it apart from another App quoting one.
	const found = (await github.all(`${path}/issues/${pr.number}/comments?per_page=100`))
		.filter(
			(item) =>
				item.user != null &&
				String(object(item.user).login).endsWith("[bot]") &&
				String(item.body ?? "").includes("<!-- quest land fixer: "),
		)
		.flatMap((item) => parseResolution(String(item.body ?? "")) ?? [])
		.at(-1);
	if (!found) throw new Refusal(`${url} carries no quest land fixer resolution`);
	const pull = object(await (await github.request(`${path}/pulls/${pr.number}`)).json());
	if (pull.state !== "open") throw new Refusal(`${url} is not open`);
	const head = object(pull.head);
	if (string(head.sha) !== found.head)
		throw new Refusal(
			`${url}'s head moved to ${string(head.sha)} since the fixer resolved ${found.head}; redo the merge`,
		);
	if (head.repo == null) throw new Refusal(`${url}'s head repository is gone`);

	const origin = remoteRepository(requireRemote(root, "origin"));
	const same =
		origin.repository?.owner.toLowerCase() === pr.owner.toLowerCase() &&
		origin.repository.repo.toLowerCase() === pr.repo.toLowerCase();
	// GitHub keeps every PR's head in the base repository, a fork's included.
	userGit(root, [
		"fetch",
		"--quiet",
		"--no-tags",
		"--no-write-fetch-head",
		same ? origin.url : `https://github.com/${pr.owner}/${pr.repo}.git`,
		found.head,
		found.base,
	]);
	const tree = rebuild(root, found);
	const parents = contains(root, found.base, found.head) ? [found.head] : [found.head, found.base];
	const branch = string(head.ref);
	const commit = userGit(
		root,
		["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])],
		`Merge ${found.base} into ${branch}\n\nThe quest land fixer's resolution, rebuilt by \`quest land apply\` after GitHub refused the fixer's push.\n`,
	);
	const holder = object(head.repo);
	return {
		commit,
		remote: `https://github.com/${string(object(holder.owner).login)}/${string(holder.name)}.git`,
		branch,
	};
}
