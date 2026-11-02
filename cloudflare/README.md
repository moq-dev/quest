# Quest Worker

A deployable foundation for Quest on Cloudflare, and the site at
`https://kix.quest`: the quest log for your repo and your agents, on the web.
Hono serves HTML directly, so there is no client bundle; only passkeys
(`src/passkey.js`) and the installed app (`src/app.js` and `src/sw.js`) need
small scripts. Every page renders
inside the shared layout in `src/layout.tsx`, which follows
[the quest log theme](../design/theme.md): the home page (`src/home.tsx`), the
docs under `/docs` (`src/docs.tsx`), the quest board under `/repos`
(`src/board/`), sign-in in the nav, and the not-found page. App pages extend
the layout (breadcrumbs, the status marker, the paste box) rather than adding
a second shell.

The quest board at `/repos/<name>` opens on each milestone with its progress, then
its epics and quests with their statuses, filtered by status with
`?show=available` and the like. Each quest has a page at its path without
`.md`, such as `/repos/quest/quest/m0/kix/prompts`: its Markdown rendered
with raw HTML escaped, its status, and what to do next. Readiness comes from
`quest/core`, so the board agrees with `quest unblocked`. Progress counts finished
quests, which merges delete, from Git history (`scripts/history.ts`), weighted
by size. A deletion counts only when its commit changed something outside
`quest/`, since deleting only plans abandons a quest.

`scripts/build.ts` runs before every check, test, dev server, and deploy. It
renders the repository's `docs/*.md` into `build/docs.json`, so the Markdown
stays the single source and its relative links keep working on GitHub: links to
other docs become `/docs/<name>` and other repository paths point at GitHub. It
also snapshots this repository's `quest/` tree and finished quests into
`build/board.json`, which supplies the public board. Enrolled repositories use authenticated
GitHub snapshots through the same board model. A shallow clone has no
history, so its board shows no finished work. It also copies `design/theme/`,
`src/site.css`, the scripts, and the web app manifest into `build/public/`,
which the Worker serves as static assets (`/theme/theme.css`,
`/theme/logo.svg`, `/theme/og.png`, `/site.css`, `/sw.js`, and the like).
`build/` is ignored by Git.

Better Auth uses D1 for accounts and sessions;
adding social providers or plugins belongs in `src/auth.ts`. It handles OAuth
state, cookies, and callbacks. Form routes enforce the configured origin before
calling Better Auth's server API.

### Sign-in methods

People sign in at `/sign-in` with GitHub, Google (when configured), or a
passkey, and manage their methods at `/account`. Every method reaches the same
local account, but repository authority comes only from the account's linked
GitHub identity and the App installation (`src/github/service.ts`); Google and
passkeys never grant it on their own.

- **Linking is explicit.** A signed-in person links another provider from
  `/account`, proving ownership through its OAuth flow; the emails may differ.
  A matching email never links accounts: signing in with a new provider whose
  email belongs to an existing account fails with instructions to link it.
- **One identity per provider.** A provider identity belongs to one account, and
  an account links at most one of each provider, so the GitHub identity behind
  repository authority is unambiguous. Account merging is not supported.
- **No unlinking yet.** Better Auth's unlink endpoint is disabled, so an account
  cannot strand itself without GitHub authority or a way back in.
- **Passkeys** enroll from `/account` on a session less than a day old, and
  require user verification (a PIN, biometric, or equivalent) to enroll and to
  sign in. Removing one needs the signed-in owner. Recovery is through another
  passkey or a linked provider; there is no administrator bypass.
  `src/passkey.js` drives the browser's WebAuthn JSON helpers directly; where a
  browser lacks them, the passkey buttons stay hidden.

The passkey relying party is the hostname of `AUTH_URL`, and its exact origin
is the only one accepted. Changing the hostname orphans existing passkeys;
people enroll new ones after signing in with a provider.

GitHub is authoritative for enrolled project state. D1 holds accounts,
sessions, GitHub App state, and jobs. The R2 bucket bound as `OUTPUT` holds raw
agent output. The one Durable Object, `RunnerHub`, holds runners' live
connections and keeps no records of its own.

### Jobs

