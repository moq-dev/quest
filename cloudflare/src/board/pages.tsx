import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import { type Doc, entries, rooted } from "quest/core";
import { type Crumb, Difficulty, Marker, Paste, SignIn, Token, type User } from "../layout";
import { QuestMap } from "../map";
import { render } from "./markdown";
import {
	type Board,
	boardHref,
	type Milestone,
	milestoneAnchor,
	blobHref,
	type Finished,
	type Group,
	type Item,
	type Progress,
	type Quest,
	type Status,
	findGroup,
	only,
	title,
	trail,
} from "./model";

// The quest board. Display names follow the glossary in design/theme.md.

/** A status's display label, such as "Requires: Fork intake, Changes". */
function label(status: Status, limit = Infinity): string {
	switch (status.kind) {
		case "turn-in":
			return "Ready to turn in";
		case "accepted":
			return status.job ?? "Claimed";
		case "available":
			return "Available";
		case "pending":
			return "Availability pending";
		case "blocked": {
			const titles = status.requires.map((ref) => ref.title);
			const shown = titles.slice(0, limit).join(", ");
			return `Requires: ${titles.length > limit ? `${shown}, and ${titles.length - limit} more` : shown}`;
		}
	}
}

function StatusLabel(props: { status: Status; limit?: number }) {
	const tone = `ql-${props.status.kind}`;
	return <span class={`entry-status ${tone}`}>{label(props.status, props.limit)}</span>;
}

function QuestRow(props: { quest: Quest }) {
	const { quest } = props;
	return (
		<li class="entry">
			<Marker status={quest.status.kind} />
			<a class="entry-title" href={quest.href}>
				{quest.title}
			</a>
			<span class="entry-meta">
				{quest.size && <Difficulty size={quest.size} />}
				<StatusLabel status={quest.status} limit={2} />
			</span>
		</li>
	);
}

function percent(progress: Progress): number {
	return progress.totalWeight === 0 ? 0 : Math.round((100 * progress.weight) / progress.totalWeight);
}

function ProgressBar(props: { progress: Progress; name: string }) {
	const value = percent(props.progress);
	return (
		<div class="progress">
			<div
				class="progress-bar"
				role="progressbar"
				aria-label={`${props.name} progress`}
				aria-valuemin="0"
				aria-valuemax="100"
				aria-valuenow={String(value)}
				aria-valuetext={`${value}% of the work, weighted by difficulty`}
			>
				<span style={`width: ${value}%`} />
			</div>
			<p class="progress-text">
				<strong>
					{props.progress.done} of {props.progress.total}
				</strong>{" "}
				quests done
			</p>
		</div>
	);
}

function Items(props: { items: Item[] }) {
	return (
		<ul class="log">
			{props.items.map((item) =>
				item.kind === "quest" ? <QuestRow quest={item.quest} /> : <EpicRow epic={item.epic} />,
			)}
		</ul>
	);
}

function EpicRow(props: { epic: Group }) {
	const { epic } = props;
	return (
		<li class="epic">
			<div class="epic-head">
				<h3>
					<span class="ql-eyebrow">Epic</span>
					<a href={epic.href}>{epic.title}</a>
				</h3>
				<span class="muted epic-count">
					{epic.progress.done} of {epic.progress.total} done
				</span>
			</div>
			<Items items={epic.items} />
		</li>
	);
}

function MilestoneSection(props: { milestone: Milestone; items: Item[] }) {
	const { milestone } = props;
	const name = milestone.number === "" ? milestone.title : `Milestone ${milestone.number}`;
	return (
		<section class="ql-panel milestone" id={milestoneAnchor(milestone)}>
			<header class="milestone-head">
				{milestone.number !== "" && <p class="ql-eyebrow">{name}</p>}
				<h2>
					<a href={milestone.href}>{milestone.title}</a>
				</h2>
				{milestone.summary && <p class="muted milestone-summary">{milestone.summary}</p>}
				<ProgressBar progress={milestone.progress} name={name} />
			</header>
			<Items items={props.items} />
		</section>
	);
}

function FinishedList(props: { finished: Finished[] }) {
	return (
		<ul class="log">
			{props.finished.map((quest) => (
				<li class="entry">
					<span class="ql-marker" />
					<span class="entry-title">{quest.name}</span>
					<span class="entry-meta">
						{quest.size && <Difficulty size={quest.size} />}
						<span class="entry-status muted">
							Quest complete {quest.href ? <a href={quest.href}>{quest.date}</a> : quest.date}
							{quest.milestone && ` · ${quest.milestone}`}
						</span>
					</span>
				</li>
			))}
		</ul>
	);
}

/** The statuses a visitor can filter the board by, in the order a contributor asks about them. */
export const SHOWN: [Status["kind"], string][] = [
	["available", "Available"],
	["pending", "Availability pending"],
	["accepted", "Claimed"],
	["turn-in", "Ready to turn in"],
	["blocked", "Requires others"],
];

