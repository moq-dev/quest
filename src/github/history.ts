// A PR's repository history read from GitHub's REST API, for the core's check of base merges.
import type { History, Repository, TreeEntry } from "../core";
import { type GitHubReader, array, object, repositoryPath, string } from "./client";

const TYPES = ["blob", "tree", "commit"];

/** `repository` as {@link History} reads it, with `repository.base` as the base branch. */
export function history(github: GitHubReader, repository: Repository & { base: string }): History {
	const path = repositoryPath(repository);
	const get = async (route: string) => object(await (await github.request(`${path}${route}`)).json());
	// `per_page=1` keeps the commits GitHub lists short; only the comparison's summary is read.
	const compare = (from: string, to: string) => get(`/compare/${from}...${to}?per_page=1`);
	return {
		async commit(sha) {
			const commit = await get(`/git/commits/${sha}`);
			return {
				tree: string(object(commit.tree).sha),
				parents: array(commit.parents).map((parent) => string(parent.sha)),
			};
		},
		async tree(oid) {
			const tree = await get(`/git/trees/${oid}`);
			if (tree.truncated !== false) throw new Error(`GitHub lists only part of tree ${oid}`);
			return new Map(
				array(tree.tree).map((entry): [string, TreeEntry] => {
					const type = string(entry.type);
					if (!TYPES.includes(type)) throw new Error(`tree ${oid} holds an entry of type ${type}`);
					return [
						string(entry.path),
						{ type: type as TreeEntry["type"], mode: string(entry.mode), oid: string(entry.sha) },
					];
				}),
			);
		},
		async blob(oid) {
			// The reader decodes every body as text, so the bytes come base64-encoded in JSON.
			const blob = await get(`/git/blobs/${oid}`);
			if (blob.encoding !== "base64") throw new Error(`GitHub sent blob ${oid} as ${String(blob.encoding)}`);
			return Uint8Array.from(atob(string(blob.content).replace(/\n/g, "")), (char) => char.charCodeAt(0));
		},
		async mergeBase(a, b) {
			const compared = await compare(a, b);
			if (compared.merge_base_commit == null) return null;
			const base = string(object(compared.merge_base_commit).sha);
			if (base === a) return base;
			// GitHub names one merge base even where several exist. Its counts are git's (`git rev-list --count b..a`),
			// so it is the only one when `a` holds as many commits `b` lacks as commits it lacks: every commit both
			// reach is one it reaches.
			const lacks = (await compare(base, a)).ahead_by;
			if (typeof compared.behind_by !== "number" || typeof lacks !== "number")
				throw new Error(`GitHub sent no commit counts comparing ${a} with ${b}`);
			return lacks === compared.behind_by ? base : null;
		},
		async onBase(sha) {
			const status = (await compare(encodeURIComponent(repository.base), sha)).status;
			return status === "behind" || status === "identical";
		},
	};
}
