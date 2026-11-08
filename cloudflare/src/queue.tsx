import type { Drop, LandingQueue, PullRef } from "./github/queue";
import { ago } from "./inbox/activity";
import { projectURL } from "./projects";

const MODES: Record<LandingQueue["mode"], string> = {
	"merge-queue": "GitHub's merge queue",
	own: "the watcher's queue",
};
const OUTCOMES: Record<NonNullable<Drop["outcome"]>["kind"], string> = {
	requeued: "Re-enqueued",
	handback: "Handed back",
	ended: "Fix not applied",
	refused: "Refused",
	held: "Held",
};

function Pull({ pull }: { pull: PullRef }) {
	return (
		<a class="entry-title" href={pull.url}>
			#{pull.number} {pull.title}
		</a>
	);
}

function When({ at, now }: { at: string; now: number }) {
	return <time datetime={at}>{ago(now, Date.parse(at))}</time>;
}

/** Each base's landing queue: the order, the builds in progress, and the last day's drops. */
export function QueuePage(props: { owner: string; repository: string; queues: LandingQueue[]; now: number }) {
	const base = projectURL(props.owner, props.repository);
	return (
		<section class="wrap docs projects">
			<p>
				<a href={`${base}/state`}>Activity</a>
				{" · "}
				<a href={`${base}/board`}>Quest board</a>
			</p>
			<h1>
				{props.owner}/{props.repository} landing
			</h1>
			<p class="muted">
				Read from GitHub when this page loads. Drops are those the watcher commented on in the last day.
			</p>
			{props.queues.length === 0 && <p>Nothing is landing, and nothing was dropped in the last day.</p>}
			{props.queues.map((queue) => {
				const builds = queue.entries.filter((entry) => entry.build);
				return (
					<>
						<h2>
							{queue.base} <span class="muted">through {MODES[queue.mode]}</span>
						</h2>
						<h3>Building</h3>
						{builds.length ? (
							<ul class="log">
								{builds.map((entry) => (
									<li class="entry">
										<Pull pull={entry} />
										<span class="entry-meta">
											{entry.build!.url ? (
												<a href={entry.build!.url}>Follow its run</a>
											) : (
												<span>No run yet</span>
											)}
										</span>
									</li>
								))}
							</ul>
						) : (
							<p>Nothing is building.</p>
						)}
						<h3>Queue</h3>
						{queue.entries.length ? (
							<ol class="log">
								{queue.entries.map((entry) => (
									<li class="entry">
										<Pull pull={entry} />
										<span class="entry-meta">
											<span>{entry.status}</span>
										</span>
									</li>
								))}
							</ol>
						) : (
							<p>Nothing is queued.</p>
						)}
						<h3>Recent drops</h3>
						{queue.drops.length ? (
							<ul class="log">
								{queue.drops.map((drop) => (
									<li class="entry">
										<Pull pull={drop.pull} />
										<span class="entry-meta">
											<a href={drop.url}>Dropped{drop.reason ? ` for ${drop.reason}` : ""}</a>
											<When at={drop.at} now={props.now} />
										</span>
										<p>{drop.text}</p>
										{drop.outcome ? (
											<p>
												<a href={drop.outcome.url}>{OUTCOMES[drop.outcome.kind]}</a>{" "}
												<When at={drop.outcome.at} now={props.now} />: {drop.outcome.text}
											</p>
										) : (
											<p class="muted">{drop.next ?? "No outcome yet."}</p>
										)}
									</li>
								))}
							</ul>
						) : (
							<p>No drops in the last day.</p>
						)}
					</>
				);
			})}
		</section>
	);
}
