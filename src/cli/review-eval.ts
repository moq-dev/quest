// `quest eval`: score the reviewer on a repository's past PRs. Culprits, whose defects a later fix located,
// measure how many defects it finds; clean PRs, which broke nothing, measure how many findings it raises on code
// that needed none. Each case is reviewed at its PR's last head with the prompts `quest review` gives, the review
// rules of the checkout running the eval, and this build's reviewer table, so a change to any of them is scored
// before it lands.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SIZES, type Size, TIERS, type Tier } from "../core";
import { parser } from "../core/parse";
import { GitHub, type GitHubDependencies, type Repository, object, repositoryPath } from "../github/client";
import type { HarnessName } from "./agent";
import { git } from "./git";
import { remoteRepository, requireRemote } from "./github";
import type { Model } from "./models";
import { recorded } from "./models-record";
import {
	type Assessment,
	type Finding,
	ReviewInputError,
	SEVERITIES,
	type Usage,
	baseInstructions,
	classify,
	firstRound,
	pickReviewer,
	reviewSize,
	shadowOf,
} from "./review";
import type { Session } from "./usage";

/** Where a repository keeps its set, from its root. */
export const EVAL_FILE = "review-eval.json";

/** Lines of a file at a culprit's head, first and last inclusive. */
export interface Place {
	file: string;
	from: number;
	to: number;
}

/** A culprit's defect, as the fix that repaired it shows. */
export interface Defect {
	/** The PR whose `## Caused by` names the culprit. */
	fix: number;
	/** One sentence on what was wrong. */
	what: string;
	/** Each place the defect is at the culprit's head, such as two call sites; a finding on any of their lines finds it. */
	at: Place[];
}

/** One past PR, as its last head was reviewed. */
export interface EvalCase {
	pull: number;
	/** The merge base of the head with its base branch: the change is `base..head`. */
	base: string;
	head: string;
	size: Size;
	/** The head's tier as the classifier set it, which the reviewer is told and may raise. */
	tier: Tier;
	reason: string;
	/** The model of its latest Implementer line, which the size's pick avoids, or null when it names none. */
	writer: string | null;
	/** Its defects, at least one; absent on a clean PR. */
	defects?: Defect[];
	/** A PR that broke nothing, on which every finding is noise. */
	clean?: true;
}

/** A repository's eval set. */
export interface EvalSet {
	/** Lowercase `owner/repo`, whose PRs the cases are. */
	repository: string;
	cases: EvalCase[];
}

const SHA = /^[0-9a-f]{40}$/;

/** `value` as an eval set, failing on any missing, extra, or ill-typed field, or a case neither culprit nor clean. */
export function parseEvalSet(value: unknown): EvalSet {
	const { fail, isObject, text, oneOf, exact, pull, repository } = parser("eval set");
	const sha = (value: unknown, field: string) => (SHA.test(text(value, field)) ? (value as string) : fail(field));
	const line = (value: unknown, field: string) =>
		Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fail(field);
	if (!isObject(value)) return fail("not an object");
	exact(value, ["repository", "cases"], "the set");
	if (!Array.isArray(value.cases)) return fail("cases");
	const seen = new Set<number>();
	const cases = value.cases.map((item: unknown): EvalCase => {
		if (!isObject(item)) return fail("a case");
		const number = pull(item.pull, "a case's pull");
		const at = `case #${number}`;
		exact(item, ["pull", "base", "head", "size", "tier", "reason", "writer", "defects", "clean"], at);
		if (seen.has(number)) fail(`${at} is listed twice`);
		seen.add(number);
		const each: EvalCase = {
			pull: number,
			base: sha(item.base, `${at}'s base`),
			head: sha(item.head, `${at}'s head`),
			size: oneOf(item.size, SIZES, `${at}'s size`),
			tier: oneOf(item.tier, TIERS, `${at}'s tier`),
			reason: text(item.reason, `${at}'s reason`),
			writer: item.writer === null ? null : text(item.writer, `${at}'s writer`),
		};
		if (item.clean !== undefined) {
			if (item.clean !== true || item.defects !== undefined) fail(`${at} is clean and has defects`);
			return { ...each, clean: true };
		}
		if (!Array.isArray(item.defects) || item.defects.length === 0) fail(`${at} has no defects and is not clean`);
		const place = (p: unknown): Place => {
			if (!isObject(p)) return fail(`a defect's place in ${at}`);
			exact(p, ["file", "from", "to"], `a defect's place in ${at}`);
			const from = line(p.from, `a defect's first line in ${at}`);
			const to = line(p.to, `a defect's last line in ${at}`);
			if (to < from) fail(`a defect in ${at} ends before it starts`);
			return { file: text(p.file, `a defect's file in ${at}`), from, to };
		};
		const defects = (item.defects as unknown[]).map((d): Defect => {
			if (!isObject(d)) return fail(`a defect of ${at}`);
			exact(d, ["fix", "what", "at"], `a defect of ${at}`);
			if (!Array.isArray(d.at) || d.at.length === 0) fail(`a defect in ${at} is nowhere`);
			return {
				fix: pull(d.fix, `a defect's fix in ${at}`),
				what: text(d.what, `a defect's description in ${at}`),
				at: (d.at as unknown[]).map(place),
			};
		});
		return { ...each, defects };
	});
	return { repository: repository(value.repository, "repository"), cases };
}

