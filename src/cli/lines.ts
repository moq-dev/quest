// Reading a log too large to hold, line by line.
import { closeSync, openSync, readSync } from "node:fs";

/**
 * Visit each line of the file at `path`, reading it in bounded chunks since logs reach gigabytes. The last line is
 * marked incomplete when no newline ends it, as while its session is still writing it. Reading stops once `visit`
 * returns false.
 */
export function eachLine(path: string, visit: (line: string, complete: boolean) => boolean | void): void {
	const fd = openSync(path, "r");
	try {
		const chunk = Buffer.alloc(1 << 22);
		let rest = Buffer.alloc(0);
		for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) {
			const data = rest.length ? Buffer.concat([rest, chunk.subarray(0, read)]) : chunk.subarray(0, read);
			let start = 0;
			for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
				if (end > start && visit(data.toString("utf8", start, end), true) === false) return;
				start = end + 1;
			}
			rest = Buffer.from(data.subarray(start));
		}
		if (rest.length) visit(rest.toString("utf8"), false);
	} finally {
		closeSync(fd);
	}
}
