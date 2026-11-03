# GitHub App integration

The operator registers one public Quest App from the reviewed
[manifest](github-app-manifest.json). Project users install that existing App;
they do not create their own bots. The same App's OAuth client signs users in,
while its installation identity authors service comments and pull requests. App secrets
and installation tokens stay inside the Worker; agents receive neither.

## Permissions and events

| Repository permission | Why the installation grants it                                             | Per-operation token                                            |
| --------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Metadata: read        | Resolve repository identity and maintainer authority                       | Every operation                                                |
| Contents: write       | Read quest files, write job branches and iterated PR heads on the upstream | Read for quest reads; write only for that publication or merge |
| Issues: write         | Read native issues, publish approved comments, label merge jobs' PRs       | Read or write for that operation                               |
| Pull requests: write  | Observe, open and update job PRs, explicitly merge an exact head           | Read or write for that operation                               |
| Checks: write         | Observe checks; record a runner's review as the `quest review` check run   | Read for check reads; write only to record a runner's review   |
| Commit statuses: read | Observe legacy CI status contexts                                          | Check reads only                                               |
| Administration: read  | Read whether the default workflow token can write                          | The setup page's [CI check](#read-only-pull-request-ci) only   |
| Secrets: read         | List the names of Actions secrets that reach every workflow                | The setup page's CI check only                                 |
| Actions: read         | List environments and their deployment branch policies                     | The setup page's CI check only                                 |
| Environments: read    | Count each environment's secrets                                           | The setup page's CI check only                                 |