/** The set at `path`, or null when there is none. */
export function readEvalSet(path: string): EvalSet | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		return parseEvalSet(JSON.parse(text));
	} catch (error) {
		throw new ReviewInputError(`${path}: ${(error as Error).message}`);
	}
}

const writeEvalSet = (path: string, set: EvalSet) =>
	writeFileSync(
		path,
		`${JSON.stringify({ ...set, cases: [...set.cases].sort((a, b) => a.pull - b.pull) }, null, "\t")}\n`,
	);

/** The GitHub repository `origin` names in `root`, which the set's cases must be PRs of. */
function originRepository(root: string): Repository {
	const named = remoteRepository(requireRemote(root, "origin")).repository;
	if (named === null) throw new ReviewInputError("origin is not on GitHub");
	return named;
}

const lower = (repository: Repository) => `${repository.owner}/${repository.repo}`.toLowerCase();

/** Whether `sha` is a commit the clone holds. */
function holds(root: string, sha: string): boolean {
	try {
		git(root, ["cat-file", "-e", `${sha}^{commit}`]);
		return true;
	} catch {
		return false;
	}
}

/** Fetch each of `refs` from origin that the clone lacks; GitHub serves a merged PR's head and any reachable commit. */
function fetch(root: string, refs: string[]): void {
	const missing = refs.filter((ref) => !SHA.test(ref) || !holds(root, ref));
	if (missing.length > 0) git(root, ["fetch", "--quiet", "--no-tags", "origin", ...missing]);
}

/** What `quest eval add` records. */
export interface AddOptions {
	root: string;
	/** The set's path; defaults to {@link EVAL_FILE} at the checkout's root. */
	set?: string;
	pull: number;
	/** Record it as a PR that broke nothing. */
	clean?: boolean;
	/** A defect to add to a culprit: which PR fixed it, what was wrong, and each place it is at the head. */
	defect?: Omit<Defect, "at"> & { at: string[] };
	env: NodeJS.ProcessEnv;
}

/** Where a defect sits, from `path:from-to` or `path:line`. */
export function defectLines(at: string): Place {
	const match = /^(.+):(\d+)(?:-(\d+))?$/.exec(at);
	const from = Number(match?.[2]);
	const to = match?.[3] === undefined ? from : Number(match[3]);
	if (match === null || from < 1 || to < from)
		throw new ReviewInputError(`--defect takes path:from-to or path:line, not ${at}`);
	return { file: match[1]!, from, to };
}

/**
 * Add a PR to the set: as clean, or with a defect, which a culprit already listed gains. The first time, it reads the
 * PR's last head and base from GitHub, fetches them, and records its merge base, its size and latest writer from its
 * `## Models` record, and its tier as the classifier sets it, which may run a model.
 */
