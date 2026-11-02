import type { Activity, ProjectState, Pull } from "./github/state";
import type { Candidate, Enrollment, ProjectPreview } from "./github/service";
import { Difficulty, Marker } from "./layout";
import { title } from "./board/model";

export function projectURL(owner: string, name: string) {
	return `/projects/github/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export function ProjectStopControls({ project }: { project: Enrollment }) {
	const action = projectURL(project.owner, project.name);
	return (
		<>
			{project.state === "enabled" && (
				<form method="post" action={action}>
					<input type="hidden" name="id" value={project.id} />
					<input type="hidden" name="state" value="paused" />
					<p>
						<button class="button quiet">Pause contributions</button>
					</p>
				</form>
			)}
			<form method="post" action={action}>
				<input type="hidden" name="id" value={project.id} />
				<input type="hidden" name="state" value="disconnected" />
				<button class="button quiet">Disconnect project</button>
			</form>
		</>
	);
}

/** One repository the App reaches and the user maintains, with its state or why it cannot be enabled. */
function CandidateRow({ candidate }: { candidate: Candidate }) {
	const href = projectURL(candidate.owner, candidate.name);
	const eligible = !candidate.state && !candidate.problems.length;
	return (
		<li class="entry">
			<Marker status={candidate.state ? "accepted" : eligible ? "available" : "blocked"} />
			<a class="entry-title" href={href}>
				{candidate.owner}/{candidate.name}
			</a>
			<div class="entry-meta">
				{candidate.state ? (
					<span>
						{candidate.state === "enabled" ? "Contributions enabled" : "Contributions paused"}.{" "}
						<a href={href}>Manage</a>
					</span>
				) : eligible ? (
					<form method="post" action={href}>
						<input type="hidden" name="id" value={candidate.id} />
						<input type="hidden" name="state" value="enabled" />
						<button class="button primary">Enable contributions</button>
					</form>
				) : (
					<span>
						{candidate.problems.join(" ")}
						{candidate.setup && (
							<>
								{" "}
								<a href="/setup">Set up Quest</a>, then return here.
							</>
						)}
					</span>
				)}
			</div>
		</li>
	);
}

export function ProjectsPage(props: {
	projects: Enrollment[];
	/** The repositories to pick from, or null when the user's GitHub token cannot list them. */
	candidates: Candidate[] | null;
	/** Whether the user has a linked GitHub account, without which nothing can be listed. */
	linked: boolean;
	installation: string | null;
	error?: string;
}) {
	return (
		<section class="wrap docs projects">
			<h1>Project setup</h1>
			<p class="intro">
				Choose a public open-source repository you maintain. Keep its issues, reviews, CI, and merge protections
				on GitHub.
			</p>
			{props.error && <p role="alert">{props.error}</p>}
			<section class="ql-panel panel">
				<h2>Your repositories</h2>
				<p>
					Repositories the GitHub App can reach that you maintain or administer. Enabling one verifies your
					authority again and reads Quest files on its default branch.
				</p>
				{!props.linked ? (
					<p role="alert">
						<a href="/account">Link your GitHub account</a> to list the repositories you maintain.
					</p>
				) : props.candidates === null ? (
					<p role="alert">
						Your GitHub repositories could not be listed. Sign out, then sign in with GitHub again.
					</p>
				) : props.candidates.length ? (
					<ul class="log">
						{props.candidates.map((candidate) => (
							<CandidateRow candidate={candidate} />
						))}
					</ul>
				) : (
					<p>The App is not installed on any repository you maintain yet.</p>
				)}
				{props.installation ? (
					<p>
						<a class="button quiet" href={props.installation}>
							Install or configure the App
						</a>
					</p>
				) : (
					<p class="muted">The operator has not configured the GitHub App yet.</p>
				)}
				<p class="note-small">
					Installing the App on a repository does not enable contributions; GitHub returns you here to choose.
					Funding a quest does not grant maintainer permissions.
				</p>
			</section>
			<section class="ql-panel panel">
				<h2>Find an enrolled project</h2>
				<p>
					Select an enrolled project by name to pause or disconnect it, even if its eligibility has changed or
					the App no longer reaches it.
				</p>
				<form method="get" action="/projects/select" class="project-select">
					<label for="repository">GitHub owner/repository</label>
					<input id="repository" name="repository" placeholder="your-org/your-project" required />
					<button class="button quiet">Find project</button>
				</form>
			</section>
			{props.projects.length > 0 && (
				<section>
					<h2>Your enrolled projects</h2>
					<ul>
						{props.projects.map((project) => (
							<li>
								<a href={projectURL(project.owner, project.name)}>
									{project.owner}/{project.name}
								</a>{" "}
								· {project.state === "enabled" ? "Contributions enabled" : "Contributions paused"}
								<form method="post" action={projectURL(project.owner, project.name)}>
									<input type="hidden" name="id" value={project.id} />
									{project.state === "enabled" && (
										<button class="button quiet" name="state" value="paused">
											Pause contributions
										</button>
									)}
									<button class="button quiet" name="state" value="disconnected">
										Disconnect project
									</button>
								</form>
							</li>
						))}
					</ul>
				</section>
			)}
		</section>
	);
}

export function ProjectSetupPage(props: { preview: ProjectPreview; enrollment: Enrollment | null; error?: string }) {
	const { preview } = props;
	const repo = preview.repository;
	const href = `https://github.com/${repo.owner}/${repo.name}`;
	const action = projectURL(repo.owner, repo.name);
	return (
		<section class="wrap docs projects">
			<p>
				<a href="/projects">Project setup</a>
			</p>
			<h1>
				{repo.owner}/{repo.name}
			</h1>
			{props.error && <p role="alert">{props.error}</p>}
			<section class="ql-panel panel">
				<h2>
					{preview.state === "enabled"
						? "Contributions enabled"
						: preview.state === "paused"
							? "Contributions paused"
							: "Enable contributions"}
				</h2>
				<p>
					Opting in makes ready quests on the default branch eligible for funded implementation. There is no
					second approval flag per quest. Your normal GitHub review rules, CI, and merge protections still
					apply.
				</p>
				{preview.licenseError ? (
					<p class="muted" role="alert">
						{preview.licenseError}
					</p>
				) : (
					<p class="muted">
						GitHub detects {preview.license?.name} ({preview.license?.spdx_id}), an OSI-approved license.
					</p>
				)}

				<form method="post" action={action}>
					<input type="hidden" name="id" value={repo.id} />
					<input type="hidden" name="state" value="enabled" />
					<button
						class="button primary"
						disabled={preview.licenseError !== null || preview.state === "enabled"}
					>
						{preview.state === "enabled"
							? "Contributions enabled"
							: preview.state === "paused"
								? "Resume contributions"
								: "Enable contributions"}
					</button>
				</form>
				{props.enrollment && (
					<>
						{preview.state === null && (
							<p class="note-small">
								The App installation changed. Enable contributions explicitly for this installation, or
								stop the previous enrollment below.
							</p>
						)}
						<p class="note-small">
							Pause stops new work. Disconnect removes this project's opt-in; it does not uninstall the
							App or change existing GitHub contributions.
						</p>
						<ProjectStopControls project={props.enrollment} />
					</>
				)}
			</section>
			<section>
				<h2>Ready quests</h2>
				{props.enrollment && (
					<p>
						<a href={`${action}/state`}>View project activity and quest board</a>
					</p>
				)}
				<p class="muted">
					From <a href={`${href}/tree/${preview.commit}`}>{preview.branch}</a> at {preview.commit.slice(0, 7)}
					. This preview does not start work.
				</p>
				{preview.quests.length ? (
					<ul class="log">
						{preview.quests.map((quest) => {
							const heading = title(quest.title);
							return (
								<li class="entry">
									<Marker status="available" />
									<a
										class="entry-title"
										href={`${href}/blob/${preview.commit}/${quest.path.split("/").map(encodeURIComponent).join("/")}`}
									>
										{heading.name}
									</a>
									<span class="entry-meta">
										Ready{heading.size && <Difficulty size={heading.size} />}
									</span>
								</li>
							);
						})}
					</ul>
				) : (
					<p>No ready quests on the default branch yet. Update and merge your plans on GitHub.</p>
				)}
			</section>
		</section>
	);
}

