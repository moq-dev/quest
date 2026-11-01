import type { Child } from "hono/jsx";
import { raw } from "hono/html";

// The site shell: every HTML page the Worker serves renders inside Layout.
// Colours, type, and glyphs follow design/theme.md; tokens live in /theme/theme.css.

export const repo = "https://github.com/moq-dev/quest";

const fonts =
	"https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Inter:wght@400;600&display=swap";

export type User = { name: string };

// A step in the breadcrumb trail; the last one is the current page.
export type Crumb = { label: string; href: string };

export type Page = {
	// Omitted on the home page, which uses the full hook as its title.
	title?: string;
	description: string;
	origin: string;
	// The current path, where signing in returns.
	path: string;
	user: User | null;
	/** The signed-in maintainer's new decisions, for the nav and the installed app's badge. */
	unread: number;
	crumbs?: Crumb[];
};

export function Layout(props: Page & { children: Child }) {
	const title = props.title ? `${props.title} · Quest` : "Quest: a quest log for your repo and your agents";
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{title}</title>
				<meta name="description" content={props.description} />
				<meta name="theme-color" content="#0a0c11" />
				<meta property="og:title" content={title} />
				<meta property="og:description" content={props.description} />
				<meta property="og:image" content={`${props.origin}/theme/og.png`} />
				<meta name="twitter:card" content="summary_large_image" />
				<link rel="icon" href="/theme/logo.svg" type="image/svg+xml" />
				<link rel="manifest" href="/manifest.webmanifest" />
				<link rel="apple-touch-icon" href="/theme/icon-192.png" />
				<link rel="preconnect" href="https://fonts.googleapis.com" />
				<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
				<link rel="stylesheet" href={fonts} />
				<link rel="stylesheet" href="/theme/theme.css" />
				<link rel="stylesheet" href="/site.css" />
			</head>
			<body data-unread={props.user ? String(props.unread) : undefined}>
				<header class="site-header">
					<nav class="wrap nav" aria-label="Site">
						<a class="brand" href="/">
							<img src="/theme/logo.svg" alt="" width="32" height="32" />
							Quest
						</a>
						{props.user && (
							<a href="/inbox" aria-label={props.unread ? `Decisions, ${props.unread} new` : undefined}>
								Decisions
								{props.unread > 0 && <span class="count">{props.unread}</span>}
							</a>
						)}
						<a href="/repos/quest">Quests</a>
						<a href="/projects">Projects</a>
						<a href="/docs">Docs</a>
						<a href={repo}>GitHub</a>
						<span class="account">
							{props.user ? (
								<>
									<a class="muted" href="/account">
										Signed in as {props.user.name}.
									</a>
									<form method="post" action="/sign-out">
										<button class="button quiet">Sign out</button>
									</form>
								</>
							) : (
								<a class="button quiet" href={`/sign-in?next=${encodeURIComponent(props.path)}`}>
									Sign in
								</a>
							)}
						</span>
					</nav>
				</header>
				{props.crumbs && <Crumbs crumbs={props.crumbs} />}
				<main>{props.children}</main>
				<footer class="wrap site-footer">
					<p>
						<a href="/">Quest</a> · <a href="/docs">Docs</a> · <a href={repo}>GitHub</a> · MIT or Apache-2.0
					</p>
				</footer>
				<script>{raw(copyScript)}</script>
				{props.user && <script src="/app.js" defer></script>}
			</body>
		</html>
	);
}

// Signing in returns to `path`.
export function SignIn(props: { path: string; primary?: boolean; children: Child }) {
	return (
		<form method="post" action="/sign-in">
			<input type="hidden" name="next" value={props.path} />
			<button class={`button ${props.primary ? "primary" : "quiet"}`}>{props.children}</button>
		</form>
	);
}

function Crumbs(props: { crumbs: Crumb[] }) {
	return (
		<nav class="wrap crumbs" aria-label="Breadcrumb">
			<ol>
				{props.crumbs.map((crumb, i) =>
					i === props.crumbs.length - 1 ? (
						<li aria-current="page">{crumb.label}</li>
					) : (
						<li>
							<a href={crumb.href}>{crumb.label}</a>
						</li>
					),
				)}
			</ol>
		</nav>
	);
}

