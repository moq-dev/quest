// Entries kept on disk by an opaque key, private to their user and bounded by size, shared by concurrent processes.
import { mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A store of `T` by a hex SHA-256 key. */
export interface DiskCache<T> {
	get(key: string): Promise<T | undefined>;
	set(key: string, entry: T): Promise<void>;
}

/**
 * A {@link DiskCache} of one JSON file per entry in `directory`, which `parse` checks on read, so another version's
 * or a damaged entry is only a miss. Writes rename a finished file into place, so concurrent processes never read a
 * partial entry. Each process sums the directory on its first write, whenever its writes since would pass `limit`,
 * and after every eighth of `limit` it writes, so other processes' writes are counted too, evicting the least
 * recently used down to three quarters of `limit` once past it. Concurrent writers can each pass `limit` by up to an
 * eighth of it until the next sum; summing on every write would hold it exactly, at about 100 ms a write for a full
 * directory. An entry over an eighth of `limit` is not kept.
 */
export function diskCache<T>(directory: string, parse: (value: unknown) => T | undefined, limit: number): DiskCache<T> {
	/** The directory's size at this process's last sum, undefined before the first, and bytes written since. */
	let summed: number | undefined;
	let written = 0;
	const path = (key: string) => {
		if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`invalid cache key: ${key}`);
		return join(directory, key);
	};
	const evict = async () => {
		const entries: { file: string; size: number; used: number }[] = [];
		for (const name of await readdir(directory)) {
			const file = join(directory, name);
			const info = await stat(file).catch(missing);
			if (info) entries.push({ file, size: info.size, used: info.mtimeMs });
		}
		let total = entries.reduce((sum, entry) => sum + entry.size, 0);
		if (total > limit) {
			entries.sort((a, b) => a.used - b.used);
			for (const entry of entries) {
				if (total <= (limit * 3) / 4) break;
				await unlink(entry.file).catch(missing);
				total -= entry.size;
			}
		}
		summed = total;
		written = 0;
	};
	return {
		async get(key) {
			const file = path(key);
			const text = await readFile(file, "utf8").catch(missing);
			if (text === undefined) return undefined;
			let entry: T | undefined;
			try {
				entry = parse(JSON.parse(text));
			} catch {
				entry = undefined;
			}
			if (entry === undefined) {
				await unlink(file).catch(missing);
				return undefined;
			}
			const now = new Date();
			await utimes(file, now, now).catch(missing);
			return entry;
		},
		async set(key, entry) {
			const file = path(key);
			const text = JSON.stringify(entry);
			const size = Buffer.byteLength(text);
			if (size > limit / 8) return;
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
			await writeFile(temporary, text, { mode: 0o600 });
			// Another process's eviction may take the file first, and on Windows a rename over an entry another
			// writer or reader holds open fails with EPERM, EACCES, or EBUSY; the entry is then just not kept.
			await rename(temporary, file).catch(async (error) => {
				await unlink(temporary).catch(missing);
				if (process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error?.code)) return;
				missing(error);
			});
			written += size;
			if (summed === undefined || summed + written > limit || written > limit / 8) await evict();
		},
	};
}

/** `undefined` for a file another process removed, rethrowing anything else. */
function missing(error: unknown): undefined {
	if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
	throw error;
}
