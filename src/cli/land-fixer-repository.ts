// Never run Git in a contributor-controlled repository: import regular object files into a fresh bare repo.
import {
	constants,
	closeSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { git } from "./land";

export const MAX_FIXER_BYTES = 100 * 1024 * 1024;
/**
 * Import pr-N's objects. `known` names the packs fetched from `root` at launch: their objects are already in `root`,
 * so they are neither copied nor counted, and the size bound applies to what the fixer added rather than to the
 * repository's history (moq's alone exceeds it). A fixer that rewrote one only leaves its objects out of the import.
 */
export function importFixer(
	root: string,
	state: string,
	checkout: string,
	number: number,
	head: string,
	known: string[] = [],
): void {
	const launched = new Set(known.map((name) => name.replace(/\.pack$/, "")));
	const source = join(checkout, ".git");
	if (!lstatSync(checkout).isDirectory() || !lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink())
		throw new Error("fixer .git must be a real directory");
	let bytes = 0;
	let files = 0;
	const objects: string[] = [];
	const walk = (path: string, relative = "") => {
		for (const name of readdirSync(path)) {
			// Git lock files are transient: a background `git maintenance` or auto-gc can create and remove one
			// while this walks (moq-dev/moq#6987 crashed on a vanished `objects/maintenance.lock`). None is imported.
			if (name.endsWith(".lock")) continue;
			if (++files > 100_000) throw new Error("fixer repository has too many files");
			const child = join(path, name);
			const rel = relative ? `${relative}/${name}` : name;
			const stat = lstatSync(child);
			if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
				throw new Error("fixer git metadata must contain only real files and directories");
			if (stat.isDirectory()) {
				// Submodule repositories are never imported, and gitlinks are protected, so a host that initialized
				// submodules for the dev shell does not count their history (moq.pro's moq) against the bound.
				if (rel !== "modules") walk(child, rel);
			} else if (relative === "objects/pack" && launched.has(name.replace(/\.[a-z]+$/, ""))) continue;
			else {
				bytes += stat.size;
				if (bytes > MAX_FIXER_BYTES) throw new Error("fixer repository exceeds 100 MiB");
				if (/^objects\/(?:[0-9a-f]{2}\/[0-9a-f]{38}|pack\/pack-[0-9a-f]+\.pack)$/.test(rel)) objects.push(rel);
			}
		}
	};
	walk(source);
	for (const path of ["objects/info/alternates", "info/grafts", "shallow"]) {
		const file = join(source, path);
		if (existsSync(file)) unlinkSync(file);
	}
	const read = (path: string) => {
		const fd = openSync(join(source, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > MAX_FIXER_BYTES) throw new Error("invalid fixer metadata file");
			return readFileSync(fd);
		} finally {
			closeSync(fd);
		}
	};
	const ref = `refs/heads/pr-${number}`;
	const actual = existsSync(join(source, ref))
		? read(ref).toString().trim()
		: existsSync(join(source, "packed-refs"))
			? read("packed-refs")
					.toString()
					.split("\n")
					.find((line) => line.endsWith(` ${ref}`))
					?.split(" ")[0]
			: undefined;
	if (actual !== head) throw new Error("result head differs from PR branch or pr-N is missing");
	const clean = mkdtempSync(join(state, "fix-import-"));
	try {
		git(clean, ["init", "--bare", "--quiet"]);
		// The skipped launch packs' objects are the daemon's own: borrow them from its repository, never through
		// any alternates the fixer wrote (deleted above), so the fixer's new commits connect to their history.
		if (launched.size)
			writeFileSync(
				join(clean, "objects", "info", "alternates"),
				`${join(git(root, ["rev-parse", "--absolute-git-dir"]), "objects")}\n`,
			);
		let copied = 0;
		for (const path of objects) {
			const data = read(path);
			copied += data.length;
			if (copied > MAX_FIXER_BYTES) throw new Error("fixer objects exceed 100 MiB");
			const dest = join(clean, path);
			mkdirSync(dirname(dest), { recursive: true });
			writeFileSync(dest, data);
		}
		for (const path of objects.filter((path) => path.endsWith(".pack"))) {
			// Rebuild the index rather than trust the fixer's. Not --strict: one pack may refer to another not yet
			// indexed; fetch.fsckObjects checks every object and link when they reach the daemon's repository.
			git(clean, ["index-pack", join(clean, path)]);
		}
		git(clean, ["update-ref", ref, head]);
		git(root, [
			"-c",
			`safe.directory=${clean}`,
			"-c",
			"fetch.fsckObjects=true",
			"-c",
			"protocol.file.allow=always",
			"fetch",
			"--quiet",
			"--no-tags",
			pathToFileURL(clean).href,
			ref,
		]);
		if (git(root, ["rev-parse", "FETCH_HEAD"]) !== head) throw new Error("imported fixer head differs from result");
	} finally {
		rmSync(clean, { recursive: true, force: true });
	}
}
