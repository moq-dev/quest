import type { Child } from "hono/jsx";
import type { Board } from "./board/model";
import { Bang, Difficulty, Marker, Paste, Query, repo, type Size, type Status, Token } from "./layout";
import { QuestMap } from "./map";

// The home page. Display names follow the glossary in design/theme.md.

const log: { status: Status; label: string; size: Size; title: string }[] = [
	{ status: "turn-in", label: "Ready to turn in", size: "S", title: "Add the CSV endpoint" },
	{ status: "blocked", label: "Requires: CSV endpoint", size: "M", title: "Add a CSV download button" },
	{ status: "available", label: "Available", size: "XS", title: "Document the export format" },
	{ status: "accepted", label: "Accepted by @jdoe", size: "XL", title: "Stream exports for large accounts" },
];

const sample = `# [M] Add a CSV download button

## Goal

People can download their data as a CSV from
the settings page.

## Plan

Call the export endpoint. Show progress, and let
people retry a failed download.

## Required

- [CSV endpoint](/quest/m0/export.md) - the
  button needs something to call

## Closes

- [#42](https://github.com/acme/app/issues/42)
`;

const tree = `quest/
  README.md      # The roadmap
  m0/
    README.md    # The first milestone
    export.md    # Available
    download.md  # Requires: export.md`;

function Section(props: { id: string; eyebrow: string; title: string; children: Child }) {
	return (
		<section class="wrap section" id={props.id} aria-labelledby={`${props.id}-title`}>
			<p class="ql-eyebrow">{props.eyebrow}</p>
			<h2 id={`${props.id}-title`}>{props.title}</h2>
			{props.children}
		</section>
	);
}

