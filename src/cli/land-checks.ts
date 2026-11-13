// GitHub Actions job logs, and a PR's own checks on a head as the land fixer's context: a signal, never a gate.
import { array, type GitHub, object, type ObjectValue, string } from "../github/client";
import { redactTokens } from "./land-fixer";
import { classifyCheck } from "./status";

/** How much of the end of each failing check's log the fixer reads beside the queue's own failure log. */
export const CHECK_LOG = 20_000;

/** A job log as GitHub serves it, without its byte-order mark or per-line timestamps, and with no token. */
function cleanLog(text: string): string {
	return redactTokens(text.replace(/^\uFEFF/, "").replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z /gm, ""));
}

/** A GitHub Actions job's log, or a note saying GitHub keeps none, as after its retention. */
export async function jobLog(github: GitHub, repository: string, id: number): Promise<string> {
	const response = await github.request(`/repos/${repository}/actions/jobs/${id}/logs`, { allow: [404, 410] });
	return response.ok ? cleanLog(await response.text()) : `(GitHub has no log for this job: HTTP ${response.status})`;
}

const CHECKS = `query($owner: String!, $name: String!, $sha: GitObjectID!, $id: ID!, $after: String) {
	repository(owner: $owner, name: $name) { object(oid: $sha) { ... on Commit { statusCheckRollup {
		contexts(first: 100, after: $after) {
			pageInfo { hasNextPage endCursor }
			nodes {
				__typename
				... on CheckRun {
					name status conclusion detailsUrl databaseId isRequired(pullRequestId: $id)
					checkSuite { app { slug } workflowRun { workflow { name } } }
				}
				... on StatusContext { context state targetUrl description isRequired(pullRequestId: $id) }
			}
		}
	} } } }
}`;

/** A check's name as its workflow and job, when GitHub Actions ran it. */
function checkName(context: ObjectValue, name: string): string {
	const run = context.checkSuite == null ? null : object(context.checkSuite).workflowRun;
	return run == null ? name : `${string(object(object(run).workflow).name)} / ${name}`;
}

/**
 * The checks PR `id` reported on `head`, from its own CI rather than the merge queue: each one's result,
 * whether it is required, and its URL, then the end of each failing GitHub Actions job's log. The land
 * fixer reads it after the queue's failure log, as context only.
 */
export async function checksSection(github: GitHub, repository: string, id: string, head: string): Promise<string> {
	const [owner, name] = repository.split("/");
	const contexts: ObjectValue[] = [];
	for (let after: string | null = null; ;) {
		const data = await github.graphql(CHECKS, { owner, name, sha: head, id, after });
		const commit = object(data.repository).object;
		const rollup = commit == null ? null : object(commit).statusCheckRollup;
		if (rollup == null) break;
		const page = object(object(rollup).contexts);
		contexts.push(...array(page.nodes));
		if (object(page.pageInfo).hasNextPage !== true) break;
		after = string(object(page.pageInfo).endCursor);
	}
	const lines = [
		`== The pull request's own checks on ${head} ==`,
		"Its own CI ran these on the pull request, not in the merge queue. They are a signal only, and gate nothing.",
	];
	if (contexts.length === 0) lines.push("It reported no checks.");
	const logs: string[] = [];
	for (const context of contexts) {
		const { check, outcome } = classifyCheck(context);
		const named = checkName(context, check.name);
		const description =
			typeof context.description === "string" && context.description ? `: ${context.description}` : "";
		lines.push(
			`${check.result} ${check.required ? "required" : "optional"} ${named} (${check.url ?? "no URL"})${description}`,
		);
		if (outcome !== "failing" || context.__typename !== "CheckRun") continue;
		const suite = context.checkSuite == null ? null : object(context.checkSuite);
		const app = suite?.app == null ? "" : string(object(suite.app).slug);
		if (app !== "github-actions" || typeof context.databaseId !== "number") continue;
		const log = (await jobLog(github, repository, context.databaseId)).trimEnd();
		const tail = log.length > CHECK_LOG ? `…${log.slice(-CHECK_LOG)}` : log;
		logs.push(`\n== ${named}: ${check.result} (${check.url ?? "no URL"}), the end of its log ==\n${tail}`);
	}
	return [...lines, ...logs, ""].join("\n");
}
