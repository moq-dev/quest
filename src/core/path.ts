// Repository-relative POSIX paths as plain strings. The core runs in Workers
// as well as Node, so it cannot use `node:path`.

/** The path's components: empty and `.` segments dropped, `..` kept as written. */
function parts(path: string): string[] {
	return path.split("/").filter((part) => part !== "" && part !== ".");
}

/**
 * Collapse `..` textually. Resolving against the filesystem would need the
 * file to exist, which is the very thing a link check tests.
 *
 * A `..` with nothing left to pop is kept, so `a/../../b` stays `../b`: letting
 * repeated `..` cancel each other made a link that climbed above the root walk
 * back down to a real file.
 */
export function normalize(path: string): string {
	const absolute = path.startsWith("/");
	const out: string[] = [];
	for (const part of parts(path)) {
		if (part !== "..") {
			out.push(part);
		} else if (out.length > 0 && out[out.length - 1] !== "..") {
			out.pop();
		} else if (!absolute) {
			out.push("..");
		}
	}
	return (absolute ? "/" : "") + out.join("/");
}

/** `a/b` joined to `c`, normalized. */
export function join(base: string, path: string): string {
	return normalize(base === "" ? path : `${base}/${path}`);
}

/** The directory holding `path`, or `""` for a top-level name. */
export function parent(path: string): string {
	const index = path.lastIndexOf("/");
	return index < 0 ? "" : path.slice(0, index);
}

/** The last component of `path`. */
export function fileName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** The number of components in `path`. */
export function depth(path: string): number {
	return parts(path).length;
}

/**
 * Whether the normalized `path` leaves its root: it climbs above it, or it is
 * still absolute, as `//quest/a.md` is once its leading `/` is stripped.
 * GitHub reads that as a link to the host `quest`, not to a file.
 */
export function escapes(path: string): boolean {
	return path === ".." || path.startsWith("../") || path.startsWith("/");
}

/**
 * Path order, which is also the quest tree's order: component by component, so
 * `a/b.md` sorts before `a-b.md` the way a directory listing walks them, with a
 * directory's `README.md` first, since an epic precedes its children, and each
 * run of digits compared by value, so the milestone `m10` follows `m9`.
 */
export function comparePaths(a: string, b: string): number {
	const left = a.split("/");
	const right = b.split("/");
	for (let i = 0; i < Math.min(left.length, right.length); i++) {
		if (left[i] === right[i]) continue;
		if (left[i] === "README.md" || right[i] === "README.md") return left[i] === "README.md" ? -1 : 1;
		const [x, y] = [numbered(left[i]), numbered(right[i])];
		if (x !== y) return x < y ? -1 : 1;
		return left[i] < right[i] ? -1 : 1;
	}
	return left.length - right.length;
}

/** A name with each run of digits zero-padded, so comparing two compares their numbers by value. */
function numbered(name: string): string {
	return name.replace(/\d+/g, (digits) => digits.padStart(20, "0"));
}
