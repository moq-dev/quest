import type { Platform } from "./jobs/store";

// The signed-in user's runners and agent accounts: a secondary view off the
// decision inbox. It shows each runner's presence, its accounts, and the
// preference order routing follows, and approves a `quest runner login`.

export type RunnerView = {
	id: string;
	name: string;
	platform: Platform;
	vm: number;
	online: boolean;
	accounts: {
		runner: string;
		id: string;
		provider: string;
		kind: string;
		label: string;
		rank: number;
		limited: number;
	}[];
};

/** A machine asking to connect: what `quest runner login` put in its link. */
export type Connect = { name: string; platform: Platform; key: string };

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const platforms: Record<Platform, string> = { linux: "Linux", darwin: "macOS" };

/** Parse the connect link's query, or null when it is not a valid request. */
export function connectRequest(query: Record<string, string | undefined>): Connect | null {
	const { name, platform, key } = query;
	if (!name?.trim() || name.length > 100 || (platform !== "linux" && platform !== "darwin")) return null;
	if (!key || !/^[0-9a-f]{64}$/.test(key)) return null;
	return { name, platform, key };
}

function ConnectForm(props: { connect: Connect }) {
	const { name, platform, key } = props.connect;
	return (
		<section class="ql-panel panel">
			<h2>Connect a runner</h2>
			<p>
				<strong>{name}</strong> ({platforms[platform]}) asks to run jobs for your projects with its own agent
				accounts.
			</p>
			<p class="note" role="alert">
				Connect it only if you just ran <code>quest runner login</code> on your own machine. A runner receives
				your jobs and the code of every project they touch.
			</p>
			<form method="post" action="/runners/connect">
				<input type="hidden" name="name" value={name} />
				<input type="hidden" name="platform" value={platform} />
				<input type="hidden" name="key" value={key} />
				<button class="button primary">Connect {name}</button>
			</form>
		</section>
	);
}

export function RunnersPage(props: { runners: RunnerView[]; connect: Connect | null; connected?: string }) {
	// The owner's preference order spans their runners, as routing reads it.
	const ordered = props.runners
		.flatMap((runner) => runner.accounts.map((account) => ({ runner, account })))
		.sort(
			(a, b) =>
				a.account.rank - b.account.rank ||
				compare(a.account.runner, b.account.runner) ||
				compare(a.account.id, b.account.id),
		);
	return (
		<section class="wrap docs runners">
			<h1>Runners</h1>
			<p class="intro">
				Runners are your own Linux and macOS machines running <code>quest runner</code>. Each one drives the
				official agent CLIs with the accounts signed in on it; kix never holds their tokens. A runner pools its
				Claude subscriptions behind its own proxy, which rotates between them, so they show here as one account.
			</p>
			{props.connected && (
				<p class="note" role="status">
					Connected {props.connected}. It goes online once <code>quest runner</code> starts.
				</p>
			)}
			{props.connect && <ConnectForm connect={props.connect} />}
			<section class="ql-panel panel">
				<h2>Machines</h2>
				{props.runners.length ? (
					<ul class="log">
						{props.runners.map((runner) => (
							<li class="entry">
								<span class="entry-title">{runner.name}</span>
								<span class="entry-meta">
									{runner.online ? "Online" : "Offline"} · {platforms[runner.platform]}
									{runner.vm ? " · builds untrusted heads in a VM" : ""} · {runner.accounts.length}{" "}
									{runner.accounts.length === 1 ? "account" : "accounts"}
								</span>
							</li>
						))}
					</ul>
				) : (
					<p>
						No runners yet. On a Linux or macOS machine with Nix, run <code>quest runner login</code>, then{" "}
						<code>quest runner account add</code> and <code>quest runner</code>.
					</p>
				)}
			</section>
			<section class="ql-panel panel">
				<h2>Account preference</h2>
				{ordered.length ? (
					<>
						<p class="muted">
							Jobs go to the first account here whose runner is online with a free slot. A limited account
							is skipped until its runner reports it usable again.
						</p>
						<ol class="log">
							{ordered.map(({ runner, account }, i) => (
								<li class="entry">
									<span class="entry-title">{account.label}</span>
									<span class="entry-meta">
										{runner.name} · {account.kind === "subscription" ? "subscription" : "API key"}
										{account.limited ? " · limited" : ""}
									</span>
									<form method="post" action="/runners/accounts">
										<input type="hidden" name="runner" value={runner.id} />
										<input type="hidden" name="account" value={account.id} />
										<button
											class="button quiet"
											name="move"
											value="up"
											disabled={i === 0}
											aria-label={`Prefer ${account.label} on ${runner.name} earlier`}
										>
											Up
										</button>
										<button
											class="button quiet"
											name="move"
											value="down"
											disabled={i === ordered.length - 1}
											aria-label={`Prefer ${account.label} on ${runner.name} later`}
										>
											Down
										</button>
									</form>
								</li>
							))}
						</ol>
					</>
				) : (
					<p class="muted">
						No accounts yet. Add one on a runner with <code>quest runner account add</code>.
					</p>
				)}
			</section>
			<p>
				<a href="/inbox">Back to your decisions</a>.
			</p>
		</section>
	);
}