// Counts by status, which double as filters and as the legend for the markers.
function Tally(props: { board: Board; show: Status["kind"] | null }) {
	const base = boardHref(props.board.project);
	return (
		<nav aria-label="Filter quests by status">
			<ul class="tally">
				<li>
					<a href={base} aria-current={props.show === null ? "page" : undefined}>
						All
					</a>
				</li>
				{SHOWN.filter(([kind]) => kind !== "pending" || props.board.counts.pending > 0).map(([kind, name]) => (
					<li class={`ql-${kind}`}>
						<a href={`${base}?show=${kind}`} aria-current={props.show === kind ? "page" : undefined}>
							<Marker status={kind} />
							<strong>{props.board.counts[kind]}</strong> {name}
						</a>
					</li>
				))}
			</ul>
		</nav>
	);
}

/**
 * A project's quest log. An enrolled project's also charts its tree as the
 * quest map, highlighting the quests `agents` work on.
 */
export function BoardPage(props: { board: Board; show: Status["kind"] | null; agents?: Map<string, string> }) {
	const { board, show } = props;
	const { project } = board;
	const recent = board.finished.slice(0, 8);
	const milestones = board.milestones
		.map((milestone) => ({ milestone, items: show ? only(milestone.items, show) : milestone.items }))
		.filter(({ items }) => !show || items.length > 0);
	return (
		<div class="wrap board">
			<header class="board-head">
				<p class="ql-eyebrow">{project.title}</p>
				<h1>Quest log</h1>
				{board.summary && <p class="lede">{board.summary}</p>}
				<Tally board={board} show={show} />
				<p class="muted as-of">
					As of {project.date}
					{project.web && (
						<>
							{" "}
							at <a href={`${project.web}/commit/${project.commit}`}>{project.commit.slice(0, 7)}</a>
						</>
					)}
					.
				</p>
				{project.available === null && (
					<p class="muted">
						Reconciliation with GitHub is incomplete, so availability is pending until every open change and
						quest branch is observed.
					</p>
				)}
			</header>

			{props.agents && <QuestMap board={board} agents={props.agents} />}

			{milestones.map(({ milestone, items }) => (
				<MilestoneSection milestone={milestone} items={items} />
			))}
			{milestones.length === 0 &&
				(show ? (
					<p class="ql-panel muted">
						No quests are {SHOWN.find(([kind]) => kind === show)![1].toLowerCase()} right now.{" "}
						<a href={boardHref(project)}>Show every quest</a>.
					</p>
				) : (
					<p class="ql-panel muted">This project has no quests yet.</p>
				))}

			<div class="board-foot">
				<section class="ql-panel" aria-labelledby="finished-title">
					<h2 id="finished-title">Recently completed</h2>
					{recent.length > 0 ? (
						<FinishedList finished={recent} />
					) : (
						<p class="muted">No finished quests in this history yet.</p>
					)}
				</section>
				<section class="ql-panel" aria-labelledby="issues-title">
					<h2 id="issues-title">Open issues</h2>
					{project.issues.length > 0 ? (
						<ul>
							{project.issues.map((issue) => (
								<li>{issue.title}</li>
							))}
						</ul>
					) : (
						<p class="muted">
							None filed. Contributors file issues from their forks, and a maintainer promotes them into
							quests.
						</p>
					)}
				</section>
			</div>
		</div>
	);
}

/** A section's display heading: `Goal` is Objectives and `Closes` is Rewards. */
const HEADINGS: Record<string, string> = { Goal: "Objectives", Closes: "Rewards" };

/** The breadcrumb trail to a document: the project, its milestone, its epics, then itself. */
export function questCrumbs(board: Board, doc: Doc): Crumb[] {
	const milestone = (group: Group) => board.milestones.find((c) => c.path === group.path && c.number !== "");
	return [
		{ label: board.project.title, href: boardHref(board.project) },
		...trail(board, doc.path).map((group) => ({
			label: milestone(group) ? `Milestone ${milestone(group)!.number}` : group.title,
			href: group.href,
		})),
		{ label: title(doc.title?.text ?? doc.path).name, href: "" },
	];
}

/** One `Required` entry: the quest it names, its status, and what the entry says about it. */
function RequiredRow(props: { board: Board; text: string; target: string | null }) {
	const { board } = props;
	const path = props.target === null ? null : rooted(props.target);
	const quest = path === null ? undefined : board.quests.get(path);
	const group = path === null ? null : findGroup(board, path);
	const why = props.text.includes(" - ") ? props.text.slice(props.text.indexOf(" - ") + 3) : "";
	if (quest) {
		return (
			<li class="entry">
				<Marker status={quest.status.kind} />
				<a class="entry-title" href={quest.href}>
					{quest.title}
				</a>
				<span class="entry-meta">
					{quest.size && <Difficulty size={quest.size} />}
					<StatusLabel status={quest.status} limit={2} />
				</span>
				{why && <span class="entry-why muted">{why}</span>}
			</li>
		);
	}
	if (group) {
		return (
			<li class="entry">
				<span class="ql-marker" />
				<a class="entry-title" href={group.href}>
					{group.title}
				</a>
				<span class="entry-meta muted">
					Epic · {group.progress.done} of {group.progress.total} done
				</span>
				{why && <span class="entry-why muted">{why}</span>}
			</li>
		);
	}
	return (
		<li class="entry">
			<span class="ql-marker" />
			<span class="entry-title">{props.text}</span>
		</li>
	);
}