// A line to paste, such as into an agent, with a copy button.
export function Paste(props: { id: string; text: string }) {
	return (
		<div class="paste-box">
			<code id={props.id}>{props.text}</code>
			<button class="button" type="button" data-copy={props.id} hidden>
				Copy
			</button>
		</div>
	);
}

/**
 * Turning decision notifications on or off for this device. /app.js reveals
 * the control that fits the browser, and asks for permission only when the
 * enable button is clicked. `compact` hides it once this device is on.
 */
export function Notifications(props: { publicKey: string | null; compact?: boolean }) {
	if (!props.publicKey) return null;
	return (
		<div class="notify" data-push={props.publicKey} data-compact={props.compact ? "" : undefined} hidden>
			<p class="muted" role="status" aria-live="polite" data-push-status></p>
			<button class="button primary" type="button" data-push-enable hidden>
				Notify me on this device
			</button>
			<button class="button quiet" type="button" data-push-disable hidden>
				Turn off on this device
			</button>
		</div>
	);
}

// Progressive enhancement: reveal copy buttons only where the clipboard works.
const copyScript = `for (const button of document.querySelectorAll("[data-copy]")) {
	if (!navigator.clipboard) continue;
	button.hidden = false;
	button.addEventListener("click", async () => {
		await navigator.clipboard.writeText(document.getElementById(button.dataset.copy).textContent);
		button.textContent = "Copied";
		setTimeout(() => (button.textContent = "Copy"), 2000);
	});
}`;

// Status glyphs, drawn like the mark. Colour comes from the marker class.
export function Bang() {
	return (
		<svg class="glyph" viewBox="-10 -22 20 44" aria-hidden="true">
			<g fill="currentColor" stroke="#0a0c11" stroke-width="2.4" stroke-linejoin="round" paint-order="stroke">
				<path d="M-7 -19 H7 L3.5 4 H-3.5 Z" />
				<rect x="-5" y="8.5" width="10" height="10" rx="2" />
			</g>
		</svg>
	);
}

export function Query() {
	return (
		<svg class="glyph" viewBox="-12 -22 24 44" aria-hidden="true">
			<g stroke-linecap="round" stroke-linejoin="round">
				<path d="M-8 -9 C-8 -21 8 -21 8 -9 C8 -1 0 -1 0 5" fill="none" stroke="#0a0c11" stroke-width="9.5" />
				<path d="M-8 -9 C-8 -21 8 -21 8 -9 C8 -1 0 -1 0 5" fill="none" stroke="currentColor" stroke-width="5" />
				<rect
					x="-5"
					y="8.5"
					width="10"
					height="10"
					rx="2"
					fill="currentColor"
					stroke="#0a0c11"
					stroke-width="2.4"
					paint-order="stroke"
				/>
			</g>
		</svg>
	);
}

// A token chip: agent tokens, donated or spent. Display only.
export function Token() {
	return (
		<svg class="glyph token" viewBox="0 0 20 20" aria-hidden="true">
			<path d="M10 1.5 L17.4 5.75 V14.25 L10 18.5 L2.6 14.25 V5.75 Z" fill="#ffc53d" />
			<path d="M10 6 L13.5 10 L10 14 L6.5 10 Z" fill="#0a0c11" />
		</svg>
	);
}

// A quest's status, per the glossary in design/theme.md.
export type Status = "available" | "pending" | "blocked" | "accepted" | "turn-in";

// A status glyph: a yellow `!` for Available, a grey one for Requires, and a
// yellow `?` for Ready to turn in. Accepted and Pending have none. Always pair it with its label.
export function Marker(props: { status: Status }) {
	if (props.status === "accepted" || props.status === "pending") return <span class="ql-marker" />;
	return <span class={`ql-marker ql-${props.status}`}>{props.status === "turn-in" ? <Query /> : <Bang />}</span>;
}

export type Size = "XS" | "S" | "M" | "L" | "XL";

// A size label in its size colour.
export function Difficulty(props: { size: Size }) {
	return <span class={`ql-size ql-${props.size.toLowerCase()}`}>{props.size}</span>;
}
