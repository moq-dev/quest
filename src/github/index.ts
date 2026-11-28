// Quest's GitHub readers for a host with no checkout, git, or Node APIs, such as a Worker: the forge reads'
// GitHub backend, a repository's history for `quest/core`'s `BaseMerges`, a PR's status as `quest status` reads
// it, the `quest review` status that counts for a head as the land gate reads it, the claims on quest branches as
// `quest start` decides them, and `ago`, the "3 hours ago" formatter. The caller supplies `fetch` and the token
// through `GitHubDependencies`; the read types are `quest/core`'s.

export {
	GitHub,
	GitHubDeadline,
	type GitHubDependencies,
	GitHubGraphQLError,
	type GitHubReadDependencies,
	GitHubReader,
	reading,
} from "./client";
export { GitHubForge } from "./forge";
export { history } from "./history";
export { type Counted, type ReviewStatus, countedReview, reviewStatuses } from "./review-trust";
export { type BaseNeeds, type Needs, pullRequestStatus, requiredOf } from "./status";
export { type HoldReport, ago } from "./hold";
export { claimBranches, held, openPullRequests } from "./claims";