The manifest subscribes to push, issues, issue comments, pull requests, reviews,
review threads, inline review comments, checks and statuses. Existing App registrations
must enable `pull_request_review_thread` and `pull_request_review_comment` in their
webhook subscriptions so resolving discussions and replying inline wake merge jobs. GitHub also sends installation lifecycle and repository
selection events automatically. The App also requests the **Email addresses: read**
user permission, which Better Auth needs to sign in users whose email is private.
It grants no repository authority: the user token is used only for the sign-in
profile and email reads and to list the [project picker](#project-enrollment)'s
repositories, and never for repository writes or authority checks. No organization,
administration-write, or workflow permissions are requested, and GitHub never
returns a secret's value, only its name. These installation grants
are necessarily broader than individual operations: minted tokens always name
one repository ID and the particular permissions required. Tokens are never
cached and are revoked after use; failed cleanup is logged without secrets and
does not retry a successful write. GitHub also expires tokens after an hour.

## Trust by stage

Each stage of a job trusts as little as it can. Untrusted text, such as an
issue, a pull request, a comment, a prompt answer, or anything an agent writes,
is data at every stage: it never grants authority, approves work, or changes
what kix may write.

| Stage        | What is trusted                                                                                                                                                                                                                                                                                             | Why                                                                                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intake       | GitHub's live answers to kix's own reads. A webhook only asks for a read; its signature proves GitHub sent it, not that its contents are current                                                                                                                                                            | Deliveries arrive late, out of order, or not at all, and bodies are anyone's text ([webhooks](#webhooks-and-revocation), [project state](#project-state-and-activity))                                               |
| Job creation | The signed-in maintainer's request, after a live check of their maintain or admin role, bound to the revision or head the maintainer saw                                                                                                                                                                    | A browser's claims grant nothing, and a head that moved since observations read it is refused ([README](README.md))                                                                                                  |
| Routing      | The requester's own runners, and their owner's word for each runner. Untrusted heads go only to Linux runners whose owner declared VM builds; kix does not verify the flag                                                                                                                                  | A runner is its owner's machine and risk, and jobs never reach another user's runner                                                                                                                                 |
| devShell     | A trusted revision: the default branch, or a pull request head whose every commit beyond the default branch carries a valid signature from a current maintainer, or whose exact SHA a current maintainer approved in the inbox (`head_approvals`). A head kix pushed to is trusted only by such an approval | The runner's host Nix evaluates the flake outside the sandbox, and "kix published it" proves only that a runner sent it. An approval lapses when the head moves or its approver loses the role ([README](README.md)) |
| Agent run    | Nothing the agent does. Its commands run in an OS sandbox with no GitHub credential, and it acts on an answer only once the runner's owner gave or approved it                                                                                                                                              | Issue and pull request text can inject prompts ([README](../README.md))                                                                                                                                              |
| Publication  | Nothing in the submitted files. kix writes them as Git data to the job's branch or the same-repository head it iterates, refuses workflow files and the default branch, and fences out stale attempts                                                                                                       | A prompt-injected agent or a compromised runner can send anything ([Publication](#publication))                                                                                                                      |
| CI           | The enrolled repository's settings keep pull-request CI read-only. A runner's request to mark its pull request ready is its owner's statement, and under read-only CI it starts only harmless checks                                                                                                        | GitHub gives same-repository branches' workflows the repository's secrets and default token, unlike fork pull requests ([Read-only pull-request CI](#read-only-pull-request-ci))                                     |
| Review       | A review that counts on the exact head: a writer's approval, the App's `quest review` check, or the author's own `## Review` record on a commit no App made. An agent's recommendation never counts                                                                                                         | Picking merge approves the head the maintainer saw, not whatever is pushed after it ([Landing only reviewed heads](#landing-only-reviewed-heads))                                                                    |
| Land         | The maintainer's explicit pick of that head, under GitHub's branch rules and checks                                                                                                                                                                                                                         | kix never writes the default branch itself; GitHub's refusals stand ([Merge jobs](#merge-jobs))                                                                                                                      |

## Trusted boundary

`src/github/service.ts` provides specific server-only operations for quest
reads, issue/PR reads, check/status reads, comments, job publication (see
[Publication](#publication)), and an explicitly authorized merge with an
expected head SHA.
Callers pass a user ID obtained from an authenticated local session. The service
resolves its linked OAuth account, looks up the current GitHub login by numeric
ID, and verifies current repository admin or maintain authority. A browser's
login name, claimed installation, repository role, or webhook sender grants no
authority. Ordinary write and custom roles are rejected. Installation identity,
permission grants and repository identity are fetched live for every operation.

These methods are integration primitives, not public HTTP routes or an agent
tool interface. Their trusted caller owns the user's approval of the exact
output/action, product policy, branch protections and review/check gating.
Webhook receipt never supplies that approval. No automatic comments, PRs,
merges or runner launches occur; a job publishes only what its maintainer
authorized, on behalf of that maintainer's current authority. Check reads accept a page number (default 1) and return up to 100 checks
and status contexts with GitHub's totals; callers must request additional pages
before treating the result as complete or approving a merge.

The App writes job branches on the enrolled repository itself. Installing the
App there is enough; the operator provisions no service fork or fork namespace.
Contributor-fork pull requests remain readable, but the App cannot update them.

## Publication

A running job publishes its work at `POST /api/runner/publish`, authenticated
with its runner's bearer token (`src/jobs/publish.ts`). The JSON request names
the `job` and `attempt`, the commit the changes build on (`head`, or `null`
before the job's branch exists), a commit `message`, and `changes`: up to 500
files, 16 MiB in all, each `{ path, content, executable?, symlink? }` with
base64 content, or `null` content to delete. A symlink's content is its target.
Submodule changes cannot be published. An optional `pull: { title, body, draft }`
opens or updates the job's pull request, and `session` names the agent session
to resume if the publication needs a decision. Checkpoints publish work in
progress the same way, so a reassigned job continues from its branch, as does
a retry of a failed job: it starts from the head and pull request the failed
job recorded, and a branch moved since still becomes a decision. The reply
is `{ head, pull? }`, or `202 { decision, cancel }` when the job paused.

Submitted files are data. The publisher never checks them out or runs their
scripts or hooks: it writes blobs, a tree, and a commit with the Git Data API
and moves one branch. Before writing anything it checks, in order:

- The request comes from the job's current `(attempt, runner)` while it runs.
  A cancelling attempt may still publish its partial work. A reassignment
  increments the attempt, which fences out the previous runner.
- Every path is a plain work-tree path: no `.git`, `.` or `..` segment, no
  absolute path, backslash, or control character. Each workflow publishes
  only its own changes: `plan` only quest documents under `quest/` (Markdown
  other than `AGENTS.md` and `CLAUDE.md`), `bootstrap` only `flake.nix` and
  `flake.lock`, `start`, `iterate`, and `merge` their task's changes. No workflow changes
  `.github/workflows/`, because the App does not request the workflows
  permission; a merge commit may keep a pull request's own workflow changes,
  but not change the workflows of the head it updates. A refused change pauses the job with a `publication` decision
  listing each path and reason, instead of being dropped; the maintainer's
  answer resumes the agent's session.
- The job's requester still holds maintainer authority, and the repository's
  identity, visibility, installation, and enrollment are checked live, as for
  every other operation.
- The branch is where the job left it: absent before the first publication,
  then the last commit kix published. A `head` that differs gets a
  `409 { error, head }` naming the commit to continue from, so a runner whose
  previous reply was lost continues from what landed instead of failing. A
  branch changed outside the job, or one that earlier work left on the upstream,
  becomes a decision; publication never overwrites it. On a job's own upstream
  branch, the decision also offers to start over: at the maintainer's request
  (`restart: true` in place of an `answer`, after a live authority check), kix
  replaces the job with a new one at the job's revision, with a new agent
  session and no recorded pull request, and then force-resets the branch there.
  Replacing the job first means a concurrent answer or cancel refuses the
  restart before any commit is discarded. If the reset fails, the new job waits
  on the same Start over decision. An iterated pull request's head is never
  reset.

`plan`, `start`, and `bootstrap` jobs write their branch on the enrolled
upstream itself. `start` uses the quest's branch, `plan` uses `plan/<id>` or
`plan/issue-<n>`, and `bootstrap` uses `kix/devshell`, outside the quest claim
namespace. An `iterate` or `merge` job writes its pull request's actual head
only when it belongs to that same repository. A contributor-fork head pauses
with a decision reporting the blocked update; kix never opens a replacement
pull request. No job writes the repository's default branch, and no runner ever
receives a credential.

The App authors the commits as well as the pull requests: the service sets no
author or committer, so GitHub attributes and signs them as the App.
Contributor and model attribution comes from the agent's commit message and
pull request body, written to the repository's own instructions.

Interruptions are reconciled before anything is replayed. The service creates
the commit, records it as pending under the attempt fence, and then moves the
branch with a fast-forward-only update. If the outcome is lost, the next
publication finds the pending commit on the branch and adopts it; until then,
for up to two minutes, other publications of the job wait. GitHub cannot check
kix's fence, so the fence is rechecked immediately before that update: a
fenced-out attempt's write lands only if it passed the check before the
reassignment, and the fast-forward check means it can never overwrite newer
work. Delivery looks for the branch's open pull request before creating one,
and reconciles a refused creation the same way, so a retry never opens a
duplicate. Since the branch is verified to be where the job left it, its only
open pull request is the job's, even one a failed job opened without recording
it. A pull request opened since the job and then closed by the maintainer is
not replaced.

Planning pull requests are always drafts, as are those of jobs asked to stop.
Other jobs set `draft`, which defaults to `true` while decisions or unfinished
work remain; a later delivery with `draft: false` marks the pull request ready.
kix never converts a ready pull request back. Delivery and landing require an enabled
project; a paused project's running jobs can still preserve their work on their
branches. Job pull requests use same-repository branches, which upstream maintainers can
edit through their normal repository access.

A planning pull request's body ends with a decision section the service
writes from the job's answered `decision` questions, after those of each
failed job it continues as a retry, whether or not that job opened the pull
request (`src/jobs/trail.ts`): each round's
questions, every option with ✅ on each choice, and the
maintainer's own words. Permission requests and the service's `account` and
`publication` questions stay out, since they can name runners and accounts.
Prompts and answers are untrusted, so each appears only as a code span with its
line breaks and bidirectional controls removed: GitHub renders no Markdown or
HTML there and links no mention, issue, cross-repository or commit reference,
URL, or closing keyword. Every delivery renders the section again between
`<!-- kix:decisions -->` markers, after dropping any the agent wrote. Rounds
past GitHub's 65,536-character body limit are counted rather than cut.

GitHub keeps pull request status, checks, and reviews. `mergePullRequest`
merges only an exact head a maintainer explicitly chose, once a review counts
on it (see [Landing only reviewed heads](#landing-only-reviewed-heads)), with
the first method the repository allows: squash, then a merge commit, then
rebase. GitHub's branch rules and refusals stand, and an agent's
recommendation is never approval. The decision inbox offers it on a pull request item only when
GitHub reports the PR's merge state as `CLEAN` or `HAS_HOOKS` and no job or
session holds the PR. The form binds the head on screen. A moved head asks for
another look, GitHub's refusal is shown in its own words, and neither is
retried.

### Merge jobs

On any other open, non-draft pull request that nothing holds, the inbox's
merge button starts a `merge` job instead. Picking it covers the job's own
fixes for conflicts, failing checks, and review findings; a head moved by
anyone else, a design change, and the merge skill's design checkpoint pause it
on a decision.

- The job holds the PR with its own `quest:kix` label, under the contract
  `quest iterate --help` states for local sessions: the bot adds it when the
  job is created, and refuses the pick while another hold label is on the PR.
  The job keeps the timeline event that added the label as its `hold`. Like
  local sessions, kix ignores the `quest:merge` label older quest versions
  left on queued PRs.
- The job's agent resolves conflicts by merging the base branch with Git. A
  publication may name that `merge` commit, which kix accepts only when the
  PR's upstream base branch already holds it; kix then publishes a merge
  commit whose files are the changes applied to the merged commit's.
- Landing is a publication with `land`: kix verifies the published head and
  the job's hold, then enables auto-merge bound to that head, entering the
  merge queue when the base has one, or merges it at once when GitHub would
  refuse auto-merge because nothing is left to wait for. It uses the method the
  job names, else the first the repository allows. A base that requires the
  `quest land` check queues the PR for that gate instead, as `quest merge`
  does: squash auto-merge whose commit body pins the head. Either way, kix
  first requires a review that counts on that head; without one, the job
  pauses on a decision that says why. A refusal also pauses the job on a
  decision, in GitHub's words.
- The label stays while the job runs or waits, and while the PR is queued or
  auto-merging. When the job ends without a landing in progress, or a
  `pull_request` webhook arrives and GitHub shows the landing ended unmerged,
  the App removes its own label. The PR is then an idle decision item again.

Labels need `issues: write` on the upstream; landing needs `contents: write`,
`pull_requests: write`, and `checks: read` there, as a direct merge does.

### Landing only reviewed heads

Picking merge is a maintainer's decision about the head they saw, not a review
of whatever a runner, or anyone, pushes after it. So both a direct merge and a
merge job's landing first require a review that counts on the exact head being
landed (`src/github/review.ts`):

- an approval on GitHub of that commit by a person with write access other than
  the pull request's author; reviews by Apps never count;
- a completed, successful `quest review` check run on that commit, written by
  this App from a runner's review (see [Runner reviews](#runner-reviews)).
  Only the App can write one, and GitHub binds it to the commit;
- or the author's own `## Review` record, as the guide's default review policy
  counts it in every enrolled repository: the `## Review` section of the PR
  body names the commit's full SHA, the author has write access, and the body's
  latest edit is the author's. The record is self-reported, so it never counts
  on a commit GitHub attributes to an App's bot, as it does every commit a
  runner publishes; a runner's head needs one of the other two.

A reviewer's suggested patch applied on GitHub is its applier's own commit, so
the head it makes needs a new review.

A review also carries to a head whose only changes since the reviewed commit
are merges of commits the default branch already holds that resolved nothing:
every file holds the reviewed side's version or the default branch's, whichever
changed it. kix verifies this from the commits' trees, up to five merges back.
A file both sides changed, even one Git merged line by line without a
conflict, needs a new review, as does any other commit, a truncated tree, or a
read that fails.
An author's record carries only across merges no App committed.

kix defers to GitHub only where GitHub enforces the same rule: a ruleset on the
base that requires an approval and either dismisses stale approvals or requires
approval of the most recent push, which GitHub reports this App cannot bypass.
Classic branch protection's review settings need the administration
permission, which landing tokens do not carry, so kix keeps its own check
there.

When no review counts, a direct merge is refused and a merge job pauses on a
decision. Both say which commit needs a review and how to give one.

GitHub keeps auto-merge enabled across a push by anyone with write access, the
App's included, and checks the `expectedHeadOid` kix pins only when auto-merge
is enabled. Its merge queue likewise keeps a queued pull request across such a
push. So once a merge job arms auto-merge on a reviewed head while its checks
run, whatever a writer pushes after it lands with it, unreviewed. Only the
`quest land` gate's pin, or a ruleset GitHub enforces that requires a new
approval of every push, refuses such a head. The maintainer accepted this gap
on 2026-11-02, matching `quest merge --land`, rather than make a merge job wait
for its checks and merge only at once.

kix closes it for its own pushes: a job pushing to a pull request that is
auto-merging would land its new head with no review of it. Before a job moves
or resets a branch that heads an open pull request, its own or an iterated
one, kix turns that pull request's auto-merge off. If GitHub refuses or does
not show whether it is on, the job pushes nothing and pauses on a decision. The
new head lands only through a new landing.

### Read-only pull-request CI

kix pull requests come from upstream branches, and GitHub gives workflows on
same-repository branches the repository's secrets and default token, unlike
fork pull requests. Pushing a job branch also runs its `push` workflows. So
enrolled repositories must keep that CI read-only: a read-only default
`GITHUB_TOKEN`, no secrets at repository or organization level, and secrets
only in environments limited to protected branches. Agent-written code then
runs in CI before review with nothing it can write through. Jobs whose
workflow asks for write `permissions:` itself, and `pull_request_target` and
`workflow_run` jobs that check out a PR head, fall under the same rule. kix
never runs pull request code in the publisher and grants runners no GitHub
credentials. This rule, rather than a service fork or a review gate on every
push, is kix's answer to agent-written code reaching CI.

The project's setup page, where a maintainer enables contributions and later
pauses them, checks the repository's settings with the installation's token
(`src/github/ci.ts`) and lists each problem it finds:

- the default workflow token can write;
- Actions secrets at repository level, or organization secrets shared with the
  repository, by name;
- an environment with secrets whose deployment branches include one GitHub
  does not report protected.

An environment limited to protected branches passes while some branch is
protected, since GitHub lets every branch deploy when none is. One limited to
selected branches passes when each branch pattern names a protected branch,
or the merge queue's `gh-readonly-queue/<branch>/*` for one; a wildcard could
match a branch kix writes, so it is reported. Tag patterns pass, since kix
never writes tags. Required reviewers on an environment do not count: a
reviewer approves a deployment, not the code a job branch carries.

The check only warns: enabling still works, and jobs still run. A failed read
becomes a warning of its own. It makes at most 30 reads, so the page stays
within a Worker's subrequest budget, and says when it stopped before checking
every environment. It
does not read workflow files, so the page reminds the maintainer of the rest
of the rule. An installation that has not accepted the check's permissions
gets a warning naming them instead of the checks they cover.

Installation grants are broader than any one publication: `contents: write`
and `pull_requests: write` cover every installed repository. Each token names
one repository ID and only the permissions that step needs. Branch writes get
`contents: write` on the upstream alone, plus `pull_requests: write` to turn
off the auto-merge of a pull request the branch heads, and pull request
delivery gets `pull_requests: write` there. That token could write any
unprotected upstream branch; the service restricts it to the job's branch or
the pull request's head and refuses the default branch. Repositories should
still protect their default branch.

Mocked tests cover this path. These GitHub behaviors still need a live check
against real installations ([operator setup](../quest/m0/kix/operator-setup.md)):
plan/start/bootstrap publication on the enrolled upstream without a fork,
GitHub's signature on App-authored API commits, and pushing or resetting a job
branch under the repository's branch rules.

### Runner reviews

A runner reviews the heads its jobs publish, so they land through the gate
above without a person's approval. When a job delivers a head it published,
other than to a pull request that stays a draft, the runner process runs
`quest review` on that head with the other vendor's model: Codex for a job on
an Anthropic account, Claude Code otherwise. It runs outside the agent's
sandbox, in a checkout of the published commit the agent cannot reach, and
reports the round over `POST /api/runner/review`. The agent never touches the
report, so it can neither skip nor fake the review. A merge job publishes its
fixes, has them reviewed, and lands only a head whose review found nothing.

kix records the round as the App's `quest review` check run on the commit,
with the reviewer, model, effort, and round as its summary and each finding as
plain text: `success` when the round found nothing, `failure` otherwise. The
agent fixes or refutes each finding and delivers again; the next round resumes
the reviewer's session with its responses. kix records a report only from the
job's current attempt, only on the head kix itself last published for the job
and GitHub attributes to a bot, not one a merge job continued onto,
and only from another vendor's model than the job's account runs, and writes it
with `checks: write` on behalf of the job's requester, after rechecking their
maintainer authority.

Claude Code reviews with one of the runner's Claude Code accounts that is not
limited. Runners hold no Codex accounts, so Codex reviews with the login of
the user running `quest runner`. A runner that cannot review, for want of a
reviewer or because the review failed, says so to the agent and leaves the
head to a person's approval, as before.

## Webhooks and revocation

`POST /webhooks/github` verifies `X-Hub-Signature-256` over the exact raw bytes
before parsing. GitHub's 25 MB payload ceiling bounds the request. Delivery IDs,
body digest, event and minimal installation/repository metadata persist in D1;
untrusted issue/PR bodies are not stored. Dedup and lifecycle changes commit in
one transaction. A duplicate cannot reapply a state transition; reuse with a
different body/event is rejected for 30 days; each insert prunes older records
in the same transaction. There is no asynchronous enqueue/ack gap or remote side
effect here.

Deleted or suspended installations immediately gate new local operations.
Permission and repository-selection changes invalidate the recorded revision;
operations never rely on a cached revision for authority. Created/unsuspended
installations can reopen the local gate, but every operation still queries
GitHub live, so delayed events cannot restore access GitHub revoked. A failed
GitHub lookup, removed repository, reduced permission, suspended installation,
or changed repository ID fails closed. Already in-flight remote writes may
finish; no new work is authorized from event observations. Consumers should
reconcile current provider state rather than replay issue/PR payloads as facts.

## Operator setup

1. Review the manifest's name, homepage, webhook URL, callback URL, permissions
   and events. The callback is `https://quest.moq.dev/api/auth/callback/github`;
   **Request user authorization (OAuth) during installation** is enabled.
   Register the public App once under the service owner's account using
   [GitHub's manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
   or enter the same settings in GitHub. For the manifest flow, submit the JSON
   as the `manifest` form field to GitHub's new-App endpoint with a random
   CSRF state and your operator-controlled redirect URL. Verify returned state
   and exchange the temporary code at `POST /app-manifests/{code}/conversions`
   within one hour. This repository intentionally has no public registration
   callback that would disclose the generated credentials.
2. Store the returned/generated App ID in the `GITHUB_APP_ID` Wrangler var.
   Put the PEM private key and high-entropy webhook secret into Workers secrets
   named `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` using
   `bun run wrangler secret put NAME` from `cloudflare/`. Keep multiline PEM
   intact. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` to this same App's
   OAuth client ID and client secret (the manifest conversion returns
   `client_id` and `client_secret`). No separate OAuth app is used. The App ID
   and OAuth client ID are different values. Never commit conversion responses,
   PEM keys, installation tokens or `.dev.vars`.
3. Install the public App on selected upstream repositories. Existing
   installations must accept permission increases before operations needing
   those grants become available. An App registered before runner reviews
   holds `checks: read`: raise it to **Checks: write** in the App's settings,
   and have each installation accept the change, or runners' reviews are not
   recorded and their heads need a person's approval to land. GitHub's installation UI, not browser form
   claims, chooses repository access. Enroll each repository on `/projects`;
   jobs publish their branches there, with no fork setup.
4. Existing App registrations must add the **Administration**, **Secrets**,
   **Actions**, and **Environments** repository permissions, each read-only,
   which the setup page's [CI check](#read-only-pull-request-ci) reads with.
   Each installation then accepts them on GitHub; until it does, the check
   names them instead of running.
5. Run `bun run wrangler d1 migrations apply DB --remote`, then the normal
   Worker deployment from [README](README.md). GitHub App setup, credentials,
   production deployment and live installation tests
   are operator work; this change performs none of those external actions.
6. Send a GitHub ping, check successful delivery, then test installation
   suspension/removal and repository deselection in a development installation.
   Check that service operations reject revoked access and reduced permissions.
   Use GitHub's delivery/redelivery UI to retry failed deliveries. Rotate the
   private key and webhook secret through Workers secrets and the App settings.

Sign-in starts at the Worker's origin and keeps Better Auth's persisted state
and cookie checks. An authorization callback started by installing the App
directly on GitHub has no sign-in state from the Worker: its code is discarded
and the visitor returns to the sign-in form, then completes a fresh state-bound flow
that ends on `/projects`. A visitor already signed in goes straight there.
Installation and sign-in do not enroll a repository; the maintainer still opts
in from the project picker after a live authority check.

For local tests, fixtures sign bodies and mock all GitHub API responses. No
production credentials, GitHub account or installation are required.

References: [installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation),
[App user authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app),
[Better Auth GitHub Apps](https://better-auth.com/docs/authentication/github#setting-up-your-github-app),
[JWTs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app),
[webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries),
[repository permissions](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user),
and [PR creation](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request).

The earlier draft #43 informed JWT/signature handling and current repository
identity checks. Its Rust/WASM, mirroring, Artifacts credentials, custom changes,
workflow orchestration and repository coordinator design were not reused.

## Project enrollment

`/projects` is the short maintainer setup flow, separate from the quest board
and decision inbox. It links the registered App's installation URL and lists
the repositories to pick from: those the App's installations reach and the
user administers or maintains, each with its contribution state, an Enable
button, or why it cannot be enabled yet (archived, private, no Quest files,
or no OSI-approved license). A repository without Quest files enables through
its [setup pull request](#setup-pull-request).

The picker is navigation, built from the user's own GitHub App token so its
cost does not grow with an installation's size: one read of the user's
installations, one per hundred repositories in each, one GraphQL read per
hundred public repositories for their default branch's `quest` directory, and
one SPDX read per distinct license. GitHub lists each repository with the
user's role, so repositories they only write to never appear. Installations of
other Apps, suspended ones, and ones the webhook gate has blocked are skipped.
Better Auth refreshes an expired user token; when none is available, such as
for an account without a linked GitHub identity, the page asks the maintainer
to sign in with GitHub again or link it. Its Enable button posts the same form
as the project's setup page, so enabling rechecks everything below with an
installation token, including the whole quest tree with `quest check`.

Selecting `owner/repository` by name remains, to reach an enrolled project's
pause and disconnect controls once the picker no longer lists it. Both paths
verify the linked GitHub identity's current maintain/admin authority through
the existing service. Installing the App never creates a `github_projects`
record or enables work.
Repository selection resolves its installation using the App JWT, then reads
metadata with a token restricted to the named repository and metadata-read
permission. Subsequent authorized operations scope tokens by repository ID.
Resolution uses the same installation gates and token revocation as other
reads; it never consumes GitHub's shared anonymous repository-lookup quota.

### Owner allowlist

Until the public release, only repositories whose owner's GitHub ID is in
`ENROLL_OWNERS` (`wrangler.jsonc`, each ID with its login in a comment) may
enroll; the deployed list is the moq-dev organization and the kixelated user.
Users and organizations are checked alike, by ID alone. Logins are not
identities: GitHub frees a deleted or renamed account's login for anyone to
claim. `/projects` says
Quest isn't open yet, and lists another owner's repositories as not open,
without reading their Quest files or licenses. The service's live repository
check treats such an owner like an archived repository: preview, opt-in,
observations, queuing a job, a job's issue or pull request reads, publication,
and merges all refuse it, while pause and disconnect still work, so a project
transferred to another owner can still be stopped. A job its maintainer queued
before such a transfer may still start on their own runners, with nothing from
GitHub through kix; pausing the project holds it. The
webhook route acknowledges another owner's deliveries with `ignored` before
recording anything, by the repository's owner for repository events and the
installation's account for installation events. The seeded local server admits
its fake owner instead. Removing the list opens enrollment to everyone.

The preview reads the default branch at an exact commit, validates its Quest
tree with the shared core, and lists ready quests. Blob selection uses the
core's `isQuest` predicate, excluding root and nested `AGENTS.md`/`CLAUDE.md`
instructions just as the CLI does. It fetches all quest blobs
in one GraphQL read using the scoped installation token, rather than one
external request per file. Blob IDs come from the pinned Git tree; missing,
binary, truncated, partial, or hash-mismatched content fails closed. This keeps
enrollment's external request count independent of the number of quest files.
It rejects private,
unavailable, incomplete, invalid, and symlinked quest snapshots. A repository
without Quest files gets the App's [setup pull request](#setup-pull-request)
instead; nothing else in enrollment writes to the repository.

The D1 enrollment records a project-wide enabled/paused state, distinct from
installation permissions. Every opt-in/resume, pause, and disconnect rechecks
current authority and provider gates. Pause/disconnect do not require valid
Quest files, public visibility, or an active/unarchived repository, so maintainers can stop contributions after
those conditions change. Disconnect deletes the enrollment, not the GitHub
App installation or existing contributions. Remembered selections are only
navigation and never confer authority. Any current maintainer can select an
already enrolled repository by name and reach pause/disconnect even if it has
become private, archived, or Quest-invalid. The enrolled-project lookup proves
current identity and authority independently of the failing preview; it does
not depend on being the original enroller. It matches enrollment by the durable
GitHub repository ID, and refreshes the stored owner/name after authority is
verified, so selecting a renamed repository recovers the same stop controls. If a transfer
or reinstall changes the App installation, those stop controls remain available
while the new installation requires explicit opt-in; selection never silently
reassigns an existing contribution authorization to the new installation. Future job coordination must recheck
this state and current provider eligibility before launching new work.

Contributions require a public repository whose GitHub-detected SPDX license
identifier matches a license marked `isOsiApproved: true` in SPDX's current
published license metadata. A recognized SPDX identifier alone is insufficient.
Missing, `NOASSERTION`, custom, and non-OSI licenses cannot opt in. Add or correct
the repository's license on GitHub and return to setup; no manual attestation
or review bypass is provided. This policy was selected by the maintainer on
2026-10-15 to make public open-source eligibility explicit and independently
verifiable.

Each preview, opt-in, and resume reads
`https://spdx.org/licenses/<detected SPDX ID>.json` without storing a positive
authorization cache. The returned ID must match exactly, and the approval flag
must be the boolean `true`. Failed/malformed lookups fail closed with guidance;
pause and disconnect remain available. Opt-in/resume recheck live repository
identity, visibility, detected license, OSI approval, and maintainer authority
after reading the quest snapshot. Neither license names nor browser form fields
can override those checks. Deprecated SPDX identifiers GitHub still detects
remain supported when SPDX marks that exact ID OSI-approved.

This uses the maintained [SPDX JSON interface](https://github.com/spdx/license-list-data/blob/main/accessingLicenses.md)
instead of maintaining an application allowlist. Approval freshness follows
SPDX's latest published license list and the upstream serving infrastructure.
GitHub's detector only recognizes a limited set of license files, so custom or
unrecognized arrangements stay ineligible even when they may be open-source.
See the official [GitHub license API](https://docs.github.com/en/rest/licenses/licenses),
[SPDX license list](https://spdx.org/licenses/),
[Git trees API](https://docs.github.com/en/rest/git/trees#get-a-tree),
[GraphQL blobs](https://docs.github.com/en/graphql/reference/git#blob), and
[App metadata API](https://docs.github.com/en/rest/apps/apps#get-the-authenticated-app).

### Setup pull request

On a repository whose default branch has no Quest files, **Enable** opens a
short form holding one optional question: what the project is working toward.
Submitting it opens the App's setup pull request, with no runner involved
(`src/github/setup.ts`). The core's `planInit`, the same file plan
`quest init` applies to a checkout, plans it from the default branch's tree:
the skill stubs this deployment's `quest` ships (rendered into
`build/stubs.json` at build time), `quest/README.md` with the answer as its
Goal, the `Quests: ` line in the root agent instructions, the `.gitattributes`
line, and Claude Code's hook entries in `.claude/settings.json`. Heading
syntax in the answer is escaped, and the planned `quest/README.md` must pass
`quest check`, so a goal that would fail it, such as one linking a missing
quest, is refused before anything is written instead of when enabling. A path init would refuse, such as a skill
directory that is not a Quest stub or invalid settings JSON, is named on the
page and nothing is written; kix never deletes or renames a repository's
files. The plan does not follow symlinks, since a Git tree stores their targets
as data: one on a planned path is refused the same way, pointing at running
`quest init` in a clone.

The App publishes the plan as for job branches: blobs, a tree, and a commit
through the Git Data API on `kix/setup`, outside the quest claim namespace,
then a ready pull request against the default branch. Its body lists each
change and what it leaves out, because those steps need judgement about the
repository: pinning `quest` in its tool manager and adapting existing
instructions. kix's jobs need neither, since runners bring their own `quest`.
Without a `flake.nix`, the body says the `bootstrap` job adds one after the
merge.

Until the pull request merges the project is enrolled, setting up
(`github_project_setups`), which the project page and picker show with the pull
request's link. Every open, retry, and enable rechecks the maintainer's
authority, the repository's visibility, and its license live. A `pull_request`
webhook that closes or reopens it only asks the service to look: it rereads the
pull request and, once merged, enables contributions through the same live
checks as **Enable**, including `quest check` on the merged tree, with the
enroller's authority, so no second visit is needed. The project page reconciles
the same way when a webhook was missed, and keeps the reason when enabling
fails. A pull request closed without merging leaves the project setting up,
offering to open it again from the current default branch or to disconnect.
Opening again replaces `kix/setup` only while it is still at a commit the App
recorded writing there; a branch with anyone else's commits is refused, naming
it. Disconnecting leaves the pull request and its branch on GitHub.

The setup preview does not reserve or launch ready quests.
The jobs/funding quests own live eligibility checks and contribution execution.

## Project state and activity

An enrolled project's setup page links to `/projects/github/<owner>/<repo>/state`.
Webhooks reread observations in the background (see below), and a maintainer
can refresh them explicitly with its same-origin form. Each read rereads the default branch at an exact commit using the preview's shared
snapshot reader and validates the Quest tree with the pure core. The authenticated
board and nested quest pages use the existing `Project` seam. Source links retain
the exact commit; live project state never replaces GitHub as authority.

Each refresh advances two passes with independent opaque cursors. The history
pass reads one page of native issues and **all** PRs (including human
contributions and closed/merged PRs); continue reconciliation until it finishes.
A completed history pass detects deleted entities, and refreshing after one starts
again, so missed webhooks and later changes to old entities are recovered. The
occupancy pass reads open PRs and `quest/` branches, the only activity that
decides candidates, and starts again on every refresh after it completes. Its
pages are small, so candidates are normally current after a single refresh no
matter how long the history is. Candidates remain pending while the occupancy
pass is incomplete or a webhook has invalidated it.
This deliberately avoids GitHub's bounded, delayed activity feed; GitHub does
[not automatically redeliver failed webhooks](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).
There is no scheduled background poll in this stage.

Each webhook that names an issue or PR (a comment on a PR names the PR by its
number), or that invalidates candidates (below), asks for a background read of its enabled project once its delivery commits.
The read runs after the response (`waitUntil`) with the App's read-only,
repository-scoped installation token, and is the same read as a refresh: one
page of each pass, plus every entity a webhook named since it was last read,
fetched by number in the same GraphQL query. A new issue or PR therefore shows
its title and state after one read however far the history pass is from it,
and a closed one stops showing as open. A lease in `github_project_state` lets
one read run at a time per project: it answers every request made before it
started, requests made during it get one more read, and duplicate deliveries
never reach it, so a burst costs one or two reads rather than one each. A
per-entity webhook count lets a read clear only the updates it saw. One
invocation reads at most three rounds, to stay within a Worker's subrequest
budget; a request left after them waits for the next webhook or a refresh.
A read overtaken by another read or by a webhook's revision bump reads again.
Paused and disconnected projects are not read. A failed or rate-limited read is
recorded and shown next to the refresh fallback, and is not retried: only a
request made during it gets another round, and otherwise the next webhook or a
refresh reads again. Checks, statuses and other pushes name no entity and
change no candidate, so they cost no read.

The inbox also treats a PR whose row still says open as closed once a
complete, current occupancy pass no longer lists it, so a missed close webhook
corrects itself on the next read.

A single GraphQL activity query reads up to 50 issues, 50 PRs, 100 open PRs and
100 branch claims, keeping external request count independent of entity/file counts. Bulk
D1 writes use `json_each`, avoiding a query per entity or SQLite's parameter
limit. A revision comparison commits each page and cursor atomically; concurrent
refreshes or an intervening webhook cannot publish over a newer observation.
Only a PR opening, closing, reopening or receiving new commits, a `quest/` branch
being created or deleted, or a push to the default branch invalidates candidates
and restarts the occupancy pass; new work waits for the next read, so a job
binds the PR head and tree the maintainer saw. Checks, statuses, comments,
reviews and other pushes do not invalidate candidates, so a busy repository
neither withholds candidates nor races a refresh. Installation tokens remain read-only,
repository-scoped, and revoked after use.

Durable activity items use the GitHub repository ID, entity kind and full database
ID. GitHub's GraphQL `fullDatabaseId` strings and webhook numeric IDs map to the
same stored text key. Duplicate delivery IDs, redelivery with new IDs, later
pushes/comments/reviews, and reconciliation all update the same item. Webhooks
retain identity pointers only, never issue/PR bodies. Authoritative API reads add
escaped titles, state, comment/review counts, current PR head, that head's check
rollup, aggregate review decision, and up to 20 latest reviewer records with an
explicit pagination flag. Raw bodies and individual check logs are not cached:
a PR's body is kept only as whether it has a `## Waiting` section (or the
older `## Decisions needed`).
Unavailable/deleted entities retain their notification identity and are marked
missing rather than disappearing or presenting old state as current.

GitHub reports `mergeStateStatus` `UNKNOWN` while it computes mergeability and
may send no event once it has. A read that sees it on a recorded PR at the same
head keeps the last known merge state, so nothing looks new; at a new head it
stores `UNKNOWN` but leaves the item's change time, so it becomes news once a
definite state arrives. A newly seen PR is news either way.

Closed entities only appear in the activity log, so a read that finds an entity
closed for longer than `RETENTION` (`cloudflare/src/github/state.ts`) deletes its
row instead of updating it, unless a webhook named it again since. History
rereads every entity, so a pass prunes every expired row. The board, inbox, jobs
and `/data` read only open entities and unread webhook pointers, through a
partial index, and the activity log pages 50 rows at a time, so neither read
grows with a repository's history.

A PR associates with a quest only when its head branch exactly matches the quest's
path without `.md` (or an epic's `/README.md`). An unrelated human PR remains in
activity without a guessed association. Open associated PRs and observed quest
branch claims exclude that quest from candidate data; branch claims display as
Claimed on the board. So does a draft PR its starter still holds, one without a
`## Waiting` (or older `## Decisions needed`) section, which the inbox lists as in progress rather than
as a decision; a ready PR or a handed-back draft is Ready to turn in.
As in the CLI, a `quest/` branch whose tip is the head of a merged PR from it
claims nothing, since its work landed; one whose PR closed unmerged, or with
commits pushed after the merge, still does. A push to an existing branch does
not invalidate candidates, so such a push shows on the next occupancy pass.
Runner/run associations belong to job coordination.

Every cached read and refresh proves current maintainer authority, live repository
identity/public visibility, installation access, and enrollment for that
installation. Refresh rechecks those boundaries after provider reads. A
background read has no user, so it checks the same boundaries except maintainer
authority; it publishes observations only, and grants or caches no authority.
Every page and action still rechecks the maintainer acting on it. Paused
projects remain readable but have no candidates. Disconnect cascades cached
snapshots and activity; explicitly enrolling a replacement installation clears
prior observations. No positive authority cache is created. Candidate data is an
observation tied to its commit, **never execution permission**: job coordination
must validate current eligibility, fresh revision, locks, and PRs before a start.
Review/check data is similarly descriptive and cannot approve a merge.

The `/data` endpoint exposes the same authenticated snapshot and open activity with
`Cache-Control: no-store` for future decision and job consumers. The activity
page is a secondary read view; the durable decision inbox and its unread/answer
state belong to the prompts workflow. Neither incoming activity nor refreshing
starts a model, creates a quest/job, spends usage, or writes to GitHub.
