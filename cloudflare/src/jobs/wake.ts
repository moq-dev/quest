// Webhooks are hints: only a running merge or delete attempt is notified, then it rereads GitHub through kix.
import { positiveId } from "../github/webhook";
import { hub } from "./routes";
import { LANDS } from "./store";

export async function wake(env: Env, repository: number, installation: number, event: string, payload: any) {
	if (
		![
			"pull_request",
			"pull_request_review",
			"pull_request_review_thread",
			"pull_request_review_comment",
			"issue_comment",
			"check_run",
			"check_suite",
			"status",
		].includes(event)
	)
		return;
	const numbers = (value: unknown): unknown[] => (Array.isArray(value) ? value.map((pull) => pull?.number) : []);
	const pulls = [
		payload.pull_request?.number,
		...numbers(payload.check_run?.pull_requests),
		...numbers(payload.check_suite?.pull_requests),
		...(payload.issue?.pull_request ? [payload.issue.number] : []),
	]
		.filter(positiveId)
		.map((number) => `pulls/${number}`);
	const heads = [payload.check_run?.head_sha, payload.check_suite?.head_sha, payload.sha].filter(
		(head): head is string => typeof head === "string" && /^[a-f0-9]{40}$/.test(head),
	);
	if (!pulls.length && !heads.length) return;
	const { results } = await env.DB.prepare(
		`SELECT j.id AS job,j.attempt,j.runner,j.actor FROM jobs j JOIN github_projects p ON p.id=j.repository
WHERE j.repository=? AND p.installation=? AND ${LANDS("j.")} AND j.state='running' AND j.runner IS NOT NULL
AND (j.target IN (SELECT value FROM json_each(?)) OR COALESCE(j.head,j.revision) IN (SELECT value FROM json_each(?)))`,
	)
		.bind(repository, installation, JSON.stringify(pulls), JSON.stringify(heads))
		.all<{ job: string; attempt: number; runner: string; actor: string }>();
	const owners = new Map<string, typeof results>();
	for (const row of results) owners.set(row.actor, [...(owners.get(row.actor) ?? []), row]);
	await Promise.all([...owners].map(([owner, attempts]) => hub(env, owner).wake(attempts)));
}
