import { type Doc, entries, rooted } from "quest/core";
import {
	type Milestone,
	type Board,
	type Progress,
	type Quest,
	type Status,
	boardHref,
	milestoneAnchor,
	flatten,
} from "./board/model";
import { Difficulty } from "./layout";

// The home page's quest map: the project's own tree, read left to right like
// a world map. Milestones are regions, epics are paths, and quests are waypoints
// coloured by size. Statuses use the format's own terms, with no display
// aliases (decided 2026-10-07 on moq-dev/quest#78).

/**
 * One path through a region: an epic, or the quests a milestone lists directly.
 * An epic's title and each waypoint open their board pages.
 */
export type Path = { title: string; href: string | null; progress: Progress | null; waypoints: Quest[] };

export type Region = { milestone: Milestone; href: string; paths: Path[] };

/**
 * How far along its path a quest sits: 0 with nothing in the tree before it,
 * otherwise one past the furthest quest it requires. A required epic counts
 * as everything it still holds.
 */
function steps(docs: Map<string, Doc>): (path: string) => number {
	const memo = new Map<string, number>();
	const step = (path: string): number => {
		const known = memo.get(path);
		if (known !== undefined) return known;
		// A cycle is a `quest check` failure; it must not hang the page.
		memo.set(path, 0);
		const required = entries(docs.get(path)!, "Required")
			.map((entry) => (entry.target === null ? null : rooted(entry.target)))
			.filter((target): target is string => target !== null && docs.has(target));
		const value = required.length === 0 ? 0 : 1 + Math.max(...required.map(step));
		memo.set(path, value);
		return value;
	};
	return step;
}

/** The board's milestones as map regions, each path ordered by step, then priority. */
export function chart(board: Board): Region[] {
	const step = steps(board.docs);
	const ordered = (quests: Quest[]): Quest[] =>
		quests
			.map((quest, rank) => ({ quest, rank, step: step(quest.path) }))
			.sort((a, b) => a.step - b.step || a.rank - b.rank)
			.map(({ quest }) => quest);

	return board.milestones.map((milestone) => {
		// Paths keep the milestone's priority order. The quests it lists directly share
		// one main path, placed where the first of them is listed.
		const loose = milestone.items.flatMap((item) => (item.kind === "quest" ? [item.quest] : []));
		const main: Path = { title: "Main path", href: null, progress: null, waypoints: ordered(loose) };
		const paths = milestone.items.flatMap((item): Path[] => {
			if (item.kind === "quest") return item.quest === loose[0] ? [main] : [];
			const { epic } = item;
			return [
				{
					title: epic.title,
					href: epic.href,
					progress: epic.progress,
					waypoints: ordered(flatten(epic.items)),
				},
			];
		});
		return { milestone, href: `${boardHref(board.project)}#${milestoneAnchor(milestone)}`, paths };
	});
}

/** A waypoint's status in the format's own terms. */
function text(status: Status): string {
	switch (status.kind) {
		case "accepted":
			return "claimed";
		case "available":
			return "ready";
		case "pending":
			return "pending";
		case "blocked":
			return "blocked";
		case "turn-in":
			return "in review";
	}
}

/** The waypoint's tooltip: its title and status, and what a blocked quest requires. */
function tooltip(quest: Quest): string {
	const { status } = quest;
	const line = `${quest.title}: ${text(status)}`;
	if (status.kind !== "blocked" || status.requires.length === 0) return line;
	return `${line}\nRequired: ${status.requires.map((ref) => ref.title).join(", ")}`;
}

/** A waypoint, and what its agent is doing when one works on it. */
function Stop(props: { quest: Quest; agent: string | undefined }) {
	const { quest, agent } = props;
	const kind = quest.status.kind;
	const size = quest.size ? ` ql-${quest.size.toLowerCase()}` : "";
	// Screen readers hear the title first, then the size, status, and agent.
	const name = `${quest.title}, size ${quest.size ?? "unknown"}, ${text(quest.status)}${agent ? `, agent: ${agent}` : ""}`;
	return (
		<li class={`waypoint${size} waypoint-${kind}${agent ? " waypoint-agent" : ""}`}>
			<a
				href={quest.href}
				title={agent ? `${tooltip(quest)}\nAgent: ${agent}` : tooltip(quest)}
				aria-label={name}
			>
				<span class="waypoint-node">
					<span class="waypoint-size">{quest.size ?? "?"}</span>
				</span>
				<span class="waypoint-text">
					<span class="waypoint-title">{quest.title}</span>
					<span class={`waypoint-status ql-${kind}`}>{text(quest.status)}</span>
					{agent && <span class="waypoint-status waypoint-agent-status">Agent: {agent}</span>}
				</span>
			</a>
		</li>
	);
}

/** The map; `agents` highlights the quests agents work on, saying what each is doing. */
export function QuestMap(props: { board: Board; agents?: Map<string, string> }) {
	const { board } = props;
	const web = board.project.web;
	const regions = chart(board);
	return (
		<div class="ql-panel map">
			<ol class="map-regions" role="list">
				{regions.map(({ milestone, href, paths }) => (
					<li class="region">
						<header class="region-head">
							{milestone.number !== "" && <span class="ql-eyebrow">Milestone {milestone.number}</span>}
							<h3>
								<a href={href}>{milestone.title}</a>
							</h3>
							<span class="muted region-count">
								{milestone.progress.done} of {milestone.progress.total} quests complete
							</span>
						</header>
						<ol class="map-paths" role="list">
							{paths.map((path) => (
								<li class="map-path">
									<p class="path-name">
										{path.href ? <a href={path.href}>{path.title}</a> : path.title}
										{path.progress && (
											<span class="muted">
												{" "}
												· {path.progress.done} of {path.progress.total} complete
											</span>
										)}
									</p>
									<ol class="trail" role="list">
										{path.waypoints.map((quest) => (
											<Stop quest={quest} agent={props.agents?.get(quest.path)} />
										))}
									</ol>
								</li>
							))}
						</ol>
					</li>
				))}
			</ol>
			<div class="map-legend">
				<p class="legend-sizes">
					<span class="muted">Size:</span>{" "}
					{(["XS", "S", "M", "L", "XL"] as const).map((size) => (
						<Difficulty size={size} />
					))}
				</p>
				<p class="muted">
					A solid waypoint is ready or in review; a dashed one is blocked.{" "}
					{props.agents && "A ringed one has an agent on it. "}
					{web && (
						<>
							Charted from <a href={`${web}/tree/${board.project.commit}/quest`}>quest/</a> on{" "}
							{board.project.date}.
						</>
					)}
				</p>
			</div>
		</div>
	);
}
