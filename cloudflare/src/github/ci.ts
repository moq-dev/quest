// kix publishes job branches on the enrolled repository itself, where GitHub
// gives a branch's workflows the repository's secrets and default token. So
// pull-request CI must stay read-only: code no maintainer has reviewed meets a
// read-only GITHUB_TOKEN and no write credentials. This check reads the
// repository's Actions settings and reports what breaks that rule. It only
// warns: jobs still run, and a failed read becomes a warning of its own.

/** The App permissions the check reads with, beyond metadata. */
export const CI_PERMISSIONS = {
	administration: "read",
	secrets: "read",
	actions: "read",
	environments: "read",
} as const;
export type CIPermission = keyof typeof CI_PERMISSIONS;

/** REST reads below `/repos/<owner>/<name>`, through the caller's scoped token. */
export type CIReads = { get<T>(path: string): Promise<T> };

/**
 * Environments examined per check. Each costs up to two reads, which keeps a
 * setup page within Workers Free's 50 subrequests alongside its other reads.
 */
export const ENVIRONMENTS = 12;

type Secrets = { total_count: number; secrets: { name: string }[] };
type Environment = {
	name: string;
	deployment_branch_policy: { protected_branches: boolean; custom_branch_policies: boolean } | null;
};
type Policy = { name: string; type?: string };

const PERMISSION_NAMES: Record<CIPermission, string> = {
	administration: "Administration",
	secrets: "Secrets",
	actions: "Actions",
	environments: "Environments",
};
const WILDCARD = /[*?[\]{}\\]/;
const QUEUE = /^gh-readonly-queue\/([^*?[\]{}\\]+)\/\*$/;

function names(secrets: Secrets) {
	const listed = secrets.secrets.map((secret) => secret.name);
	const more = secrets.total_count - listed.length;
	return listed.join(", ") + (more > 0 ? ` and ${more} more` : "");
}
function count(n: number, noun: string) {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * What lets pull-request CI write, as sentences for the maintainer, or an
 * empty list when nothing does. `granted` names the CI permissions the
 * installation has accepted; checks needing another are reported unchecked.
 */
export async function ciProblems(reads: CIReads, granted: ReadonlySet<CIPermission>): Promise<string[]> {
	const problems: string[] = [];
	// A failed or malformed read is a warning, never a failed page.
	const read = async <T>(path: string, what: string, valid: (value: T) => boolean): Promise<T | null> => {
		try {
			const value = await reads.get<T>(path);
			if (value && valid(value)) return value;
		} catch {}
		problems.push(`kix could not read ${what}; review this project again later.`);
		return null;
	};
	const secretList = (value: Secrets) => typeof value.total_count === "number" && Array.isArray(value.secrets);

	const missing = (Object.keys(CI_PERMISSIONS) as CIPermission[]).filter((p) => !granted.has(p));
	if (missing.length)
		problems.push(
			`Accept the App's ${missing.map((p) => `${PERMISSION_NAMES[p]} (read)`).join(", ")} permission${missing.length === 1 ? "" : "s"} in its GitHub installation settings so kix can check ${[
				granted.has("administration") ? null : "the default workflow token",
				granted.has("secrets") ? null : "repository and organization secrets",
				granted.has("actions") && granted.has("environments") ? null : "environments",
			]
				.filter(Boolean)
				.join(", ")}.`,
		);

	if (granted.has("administration")) {
		const token = await read<{ default_workflow_permissions: string }>(
			"/actions/permissions/workflow",
			"the default workflow token's permissions",
			(value) => typeof value.default_workflow_permissions === "string",
		);
		if (token && token.default_workflow_permissions !== "read")
			problems.push(
				"The default GITHUB_TOKEN can write. Set Settings → Actions → General → Workflow permissions to read repository contents and packages.",
			);
	}

	if (granted.has("secrets")) {
		const repository = await read<Secrets>("/actions/secrets?per_page=100", "repository secrets", secretList);
		if (repository?.total_count)
			problems.push(
				`Every workflow, including those on kix's branches, receives ${count(repository.total_count, "repository secret")}: ${names(repository)}. Move them into environments limited to protected branches.`,
			);
		const organization = await read<Secrets>(
			"/actions/organization-secrets?per_page=100",
			"organization secrets",
			secretList,
		);
		if (organization?.total_count)
			problems.push(
				`Every workflow, including those on kix's branches, receives ${count(organization.total_count, "organization secret")}: ${names(organization)}. Stop sharing them with this repository, or move them into environments limited to protected branches.`,
			);
	}

	if (granted.has("actions") && granted.has("environments")) {
		const listed = await read<{ total_count: number; environments: Environment[] }>(
			"/environments?per_page=100",
			"environments",
			(value) => typeof value.total_count === "number" && Array.isArray(value.environments),
		);
		// Read once, only when a policy names protected branches.
		let protectedBranches: Promise<Set<string> | null> | undefined;
		const branches = () =>
			(protectedBranches ??= read<{ name: string }[]>(
				"/branches?protected=true&per_page=100",
				"protected branches",
				Array.isArray,
			).then((list) => list && new Set(list.map((branch) => branch.name))));
		for (const environment of listed?.environments.slice(0, ENVIRONMENTS) ?? []) {
			const path = `/environments/${encodeURIComponent(environment.name)}`;
			const policy = environment.deployment_branch_policy;
			let reason: string | null = null;
			if (!policy) reason = "lets any branch deploy";
			else if (policy.protected_branches) {
				const known = await branches();
				if (known && known.size === 0)
					reason =
						"allows only protected branches, but no branch is protected, so GitHub lets any branch deploy";
			} else if (policy.custom_branch_policies) {
				const policies = await read<{ branch_policies: Policy[] }>(
					`${path}/deployment-branch-policies?per_page=100`,
					`environment ${environment.name}'s deployment branches`,
					(value) => Array.isArray(value.branch_policies),
				);
				if (!policies) continue;
				// Tags are written by people with write access, never by kix. A branch
				// counts only when GitHub reports it protected, or it is the merge
				// queue's own branch for one; a wildcard may match a branch kix writes.
				const patterns = policies.branch_policies.filter((p) => (p.type ?? "branch") === "branch");
				const fixed = patterns.map((p) => p.name.match(QUEUE)?.[1] ?? p.name);
				const known = fixed.some((name) => !WILDCARD.test(name)) ? await branches() : new Set<string>();
				if (!known) continue;
				const open = patterns.filter((_, i) => WILDCARD.test(fixed[i]!) || !known.has(fixed[i]!));
				if (open.length)
					reason = `lets ${open.map((p) => p.name).join(", ")} deploy, which kix cannot confirm ${open.length === 1 ? "is a protected branch" : "are protected branches"}`;
			}
			if (!reason) continue;
			const secrets = await read<Secrets>(
				`${path}/secrets?per_page=100`,
				`environment ${environment.name}'s secrets`,
				secretList,
			);
			if (secrets?.total_count)
				problems.push(
					`Environment ${environment.name} has ${count(secrets.total_count, "secret")} and ${reason}. Limit its deployment branches to protected branches.`,
				);
		}
		if (listed && listed.total_count > ENVIRONMENTS)
			problems.push(
				`kix checked only the first ${ENVIRONMENTS} of ${listed.total_count} environments. Limit the rest to protected branches too.`,
			);
	}
	return problems;
}