export async function addCase(options: AddOptions, github: () => GitHubDependencies): Promise<EvalCase> {
	const root = git(options.root, ["rev-parse", "--show-toplevel"]);
	const path = options.set ?? join(root, EVAL_FILE);
	if (options.clean === (options.defect !== undefined))
		throw new ReviewInputError("pass either --clean or --defect with --fix and --what");
	const repository = originRepository(root);
	const set = readEvalSet(path) ?? { repository: lower(repository), cases: [] };
	if (set.repository !== lower(repository))
		throw new ReviewInputError(`${path} holds ${set.repository}'s PRs, but origin is ${lower(repository)}`);
	let entry = set.cases.find((each) => each.pull === options.pull);
	if (entry !== undefined && (options.clean || entry.clean))
		throw new ReviewInputError(
			`#${options.pull} is already in the set${entry.clean ? " as clean" : " as a culprit"}`,
		);
	if (entry === undefined) {
		entry = await resolveCase(root, repository, options, github);
		if (options.clean) entry.clean = true;
		set.cases.push(entry);
	}
	if (options.defect !== undefined) {
		const { fix, what, at } = options.defect;
		const places = at.map(defectLines);
		for (const place of places) {
			const lines = fileLines(root, entry.head, place.file);
			if (place.to > lines) throw new ReviewInputError(`${place.file} ends at line ${lines} at ${entry.head}`);
		}
		entry.defects = [...(entry.defects ?? []), { fix, what, at: places }];
	}
	writeEvalSet(path, set);
	return entry;
}

/** How many lines `file` has at `sha`, failing when it is not there. */
function fileLines(root: string, sha: string, file: string): number {
	let text: string;
	try {
		text = git(root, ["show", `${sha}:${file}`]);
	} catch {
		throw new ReviewInputError(`${file} is not in the head ${sha}`);
	}
	return text.split("\n").length;
}

/** A new case for PR `options.pull`, with no defects yet. */
async function resolveCase(
	root: string,
	repository: Repository,
	options: AddOptions,
	github: () => GitHubDependencies,
): Promise<EvalCase> {
	const client = new GitHub(github());
	const response = await client.request(`${repositoryPath(repository)}/pulls/${options.pull}`, { allow: [404] });
	if (response.status === 404) throw new ReviewInputError(`${lower(repository)} has no PR #${options.pull}`);
	const row = object(await response.json());
	if (!row.merged_at) throw new ReviewInputError(`#${options.pull} never merged`);
	const head = String(object(row.head).sha);
	const tip = String(object(row.base).sha);
	const branch = String(object(row.head).ref);
	fetch(root, [`refs/pull/${options.pull}/head`, tip]);
	if (!holds(root, head)) throw new ReviewInputError(`origin serves no head ${head} for #${options.pull}`);
	const base = git(root, ["merge-base", tip, head]);
	const own = recorded(typeof row.body === "string" ? row.body : "");
	const named = own.sizes.find((size) => (SIZES as readonly string[]).includes(size)) as Size | undefined;
	const size = reviewSize(root, base, branch, undefined, named ?? null).size;
	const writer = own.implementers.at(-1)?.fields?.model ?? null;
	const dir = evalDir(root);
	const { value } = await classify({
		root,
		baseSha: base,
		change: { base, mergeBase: base, head },
		dir,
		env: options.env,
	});
	return {
		pull: options.pull,
		base,
		head,
		size,
		tier: value.tier,
		reason: value.reason,
		writer: writer === "unknown" ? null : writer,
	};
}