A job is one maintainer-authorized workflow (`plan`, `start`, `iterate`,
`merge`, or `bootstrap`) on one target, pinned to a revision (`src/jobs/`). Maintainers
create, answer, and cancel jobs at `/projects/github/<owner>/<repo>/jobs`, and
every request rechecks current GitHub authority. `start` takes only quests that
observations show ready and unclaimed, except that retrying a failed job does
not count that job's own open pull request as a claim: the one it recorded, or
else the only open one observed on its branch at a commit it published. A
retry records the failed job it `continues`. A new `plan` takes the
maintainer's `idea`, up to 4,000 characters, and optional pasted `context`
(an email, call notes, findings), up to 64,000, on its own `plans/<id>`
target; a retry keeps both. A completed job's result may list suggested
`followups`, and planning them targets `plans/<that job>`: kix writes the
idea and takes the follow-ups and summary as context from the job's own
result, never from the request, and offers them once. A job on an issue or pull request
rereads it from GitHub, refusing one that closed or whose head moved since
observations read it. `iterate` and `merge` jobs trust a head only when
every commit beyond the repository's default branch, independently of the
PR's chosen base, has a valid signature from a current maintain or admin
collaborator. The check runs at creation and again at assignment. Other
heads, including unsigned ones and those kix pushed to, route only to Linux
runners that declare VM builds. A `merge` job runs the merge
skill's loop on an open, non-draft pull request and lands it; it holds the PR
with the `quest:merge` label that local `quest merge` sessions share
(`src/jobs/landing.ts`), as described in [GITHUB.md](GITHUB.md#merge-jobs). A five-minute scheduled sweep retries ended jobs’ hold releases even when a lifecycle callback or GitHub read was missed; a live job, a replacement hold, or an active landing keeps its label. Without a `flake.nix`, the route
offers a `bootstrap` job instead. A paused project gets no new jobs and none are
claimed; resuming it dispatches the jobs that waited. Disconnecting a project
deletes its jobs and their output and tells their runners to stop. Duplicate
requests return the active job for the same target.

Runners are a user's own machines. `quest runner login` makes a bearer token
on the machine and prints a link to `/runners?name=…&platform=…&key=…`, where
`key` is the token's SHA-256; the signed-in user approves it there
(`POST /runners/connect`), and the runner polls `GET /api/runner` with its token
until it is accepted. A script can instead register at `POST /api/runners` and
get a token back. Either way kix stores only the hash. With that token a
runner opens a WebSocket at `/api/runner/connect`. `/runners`, linked from the
decision inbox, lists the user's runners with their presence and accounts, and
moves an account earlier or later in the preference order
(`POST /runners/accounts`). The connection goes to its
owner's `RunnerHub` (`src/jobs/hub.ts`), the one place that owner's jobs are
routed, and the open connection is the runner's presence.

Over the socket the runner sends `status` messages: its opaque accounts, the
attempts it is running, and its free job slots. It also sends `checkpoint`,
`question`, `output`, and `result` messages. Each gets a `reply` with the same
`id` (`src/jobs/protocol.ts`). The hub pushes `assign` and `cancel` messages
whenever jobs or connections change. A status that lists an assigned attempt
acknowledges it; until then the assignment holds one of the runner's slots and
the hub resends it, and cancelling a
job whose assignment was never acknowledged stops it at once. An `assign`
carries the job and its `instructions`, which the runner gives the agent
alongside the workflow's skill, or `null`. A planning job's instructions say
kix writes its pull request's decision record, so the agent does not.

Routing gives a job to the connected runner with a free slot and the owner's
most preferred usable account. A pin, the job's trust, or a paused session's
home runner can override that. Each assignment increments the job's attempt.
Runner messages name their attempt and land only while it is current.

When a runner disconnects, its running jobs get a two-minute grace deadline.
The hub's alarm moves them once it passes, so a returning runner is fenced out.
A status that omits an acknowledged job gives it up at once.

An account limit pauses the job with an account decision; kix never switches
accounts on its own. An answer requeues the job and resumes its session on the
runner that holds it. Until the job sandbox ships, that holds only for the
requester's own answers: the agent acts on an answer with the requester's
machine and credentials, so another maintainer's answer waits, with an
`approval` notification, until the requester approves it
(`POST …/jobs/<job>/approve`) or answers the question themselves. The
assignment carries each answer's `approvedAt`, and the runner refuses to
resume with one that has none.

A `question` carries one round of independent questions
(`src/jobs/prompt.ts`): `{ kind, questions: [{ header?, question, options:
[{ label, description?, recommended? }], multiple? }] }`, where `kind` is
`decision` (the default) or `permission` for a tool permission request. The
service refuses a prompt it cannot render. An agent question's answer is
`{ answers: [{ choices, text? }] }`, one per question, naming offered labels,
the maintainer's own words, or both; an account question's answer is
`{ runner, account }`. A job request may name the `revision` the maintainer
saw, and is refused once observations moved past it.

The current attempt publishes its work over HTTPS at `POST /api/runner/publish`,
not over its connection, so slow GitHub writes never hold up the hub. It sends
file changes as data; the Worker commits them as the GitHub App to the job's
one branch, which a reassigned attempt or a retried failed job continues from,
and opens or updates the job's pull request. Each job records its branch's
`head` and its `pull`.
Changes a workflow may not publish pause the job with a `publication`
decision. The current attempt of a job on an issue or pull request reads it at
`GET /api/runner/context?job=…&attempt=…`, as the App with the requester's
current authority: an issue's text and comments, or a pull request's text,
comments, reviews, unresolved review threads, and checks at its head. A new
plan's attempt reads its `idea` and `context` there instead. [GITHUB.md](GITHUB.md#publication) describes the request, its
validation, and how interrupted publications are reconciled.

### Raw output

Runners upload raw agent output as `output` messages of at most 1 MiB of UTF-8
(`src/jobs/output.ts`). Each attempt numbers its chunks with a contiguous `seq`
from 0 and sends them in order: kix accepts only the attempt's next `seq`,
once the chunk before it is stored, or an identical retry of a chunk it still
holds, which succeeds without writing again. A different chunk with a used `seq` is refused, and so is a retry of an
expired one. Each chunk is one R2 object at `output/<job>/<attempt>/<seq>`,
readable as soon as it lands, and D1 keeps a small index row per chunk plus each
attempt's totals.

An attempt keeps at most 64 MiB and 4096 chunks. The chunk that would pass
either cap, and every later one, gets a reply with `truncated: true` instead of
an error; the job keeps running and its summaries are unaffected. Expiring
chunks never give that capacity back.

Maintainers read output at `GET /projects/github/<owner>/<repo>/jobs/<job>/output`,
in pages of four chunks ordered by `(attempt, seq)`; `?after=<attempt>.<seq>`
continues from a page's `next`, and `truncated` lists the attempts that reached
the cap. Every request rechecks current maintainer authority.

Output is kept for 30 days from each chunk's upload. A bucket lifecycle rule
deletes `output/` objects, and a daily cron (`triggers.crons` in
`wrangler.jsonc`) deletes their index rows; reads skip a row whose object is
already gone. Disconnecting a project queues its jobs' output for deletion in
the same D1 batch that deletes the jobs, then deletes each `output/<job>/`
prefix at once. The cron retries any deletion that failed. An upload racing the
disconnect finds its index row gone, queues its job's prefix for the cron again,
and deletes its own object.

### Decision inbox

After signing in, a maintainer lands on `/inbox` (`src/inbox/`): one active
decision thread across their projects, then what is up next, what is in
progress, and their projects. Each item is one job target (`issues/1`,
`pulls/2`, a quest path), so an issue, its planning job, and that job's
questions stay one item, and webhook updates and reconnects never add another
prompt. Agents waiting on an answer come first, then failed jobs, new pull
requests, new issues, ready quests, and a finished job's suggested follow-ups,
offered as "plan these?" on the `plans/<job>` target their interview takes, so
the offer, the interview, and its questions stay one item. Each webhook rereads its project in the
background, so a new issue or PR arrives with its title, ready to act on. An
item offers only actions that would work: none on a paused project, and only a
refresh while availability is pending or a background read failed, with the
failure's reason. Every action is a plain form post to the job routes, which
recheck authority and move on to the next active decision (or the empty
state) with a short notice such as "Answer recorded"; the item acted on stays
reachable from its list with its earlier answers. A refused action says why
and links back to its item. Prompts render as escaped text, list the
recommended option first, always take an answer in the maintainer's own words,
and never preselect the recommendation. Each project's "Plan something new"
box takes an idea and optional pasted context, which the agent reads as
untrusted, and folds the runner and account behind an automatic default. A
plan's thread keeps what it started from and links its draft proposal once
delivered; a running job names its runner and account. A `publication` decision lists the refused
paths or why the branch is blocked, and takes the maintainer's reply as text.
A job's own upstream branch that changed outside its job also offers Start over,
which resets the branch to the job's revision and queues a new job there.
Another maintainer's answer shows the job's requester the answer with an
approve button above the usual form, and shows everyone else the job waiting.
The inbox reads each target's latest job however old it is: every one that
awaits a decision, and any other whose issue, pull request, or quest is still
observed, so finished work stays set aside. Retrying a failed planning
interview keeps its `plans/<id>` target.

Beside the decisions (below them on a phone), an Agents card shows each job
on the maintainer's projects (`src/inbox/activity.ts`): every target's latest
job while it is queued, running, or waiting, and an ended one while the pull
request it delivered is open and no later job works on that pull request. A
card names the job's target and state (queued, working, runner offline,
waiting on you, account limited, PR open, or stopped), its runner and account,
the agent's latest checkpoint or result summary as escaped text, and how long
ago it wrote it. A working job silent for 15 minutes says "No update since"
instead of guessing. Each card stands in for its job's in-progress row. Raw
output stays behind the card's disclosure: `/app.js` fetches the output route
above only once a maintainer opens it, and shows it as text. An enrolled
project's quest log also charts its tree as the quest map, ringing the quests
those same jobs work on.

