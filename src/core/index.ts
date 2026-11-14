// The quest tree, whose contract is the guide (`quest guide`): parsing its
// documents, validating them, whether a given quest can be started, and its
// dependencies.
//
// The core is pure: no filesystem, process, or Node APIs, so it runs wherever
// JavaScript does. Callers load the documents and say which paths exist.

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
	holds,
	type Host,
	hosts,
	isQuest,
	isEpic,
	owner,
	parse,
	permanent,
	questBranch,
	ancestors,
	gates,
	requires,
	resolve,
	rooted,
	SIZES,
	type Size,
	size,
} from "./doc";
export { type ClosedPull, handBackWaits, handedBack, landed, withoutHandBack } from "./claim";
export { reviewSection } from "./review";
export { type Missed, type Moved, type Source, move, promote, relocate, remove } from "./edit";
export { comparePaths, normalize } from "./path";
export { type Blocker, blockers, label, lookup, ready, renderBlocker } from "./ready";
export { type Finding, ROOT, check, formatFinding } from "./rules";
export {
	type Draft,
	type RankedQuest,
	type Ranking,
	type WaitingQuest,
	ranking,
	unblocked,
	waiting,
} from "./unblocked";
export { MAINTAINER, WAITING, type Wait, onMaintainer, parseWait, waits } from "./waiting";
export {
	ATTRIBUTES_LINE,
	type Checkout,
	type InitChange,
	InitRefused,
	type Kind,
	PREFIX,
	REFERENCE_LINE,
	REFERENCE_MARKER,
	SKILL_DIRS,
	type SkillDir,
	type Stub,
	installedStubs,
	lines,
	newline,
	planInit,
	questReadme,
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
export {
	type ModelSpend,
	type RecordUpload,
	ROLES,
	type Role,
	type SessionRecord,
	type SessionWait,
	WAIT_KINDS,
	type WaitKind,
	parseRecord,
	parseUpload,
} from "./record";