export function Home(props: { setup: string; board: Board }) {
	const paste = `Follow ${props.setup} to set up Quest here.`;
	return (
		<>
			<section class="wrap hero">
				<div class="hero-copy">
					<p class="ql-eyebrow">For Claude Code and Codex</p>
					<h1>A quest log for your repo and your agents</h1>
					<p class="lede">Readable plans. Explicit dependencies. Reviewable Git changes.</p>
					<p>
						Quest keeps your plans as Markdown files in your repository, so you and your agents read,
						accept, and finish the same work.
					</p>
					<div class="paste">
						<p class="paste-label">Paste this into Claude Code or Codex:</p>
						<Paste id="paste" text={paste} />
					</div>
					<p class="actions">
						<a class="button primary" href="/docs/getting-started">
							Get started
						</a>
						<a class="button quiet" href={repo}>
							View on GitHub
						</a>
					</p>
				</div>
				<div class="ql-panel hero-log" aria-label="An example quest log">
					<h2 class="log-title">Quest log</h2>
					<ul class="log">
						{log.map((entry) => (
							<li class="entry">
								<Marker status={entry.status} />
								<span class="entry-title">{entry.title}</span>
								<span class="entry-meta">
									<Difficulty size={entry.size} />
									<span
										class={`entry-status ${entry.status === "accepted" ? "muted" : `ql-${entry.status}`}`}
									>
										{entry.label}
									</span>
								</span>
							</li>
						))}
					</ul>
				</div>
			</section>

			<Section id="files" eyebrow="The format" title="Every plan is a file">
				<div class="split">
					<div>
						<p>
							A quest is a Markdown file scoped to one pull request: its objectives, what has been
							decided, and what stands in the way. Epics are folders, and milestones group them by
							horizon.
						</p>
						<p>
							Any agent that can read your repository can find the work. No database, no tracker to sync,
							and <code>quest check</code> keeps every link and dependency honest.
						</p>
					</div>
					<figure class="ql-panel code-page">
						<figcaption>Your repository</figcaption>
						<pre>
							<code>{tree}</code>
						</pre>
					</figure>
				</div>
			</Section>

			<Section id="git" eyebrow="Coordination" title="Coordinate agents through Git">
				<p class="intro">
					No server holds the plan. Agents coordinate the way your team already does: with branches and pull
					requests.
				</p>
				<ol class="lifecycle">
					<li>
						<p class="state ql-available">
							<span class="ql-marker">
								<Bang />
							</span>
							Available
						</p>
						<p>
							<code>quest unblocked</code> lists the quests with nothing standing in their way.
						</p>
					</li>
					<li>
						<p class="state">Accepted by @agent</p>
						<p>
							A live runner lock takes active work. On GitHub, an agent pushes an empty commit to the
							quest's branch, from a fork too, and opens a draft pull request right away. The earliest
							open pull request holds the claim.
						</p>
					</li>
					<li>
						<p class="state ql-turn-in">
							<span class="ql-marker">
								<Query />
							</span>
							Ready to turn in
						</p>
						<p>
							The work lands on that pull request, marked ready for review, plan and code reviewed
							together.
						</p>
					</li>
					<li>
						<p class="state">Quest complete</p>
						<p>Merging deletes the plan, Git keeps its history, and the next quest becomes available.</p>
					</li>
				</ol>
			</Section>

			<Section id="sample" eyebrow="Rendering" title="As written, as read">
				<p class="intro">The same quest: the Markdown your agents edit, and the page you read.</p>
				<div class="split sample">
					<figure class="ql-panel code-page">
						<figcaption>quest/m0/download.md</figcaption>
						<pre>
							<code>{sample}</code>
						</pre>
					</figure>
					<article class="ql-panel quest-page" aria-label="The quest, rendered">
						<header class="quest-head">
							<span class="ql-marker ql-blocked">
								<Bang />
							</span>
							<h3>Add a CSV download button</h3>
							<Difficulty size="M" />
						</header>
						<p class="quest-status ql-blocked">Requires: CSV endpoint</p>
						<h4>Objectives</h4>
						<p>People can download their data as a CSV from the settings page.</p>
						<h4>Plan</h4>
						<p>Call the export endpoint. Show progress, and let people retry a failed download.</p>
						<h4>Requires</h4>
						<ul>
							<li>CSV endpoint: the button needs something to call</li>
						</ul>
						<h4>Rewards</h4>
						<ul>
							<li>Closes #42</li>
						</ul>
					</article>
				</div>
			</Section>

			<Section id="how" eyebrow="Workflow" title="How it works">
				<ol class="steps">
					<li>
						<h3>Plan with your agent</h3>
						<p>
							<code>/quest-plan</code> asks the questions that turn an idea into scoped quests, with
							dependencies, in milestones by priority.
						</p>
					</li>
					<li>
						<h3>Run agents in parallel</h3>
						<p>
							<code>/quest-start</code> takes one quest to a pull request. <code>/quest-spawn</code> sends
							several agents out in parallel.
						</p>
					</li>
					<li>
						<h3>Review and merge</h3>
						<p>
							You review every change. <code>/quest-merge</code> lands it once checks and reviews pass,
							and the next quest becomes available.
						</p>
					</li>
				</ol>
				<p class="note">
					In Codex, use <code>$quest-plan</code> and friends. The binary carries the skills, so your
					repository pins one version.
				</p>
			</Section>

			<Section id="map" eyebrow="Roadmap" title="Long-term plans, as a map">
				<p class="intro">
					Quest is planned with Quest. Milestones become regions, epics become paths, and every quest is a
					waypoint coloured by its size. Each deploy charts the tree as it stands.
				</p>
				<QuestMap board={props.board} />
			</Section>

			<Section id="contribute" eyebrow="Contribute" title="Built in the open">
				<div class="split">
					<div>
						<p>
							Quest is open source, and it is planned in the open with Quest itself. Contributors pick up
							quests from the same log your agents read.
						</p>
						<p>
							Soon you will be able to <span class="ql-tokens">offer tokens</span> from your own agent
							account to fund a quest you want finished.
						</p>
					</div>
					<div class="ql-panel offer">
						<p class="offer-amount">
							<Token />
							<span class="ql-tokens">Offer tokens</span>
						</p>
						<p class="muted">
							Arrives with the quest board. Until then, pick an available quest and send your agent to
							finish it.
						</p>
						<p class="actions">
							<a class="button primary" href={`${repo}/tree/main/quest`}>
								Browse the quests
							</a>
							<a class="button quiet" href={`${repo}/blob/main/CONTRIBUTING.md`}>
								Contributing
							</a>
						</p>
					</div>
				</div>
			</Section>
		</>
	);
}