A user's projects are those in `github_project_members`. Enrolling a project
adds its enroller, and any other user joins by passing the maintainer check on
one of its pages, such as its setup page; no extra GitHub calls list
maintainers. Membership only decides what the inbox lists: every action still
rechecks authority. A check GitHub denies drops the user's membership along with
their read and skip state for the project, while one that cannot complete, such
as a rate limit, fails the request and leaves membership as it is.
Disconnecting a project removes its memberships.

Each maintainer's read state lives in `inbox_items`, keyed by a version of what
the item showed (a question, a GitHub change, a quest's text). A newer version
is unread again, and skipping an item lasts until it changes. A finished or
stopped job sets its item aside the same way.

### Installed app and notifications

kix.quest installs as a progressive web app (`src/manifest.webmanifest`,
starting at `/inbox`) on Android, desktop browsers, and iOS/iPadOS 16.4+ once
added to the Home Screen. Signed-in pages load `src/app.js`, which registers
the service worker `src/sw.js`, sets the installed app's icon badge to the
unread decision count where the Badging API exists, and drives the
notification switch on `/inbox` and `/account`. The nav shows the same count.
It reads stored observations without rechecking GitHub on every page, so it
reveals a number and nothing else.

A device turns notifications on only from a click, which asks the browser for
permission and stores its push subscription (`push_subscriptions`) for that
user and session. Subscriptions must name a known push service. Signing out
deletes the session's subscriptions, and the sign-out form first drops the
browser's own, which discards pushes still queued for it (a sign-out without
JavaScript leaves those to arrive within the 24-hour TTL). A push service
reporting one gone (404 or 410) deletes it. The switch shows a device as notified only while the
server stores its subscription for the signed-in user, so whoever signs in
next on that browser turns notifications on with their own click. A rotated
subscription replaces the old one only for the user who enabled it, and the
switch drops a browser subscription made for an earlier VAPID key pair. Each push
rechecks that its recipient still maintains the project, as the inbox does.

