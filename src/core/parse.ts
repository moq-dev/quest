// Strict field checks for the records `quest` sends, so a store never keeps one in part.

/** Checks that throw `malformed <what>: <field>` on any missing, extra, or ill-typed field. */
export function parser(what: string) {
	const fail = (field: string): never => {
		throw new Error(`malformed ${what}: ${field}`);
	};
	const isObject = (value: unknown): value is Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value);
	const text = (value: unknown, field: string): string =>
		typeof value === "string" && value !== "" ? value : fail(field);
	const maybe = (value: unknown, field: string): string | null => (value === null ? null : text(value, field));
	const count = (value: unknown, field: string): number =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fail(field);
	const flag = (value: unknown, field: string): boolean => (typeof value === "boolean" ? value : fail(field));
	const instant = (value: unknown, field: string): string => {
		const at = text(value, field);
		const match = /^(\d{4})-(\d\d)-(\d\d)T\d\d:\d\d:\d\d(\.\d+)?Z$/.exec(at);
		if (!match || Number.isNaN(Date.parse(at))) return fail(field);
		const date = new Date(0);
		date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
		const valid = date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
		return valid ? at : fail(field);
	};
	const oneOf = <T extends string>(value: unknown, options: readonly T[], field: string): T =>
		options.includes(value as T) ? (value as T) : fail(field);
	const exact = (value: Record<string, unknown>, keys: string[], field: string) => {
		const extra = Object.keys(value).find((key) => !keys.includes(key));
		if (extra !== undefined) fail(`${field} has an unknown field ${extra}`);
	};
	const pull = (value: unknown, field: string): number =>
		Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fail(field);
	const repository = (value: unknown, field: string): string => {
		const name = text(value, field);
		return /^[a-z\d._-]+\/[a-z\d._-]+$/.test(name) ? name : fail(`${field} is not a lowercase owner/repo`);
	};
	return { fail, isObject, text, maybe, count, flag, instant, oneOf, exact, pull, repository };
}
