// The quest tree, whose contract is the guide (`quest guide`): parsing its
// documents, validating them, whether a given quest can be started, and its
// dependencies.
//
// The core is pure: no filesystem, process, or Node APIs, so the CLI, the
// Worker, and the site share one implementation. Callers load the documents
// and say which paths exist.

export {
	type Doc,
	type Entry,
	type Heading,
	type Link,
	type Position,
	branchQuest,
	children,
	entries,
	has,
	isQuest,
	isEpic,
	owner,
	parse,
	permanent,
	questBranch,
	resolve,
	rooted,
} from "./doc";
export { type ClosedPull, handedBack, landed, withoutHandBack } from "./claim";
export { type Missed, type Moved, type Source, move, relocate, remove } from "./edit";
export { comparePaths, normalize } from "./path";
export { type Blocker, blockers, label, lookup, ready, renderBlocker } from "./ready";
export { type Finding, ROOT, check, formatFinding } from "./rules";
export { type RankedQuest, type Ranking, type WaitingQuest, ranking, unblocked, waiting } from "./unblocked";
export { MAINTAINER, WAITING, type Wait, onMaintainer, parseWait, waits } from "./waiting";
export {
	ATTRIBUTES_LINE,
	CLAUDE_SETTINGS,
	type Checkout,
	type HookEntry,
	type InitChange,
	InitRefused,
	type Kind,
	PREFIX,
	REFERENCE_LINE,
	REFERENCE_MARKER,
	SKILL_DIRS,
	type Stub,
	installedStubs,
	lines,
	lookalikeHooks,
	newline,
	planInit,
	questReadme,
	removeHooks,
} from "./init";
export { type Chunk, type Clean, type Conflict, LABELS, chunks, render, resolveLists } from "./merge";

export {
	HOLD_PREFIX,
	ACTIVE_LABEL,
	type HoldEvent,
	type HoldSnapshot,
	isHoldLabel,
	latestHold,
	heldToken,
} from "./hold";