Only decisions push (`src/push/notify.ts`): an agent's question, a
publication decision, an account limit, a failed job, a new or reopened issue,
and a pull request opened ready for review or marked ready. Drafts,
progress, presence, and finished work never push, and neither does anything on
a paused project. Each push goes once, from the first delivery or the attempt
that changed, to the devices of the project's members, whose inbox shows it. It
carries the project, the item's title, and the unread count; one
notification tag and push `Topic` per item replace an earlier one instead of
stacking. Tapping it opens the item in the inbox. Notifications have no answer
buttons: iOS Web Push does not support them, and every answer goes through the
inbox's stale- and duplicate-answer checks.

`src/push/webpush.ts` implements RFC 8291 message encryption and RFC 8292 VAPID
signing with WebCrypto, so there is no push library; tests check it against
RFC 8291's worked example. Notifications are on only when both
`VAPID_PUBLIC_KEY` (in `wrangler.jsonc`) and the `VAPID_PRIVATE_KEY` secret are
set. `bun scripts/vapid.ts` prints a new pair; replacing it stops every
existing subscription until each device turns notifications on again.

`cloudflare/` is a Bun workspace of the repository root, so the Worker
imports the CLI's core as `quest/core` (`../src/core`), the same parser, checks,
and readiness the CLI runs.

## Development

From the repository root:

```sh
nix develop
just install
cp cloudflare/.dev.vars.example cloudflare/.dev.vars
```