export function ProjectStatePage(props: {
	owner: string;
	repository: string;
	state: ProjectState | null;
	/** One page of the activity log, and where the next begins. */
	log: { items: Activity[]; next: string | null };
}) {
	const base = projectURL(props.owner, props.repository);
	const state = props.state;
	return (
		<section class="wrap docs projects">
			<p>
				<a href={base}>Project setup</a>
			</p>
			<h1>
				{props.owner}/{props.repository} activity
			</h1>
			<form method="post" action={`${base}/refresh`}>
				<button class="button primary">
					{state && !state.complete ? "Continue reconciliation" : "Refresh from GitHub"}
				</button>
			</form>
			<p class="muted">
				GitHub issues and pull requests are source material. Webhooks reread the project in the background;
				refreshing does the same by hand. Neither starts work or approves a merge.
			</p>
			{state?.failure && <p role="alert">The last background read failed: {state.failure}</p>}
			{state ? (
				<>
					<p>
						Snapshot{" "}
						<a href={`${state.project.web}/commit/${state.project.commit}`}>
							{state.project.commit.slice(0, 7)}
						</a>
						.{" "}
						{state.complete
							? "Reconciliation complete."
							: "Reconciliation incomplete. Continue to include every page."}
					</p>
					<p>
						<a href={`${base}/board`}>Quest board</a>
						{" · "}
						<a href={`${base}/data`}>Observed data</a>
					</p>
					<h2>Claimed quests</h2>
					{state.claims.length ? (
						<ul>
							{state.claims.map((path) => (
								<li>{path}</li>
							))}
						</ul>
					) : (
						<p>No observed branch claims.</p>
					)}
					<h2>Issues and pull requests</h2>
					{props.log.items.length ? (
						<ul class="log">
							{props.log.items.map((item) => (
								<li class="entry">
									<a
										class="entry-title"
										href={`${state.project.web}/${item.kind === "pull" ? "pull" : "issues"}/${item.number}`}
									>
										{item.kind === "pull" ? "PR" : "Issue"} #{item.number}:{" "}
										{item.data?.title ?? "Awaiting reconciliation"}
									</a>
									<span class="entry-meta">
										{item.missing
											? "Unavailable on GitHub"
											: (item.data?.state ?? "New notification")}
										{item.kind === "pull" && item.data && (
											<>
												{" · Checks: "}
												{(item.data as Pull).commits.nodes.at(-1)?.commit.statusCheckRollup
													?.state ?? "No checks"}
												{" · Review: "}
												{(item.data as Pull).reviewDecision ?? "No review decision"}
											</>
										)}
									</span>
								</li>
							))}
						</ul>
					) : (
						<p>No activity observed yet.</p>
					)}
					{props.log.next && (
						<p>
							<a href={`${base}/state?before=${encodeURIComponent(props.log.next)}`}>Older activity</a>
						</p>
					)}
				</>
			) : (
				<p>Refresh to read this enrolled project's quest tree and activity.</p>
			)}
		</section>
	);
}