/** The clone's directory for eval checkouts and reply schemas. */
function evalDir(root: string): string {
	const dir = join(git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "quest", "eval");
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** What `quest eval run` runs. */
export interface EvalOptions {
	root: string;
	/** The set's path; defaults to {@link EVAL_FILE} at the checkout's root. */
	set?: string;
	/** The only reviewer, at its size's entry, with `model` and `effort` overriding it; else the pick and its shadow. */
	harness?: HarnessName;
	model?: string;
	effort?: string;
	/** Only these PRs of the set. */
	only?: number[];
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	/** Called as each case starts, with its place in the run. */
	progress?: (index: number, total: number, pull: number) => void;
}

/** One reviewer's round on a case. */
export interface Seated {
	reviewer: HarnessName;
	model: string;
	effort: string;
	/** The size's pick one effort lower, beside the pick as `quest review` runs it. */
	shadow?: true;
	session: string;
	usage: Usage[];
	score: number;
	findings: Finding[];
	/** The index in the case's defects of each defect a finding names a line of. */
	found: number[];
}

/** A case and every reviewer's round on it. */
export interface Scored {
	case: EvalCase;
	seats: Seated[];
}

/** Defects found and noise raised by one group of rounds. */
export interface Tally {
	/** Culprits reviewed, and their defects found and in all. */
	culprits: number;
	found: number;
	defects: number;
	/** Clean PRs reviewed, and their findings by severity. */
	clean: number;
	noise: Record<(typeof SEVERITIES)[number], number>;
}

export interface EvalReport {
	repository: string;
	/** The review rules the reviewers were given: the checkout's REVIEW.md at its HEAD, or null without one. */
	rules: { sha: string } | null;
	scored: Scored[];
	/** Each seat over every case: `pick`, `shadow`, and `either`, a defect either found, as a run of both finds it. */
	totals: Record<string, Tally>;
	/** Each seat by the case's size and tier, as `pick M` or `shadow high`. */
	by: Record<string, Tally>;
	/** The cost of the run's sessions at API list price, as token-max prices them, or null when it is not installed. */
	cost: { usd: number; complete: boolean; priced: number; sessions: number } | null;
}

/** The reviewers a case gets: `harness`'s alone, or the size's pick, avoiding its writer, and the pick's shadow. */
export function evalSeats(entry: EvalCase, options: Pick<EvalOptions, "harness" | "model" | "effort">) {
	if (options.harness !== undefined)
		return [{ reviewer: pickReviewer(entry.size, options, () => false), shadow: undefined }];
	const pick = pickReviewer(entry.size, {}, (model: Model) => model.model === entry.writer);
	const shadow = shadowOf(pick);
	return [{ reviewer: pick, shadow: undefined }, ...(shadow ? [{ reviewer: shadow, shadow: true as const }] : [])];
}

/** The indexes of `defects` a finding names a line of. */
export function foundDefects(defects: Defect[], findings: Finding[]): number[] {
	const on = (f: Finding, p: Place) => f.file === p.file && f.line !== null && f.line >= p.from && f.line <= p.to;
	return defects.flatMap((defect, index) => (findings.some((f) => defect.at.some((p) => on(f, p))) ? [index] : []));
}

/**
 * Review every case of the set at its head, one case at a time with its reviewers at once, and score them. The first
 * failure stops the run and fails it whole, as a partial score would read as the reviewer's.
 */
export async function evaluate(options: EvalOptions, sessions: (since: Date) => Session[] | null): Promise<EvalReport> {
	if ((options.model !== undefined || options.effort !== undefined) && options.harness === undefined)
		throw new ReviewInputError("--model and --effort name --harness's reviewer; pass --harness too");
	const root = git(options.root, ["rev-parse", "--show-toplevel"]);
	const path = options.set ?? join(root, EVAL_FILE);
	const set = readEvalSet(path);
	if (set === null) throw new ReviewInputError(`no eval set at ${path}; add cases with quest eval add`);
	const repository = lower(originRepository(root));
	if (set.repository !== repository)
		throw new ReviewInputError(`${path} holds ${set.repository}'s PRs, but origin is ${repository}`);
	const unknown = (options.only ?? []).filter((pull) => !set.cases.some((each) => each.pull === pull));
	if (unknown.length > 0) throw new ReviewInputError(`not in the set: ${unknown.map((n) => `#${n}`).join(", ")}`);
	const cases = set.cases.filter((each) => options.only === undefined || options.only.includes(each.pull));
	if (cases.length === 0) throw new ReviewInputError("the set has no cases");
	// Every reviewer is picked before any runs, so an argument that picks none fails before tokens are spent.
	const seats = new Map(cases.map((each) => [each, evalSeats(each, options)]));
	let rules: { sha: string; text: string } | null = null;
	try {
		rules = { sha: git(root, ["rev-parse", "HEAD"]), text: git(root, ["show", "HEAD:REVIEW.md"]) };
	} catch {
		// No committed REVIEW.md: no rules.
	}
	const dir = evalDir(root);
	const started = new Date();
	fetch(
		root,
		cases.flatMap((each) => [each.base, each.head]),
	);

	const scored: Scored[] = [];
	for (const [index, entry] of cases.entries()) {
		options.progress?.(index + 1, cases.length, entry.pull);
		scored.push({ case: entry, seats: await reviewCase(root, dir, entry, seats.get(entry)!, rules, options) });
	}
	return {
		repository,
		rules: rules && { sha: rules.sha },
		scored,
		...tallies(scored),
		cost: priced(sessions(started), scored),
	};
}

/** Every reviewer's round on `entry`, in a detached checkout of its head removed afterwards. */
async function reviewCase(
	root: string,
	dir: string,
	entry: EvalCase,
	seats: ReturnType<typeof evalSeats>,
	rules: { sha: string; text: string } | null,
	options: EvalOptions,
): Promise<Seated[]> {
	// Its own name, so a concurrent run of the same case keeps its checkout.
	const checkout = join(dir, `${entry.pull}-${randomUUID()}`);
	git(root, ["worktree", "add", "--quiet", "--detach", checkout, entry.head]);
	try {
		const changed = git(root, ["diff", "--name-only", "-z", `${entry.base}..${entry.head}`])
			.split("\0")
			.filter(Boolean);
		const risk: Assessment = { tier: entry.tier, reason: entry.reason };
		const opening = {
			root: checkout,
			change: { base: entry.base, mergeBase: entry.base, head: entry.head },
			files: baseInstructions(root, entry.base, changed),
			rules,
			risk,
			dir,
			env: options.env,
		};
		const controller = new AbortController();
		const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		const results = await Promise.allSettled(
			seats.map(({ reviewer, shadow }) =>
				firstRound(reviewer, { ...opening, signal }).then(
					({ session, usage, verdict }): Seated => ({
						reviewer: reviewer.harness,
						model: reviewer.model,
						effort: reviewer.effort,
						...(shadow && { shadow }),
						session,
						usage,
						score: verdict.score,
						findings: verdict.findings,
						found: foundDefects(entry.defects ?? [], verdict.findings),
					}),
					(error: unknown) => {
						controller.abort(error);
						throw error;
					},
				),
			),
		);
		if (controller.signal.aborted) throw controller.signal.reason;
		return results.map((result) => (result as PromiseFulfilledResult<Seated>).value);
	} finally {
		git(root, ["worktree", "remove", "--force", checkout]);
	}
}

const empty = (): Tally => ({ culprits: 0, found: 0, defects: 0, clean: 0, noise: { high: 0, medium: 0, low: 0 } });

function count(tally: Tally, entry: EvalCase, found: number[], findings: Finding[]): void {
	if (entry.clean) {
		tally.clean++;
		for (const finding of findings) tally.noise[finding.severity]++;
	} else {
		tally.culprits++;
		tally.defects += entry.defects!.length;
		tally.found += found.length;
	}
}

/** The run's tallies: each seat in all, and by size and tier, with `either` for what the pick and shadow found together. */
export function tallies(scored: Scored[]): Pick<EvalReport, "totals" | "by"> {
	const totals: Record<string, Tally> = {};
	const by: Record<string, Tally> = {};
	const add = (seat: string, entry: EvalCase, found: number[], findings: Finding[]) => {
		for (const [into, key] of [
			[totals, seat],
			[by, `${seat} ${entry.size}`],
			[by, `${seat} ${entry.tier}`],
		] as const)
			count((into[key] ??= empty()), entry, found, findings);
	};
	for (const { case: entry, seats } of scored) {
		for (const seat of seats) add(seat.shadow ? "shadow" : "pick", entry, seat.found, seat.findings);
		if (seats.length > 1) {
			const found = [...new Set(seats.flatMap((seat) => seat.found))];
			// Both seats' findings on a clean PR, as a run of both raises them; the same defect twice is still one.
			add("either", entry, found, entry.clean ? seats.flatMap((seat) => seat.findings) : []);
		}
	}
	return { totals, by };
}

/**
 * The cost of `scored`'s sessions and their descendants, such as the sub-session Codex runs its review in, among those
 * token-max exported, or null when it is not installed. It is a lower bound when a seat's session is missing or one
 * is incomplete.
 */
export function priced(exported: Session[] | null, scored: Scored[]): EvalReport["cost"] {
	if (exported === null) return null;
	const id = (harness: string, session: string | null) => JSON.stringify([harness, session]);
	const seats = scored.flatMap(({ seats }) => seats.map((seat) => id(seat.reviewer, seat.session)));
	const ours = new Set(seats);
	const matched = new Set<Session>();
	for (let grew = true; grew;) {
		grew = false;
		for (const each of exported)
			if (
				!matched.has(each) &&
				(ours.has(id(each.harness, each.id)) || ours.has(id(each.harness, each.parent)))
			) {
				matched.add(each);
				ours.add(id(each.harness, each.id));
				grew = true;
			}
	}
	const found = seats.filter((seat) => [...matched].some((each) => id(each.harness, each.id) === seat)).length;
	return {
		usd: [...matched].reduce((sum, each) => sum + each.cost, 0),
		complete: found === seats.length && [...matched].every((each) => each.complete),
		priced: found,
		sessions: seats.length,
	};
}

const share = ({ found, defects }: Tally) =>
	`${found}/${defects} defects${defects ? ` (${Math.round((100 * found) / defects)}%)` : ""}`;
const noise = ({ clean, noise }: Tally) =>
	`${noise.high + noise.medium + noise.low} findings on ${clean} clean (${noise.high} high, ${noise.medium} medium, ${noise.low} low)`;
/** Each turn's tokens as the CLI reported them; Codex reports none for its review turn, which runs in a sub-session. */
const tokens = (usage: Usage[]) =>
	usage.length === 0
		? "no usage reported"
		: usage.map((u) => `${u.turn} ${u.input} in (${u.cached} cached), ${u.output} out`).join(", ");

/** The report as `quest eval run` prints it. */
export function evalLines(report: EvalReport): string[] {
	const culprits = report.scored.filter(({ case: c }) => !c.clean).length;
	const lines = [
		`${report.repository}: ${report.scored.length} cases, ${culprits} culprits and ${report.scored.length - culprits} clean; rules ${report.rules ? `REVIEW.md at ${report.rules.sha.slice(0, 12)}` : "none"}`,
	];
	for (const [seat, tally] of Object.entries(report.totals)) lines.push(`${seat}: ${share(tally)}; ${noise(tally)}`);
	for (const [key, tally] of Object.entries(report.by).sort(([a], [b]) => a.localeCompare(b)))
		lines.push(`  ${key}: ${share(tally)}; ${noise(tally)}`);
	for (const { case: entry, seats } of report.scored) {
		const kind = entry.clean ? "clean" : `${entry.defects!.length} defect(s)`;
		lines.push(`#${entry.pull} ${entry.size} ${entry.tier} ${kind}`);
		for (const seat of seats) {
			const name = `${seat.reviewer} ${seat.model} ${seat.effort}${seat.shadow ? " shadow" : ""}`;
			const result = entry.clean ? "" : ` found ${seat.found.length}/${entry.defects!.length},`;
			lines.push(
				`  ${name}: score ${seat.score},${result} ${seat.findings.length} findings; ${tokens(seat.usage)}; session ${seat.session}`,
			);
		}
	}
	const { cost } = report;
	lines.push(
		cost === null
			? "cost: unpriced, since token-max is not installed"
			: `cost: ~$${cost.usd.toFixed(2)} for ${cost.priced} of ${cost.sessions} sessions${cost.complete ? "" : ", a lower bound"}`,
	);
	return lines;
}