Fill in the local file with a random `AUTH_SECRET` (at least 32 characters) and
the development GitHub App's client ID and client secret. Google sign-in is optional and off by default:
to try it, register a Google OAuth web client with redirect URI
`http://localhost:8787/api/auth/callback/google`, set both Google values in
the local file, and temporarily list `GOOGLE_CLIENT_SECRET` under
`secrets.required` in `wrangler.jsonc`, because Wrangler dev loads only declared
secrets. Configure the GitHub app's homepage as
`http://localhost:8787` and callback as
`http://localhost:8787/api/auth/callback/github`. The file is ignored by Git.
Its `AUTH_URL` overrides the production origin in `wrangler.jsonc`. Use a
separate GitHub App for production. The App needs the manifest's Email addresses
read permission for accounts with private email addresses; see [GITHUB.md](GITHUB.md).

```sh
just worker-dev
```

This applies local D1 migrations and starts Wrangler. Open
`http://localhost:8787`, sign in, and sign out. `/health` reports process health;
it does not probe storage. `/setup` redirects to `SETUP.md` on GitHub, so the
one-line setup paste can use `https://kix.quest/setup`. D1 persists locally
under `cloudflare/.wrangler/`. There are no remote-only bindings: local
development and tests need no Cloudflare login. Wrangler reruns the build when
`src/`, `scripts/`, or `docs/` change.

### Seeded local server

Check UI changes in a browser with representative data, and no GitHub App or
Cloudflare login:

```sh
just worker-seeded  # or: just worker-seeded --port 8788
```

This bundles the Worker as `wrangler deploy --dry-run` does and serves it with
Miniflare at `http://localhost:8787`, on in-memory D1, R2, and Durable
Objects, so every run starts from the same seed. It works where `wrangler dev`
hangs, such as sandboxed agent environments. After applying the checked-in
migrations, `dev/seed.ts` signs in a maintainer and enrolls and observes their
projects through the Worker's own routes: ready, claimed, and blocked quests,
issues (one known only from a webhook, one with a long title), pull requests
with checks and reviews (one clean to merge), and a paused second project. It then adds runners and
jobs that are queued, running, failed, or waiting on an agent's questions, a
tool permission, or an account limit.

`dev/github.ts` fakes GitHub for every outbound request, so nothing leaves
localhost and no real credential is used. It models what publication needs:
commits and trees, fast-forward branch updates on the upstream, and pull
request creation, so a runner's job publishes end to end. Like
GitHub, it scopes each installation token to the repositories and permissions
it was minted for. Notifications are off, since a push
would reach a real push service. Sign in with GitHub completes as the
seeded maintainer. From a shell, sign in with a cookie jar:

```sh
curl -sL -c jar -b jar -H 'Origin: http://localhost:8787' -d provider=github http://localhost:8787/sign-in
```

Check phone and desktop widths with the browser's device emulation. The Worker
tests run the same seed (`test/seed.test.ts`), so it follows schema and route
changes, and later end-to-end tests can start from it. The publication tests
(`test/publish.test.ts`) use the same fake with a smaller world of their own.

## Checks

```sh
just check
just test
```

These include the Worker and run in the existing Linux/macOS Nix CI jobs.
`just worker-check` checks generated binding types, TypeScript, formatting, and
`wrangler deploy --dry-run`. `just worker-test` runs workerd integration tests
with real local D1. Tests cover the home page and rendered docs in the shared
layout, the board and quest pages, statuses, progress, safe Markdown, and
finished quests from history, the mocked GitHub OAuth callback, persisted
sessions, sign-out, and rejected origins/invalid state. Login tests mock GitHub
and Google OAuth and run real P-256 WebAuthn registration and assertions: the
linking rules, collisions, passkey user verification, origin, signature,
replay, and ownership. Job tests race dispatch passes, reassign a disconnected
runner's job and fence its late writes, and cover routing, questions, account
limits, and cancellation. They drive real WebSocket connections through the hub,
including a replaced connection and the alarm that reassigns work, and check the
maintainer-only routes. Publication tests run against a stateful fake of
GitHub's Git and pull request APIs: fenced and stale writes, workflow path
limits and their decisions, lost branch updates and deliveries, iterated heads,
and token scopes. Output tests use local R2 for chunk ordering, retries, the
caps, expiry, and cleanup after a disconnect. Inbox tests answer prompts
through the forms, reject stale revisions and repeated answers, coalesce
duplicate webhooks, and hide a project whose maintainer lost authority. Push
tests encrypt RFC 8291's example, verify VAPID signatures, decrypt what a
subscribed device receives, and check that only decisions push, once each. No
OAuth credentials or Cloudflare account are required for checks.