function Actions(props: { board: Board; quest: Quest; user: User | null; path: string }) {
	const { quest, board } = props;
	const status = quest.status;
	if (status.kind === "turn-in") {
		return (
			<Panel title="Ready to turn in">
				<p>
					{status.change.author} turned this in. <a href={status.change.href}>Review the change</a>.
				</p>
			</Panel>
		);
	}
	if (status.kind === "accepted")
		return (
			<Panel title={status.job ?? "Claimed"}>
				{status.job ? (
					<p>
						An active job claims this quest. Follow its progress in the <a href="/inbox">inbox</a>.
					</p>
				) : status.change ? (
					<p>
						{status.change.author} is working on this in a <a href={status.change.href}>draft PR</a>. It
						waits on you once they mark it ready or hand back decisions.
					</p>
				) : (
					<p>
						A quest branch already claims this work. Review its current GitHub state before starting another
						implementation.
					</p>
				)}
			</Panel>
		);
	if (status.kind === "pending")
		return (
			<Panel title="Availability pending">
				<p class="muted">
					Reconciliation with GitHub is incomplete, so an open change or quest branch may already claim this
					quest. Check again once every page is observed.
				</p>
			</Panel>
		);
	if (status.kind === "blocked") {
		return (
			<Panel title="Not yet available">
				<p class="muted">
					This quest opens once {status.requires.length === 1 ? "the quest" : "everything"} it requires is
					complete. Until then, pick an <a href={`${boardHref(board.project)}?show=available`}>available</a>{" "}
					quest.
				</p>
			</Panel>
		);
	}
	return (
		<>
			<Panel title="Send your agent">
				<p class="muted">Paste this into Claude Code or Codex in your checkout:</p>
				<Paste id="start" text={`/quest-start ${quest.path}`} />
			</Panel>
			<Panel title="Offer tokens">
				<p class="muted">
					Fund this quest with your own agent tokens, and an agent runs it on your fork. The result arrives as
					a change for review.
				</p>
				{props.user ? (
					<>
						<button class="button primary" type="button" disabled>
							<Token /> Offer tokens
						</button>
						<p class="muted note-small">Hosted runs open soon.</p>
					</>
				) : (
					<SignIn path={props.path} primary>
						<Token /> Sign in to offer tokens
					</SignIn>
				)}
			</Panel>
		</>
	);
}

function Panel(props: { title: string; children: Child }) {
	return (
		<section class="ql-panel panel">
			<h2>{props.title}</h2>
			{props.children}
		</section>
	);
}

export function QuestPage(props: { board: Board; doc: Doc; content: string; user: User | null; path: string }) {
	const { board, doc } = props;
	const { project } = board;
	const known = (path: string) => board.docs.has(path);
	const sections = render(project, doc.path, props.content, known);
	const group = findGroup(board, doc.path);
	const quest = group ? undefined : board.quests.get(doc.path);
	const heading = title(doc.title?.text ?? doc.path);
	const markdown = blobHref(project, doc.path);
	const required = entries(doc, "Required");

	return (
		<div class="wrap quest-view">
			<header class="quest-title">
				<h1>
					{quest && <Marker status={quest.status.kind} />}
					{heading.name}
				</h1>
				{quest && (
					<p class="quest-meta">
						{heading.size && <Difficulty size={heading.size} />}
						<StatusLabel status={quest.status} />
					</p>
				)}
				{group && <ProgressBar progress={group.progress} name={group.title} />}
			</header>
			<article class="ql-panel quest-page">
				{sections.map((section) => {
					if (section.heading === "Required") {
						return (
							<>
								{required.length > 0 && (
									<>
										<h2>Requires</h2>
										<ul class="log">
											{required.map((entry) => (
												<RequiredRow board={board} text={entry.text} target={entry.target} />
											))}
										</ul>
									</>
								)}
							</>
						);
					}
					return (
						<>
							{section.heading && <h2>{HEADINGS[section.heading] ?? section.heading}</h2>}
							<div class="quest-body">{raw(section.html)}</div>
						</>
					);
				})}
			</article>
			<aside class="quest-side">
				{quest && <Actions board={board} quest={quest} user={props.user} path={props.path} />}
				{group && group.items.length > 0 && (
					<Panel title="Quests">
						<Items items={group.items} />
					</Panel>
				)}
				<section class="panel-links">
					<p>
						<a href={boardHref(project)}>Back to the quest log</a>
						{markdown && (
							<>
								{" · "}
								<a href={markdown}>View the Markdown</a>
							</>
						)}
					</p>
				</section>
			</aside>
		</div>
	);
}