After changing bindings, regenerate types:

```sh
bun run --cwd cloudflare types
```

Wrangler is a dependency pinned in the root `bun.lock` and shared with the
test plugin; the Nix shell does not provide it. Use `bun run wrangler` from
`cloudflare/` for the documented deployment commands so generated types and
deployment use that same version, on Bun (`cloudflare/bunfig.toml`).

## Deployment

Deployment is manual. This scaffold does not provision resources or deploy
from CI. In the Nix shell, enter `cloudflare/` and authenticate:

```sh
cd cloudflare
bun run wrangler login
bun run wrangler d1 create quest-auth
bun run wrangler r2 bucket create quest-output
bun run wrangler r2 bucket lifecycle add quest-output output-expiry output/ --expire-days 30
```

The lifecycle rule is bucket configuration, not part of `wrangler.jsonc`, so
check it on an existing bucket with
`bun run wrangler r2 bucket lifecycle list quest-output`. Keep it at the
30 days the Worker's cron uses (`RETENTION` in `src/jobs/output.ts`).

The checked-in config deploys to `https://kix.quest` as a Workers custom
domain, which requires the `kix.quest` zone in the same Cloudflare account;
`workers.dev` is disabled so sign-in has one origin. `AUTH_URL` is the only
authentication origin and supplies generated absolute links.

For an existing deployment, retain the Worker name, D1 database ID, and
`AUTH_SECRET` so account data is preserved. The `create` commands above are
for a fresh deployment only. For another environment, change `routes`,
`AUTH_URL`, Worker name, account, database, bucket, and OAuth credentials
together.

Register the production GitHub App from [the manifest](github-app-manifest.json),
which includes callback `https://kix.quest/api/auth/callback/github` and requests
user authorization during installation. Use that App's client ID and client
secret as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`; no separate GitHub OAuth
app is needed. For Google sign-in, also register
a production Google OAuth web client with redirect URI
`https://kix.quest/api/auth/callback/google`, set its public client ID as
`GOOGLE_CLIENT_ID` in `wrangler.jsonc`, and set the secret with
`bun run wrangler secret put GOOGLE_CLIENT_SECRET`; without both, Google is
not offered. The secret is optional, so it is not listed under `secrets.required`.
Notifications are optional the same way: run `bun scripts/vapid.ts`, set its
public key as `VAPID_PUBLIC_KEY` in `wrangler.jsonc`, and set the private key
with `bun run wrangler secret put VAPID_PRIVATE_KEY`. Deploys fail until every
required secret is set, so register the GitHub App first ([GITHUB.md](GITHUB.md)
steps 1 and 2), then set secrets interactively:

```sh
bun run wrangler secret put AUTH_SECRET
bun run wrangler secret put GITHUB_CLIENT_ID
bun run wrangler secret put GITHUB_CLIENT_SECRET
bun run wrangler secret put GITHUB_APP_PRIVATE_KEY
bun run wrangler secret put GITHUB_WEBHOOK_SECRET
bun run wrangler d1 migrations apply DB --remote
bun run types
bun run check
bun run deploy
```

D1 schema migrations are applied separately before deployment. The `exports`
tombstone in `wrangler.jsonc` deletes the legacy `RepositoryCoordinator`
Durable Object namespace, and any storage it held, from Workers deployed before
it was removed; Wrangler reports a stale tombstone where none exists. Remove the
tombstone after the next production deploy. This does not affect the D1 auth
database. The same `exports` block creates the SQLite-backed `RunnerHub` class
bound as `RUNNERS`; it stores only its owner's ID, so it needs no data migration.

After deploying, verify `/health`, `/setup`, and a theme asset, then complete
sign-in/sign-out in the browser.

The auth schema migration is checked in for review. When upgrading Better Auth
or adding a plugin, generate/review its schema changes and add a D1 migration;
do not migrate the production database on HTTP requests.

References: [Durable Object migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/),
[Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/),
[Better Auth database](https://better-auth.com/docs/concepts/database), and
[Hono integration](https://better-auth.com/docs/integrations/hono).

The server-only GitHub App integration, reviewed manifest, permission rationale,
webhook lifecycle and operator registration are documented in [GITHUB.md](GITHUB.md).
