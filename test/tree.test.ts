// Every rule, each proven to actually fail, and the readiness the same tree
// answers.
//
// A validator that silently stopped enforcing a rule is indistinguishable from
// a clean tree, so each case starts from the same valid fixture and breaks
// exactly one thing. The cases that must still PASS matter just as much: the
// shell version this replaced was rewritten precisely because it rejected
// legitimate Markdown and accepted the shapes it was written to catch.

import { basename } from "node:path";

import { describe, expect, test } from "vitest";

import { collect } from "../src/cli/tree";
import { ONE, TWO, Tree } from "./fixture";

const tree = Tree.baseline;

test("agent instructions are not quests", () => {
	const t = tree();
	for (const path of ["quest/AGENTS.md", "quest/CLAUDE.md", "quest/m0/AGENTS.md"]) {
		t.write(path, "# Instructions\n\n## Workflow\n\nNot a quest.\n");
	}
	t.accepts();
	expect(collect(t.path)).toHaveLength(5);
	expect(t.ready()).toEqual(["quest/m0/epic/one.md"]);
});

test("an empty permanent root is valid and has no ready work", () => {
	const t = new Tree().write("quest/README.md", "# Quests\n\n## Goal\n\nNew repository.\n");
	t.accepts();
	expect(t.ready()).toEqual([]);
});

const CLAIM = "\n## Claim\n\n- Jane Doe (github:jdoe) on https://example.com/jdoe/repo since 2026-10-02";

describe("retired claims", () => {
	test.each([CLAIM, "\n## Claim\n", "\n## Claim\n\n- Jane\n"])(
		"a Claim section is unknown and does not block readiness: %j",
		(claim) => {
			const t = tree().append("quest/m0/epic/one.md", claim);
			t.rejects("unknown '## Claim'");
			expect(t.ready()).toEqual(["quest/m0/epic/one.md"]);
			expect(t.blockers("quest/m0/epic/one.md")).toEqual([]);
			expect(t.run("unblocked", "quest/m0/epic/one.md")).toEqual({ code: 0, stdout: "", stderr: "" });
		},
	);

	test("Required entries remain the only blockers when a legacy claim exists", () => {
		const t = tree().append("quest/m0/epic/two.md", CLAIM);
		t.rejects("unknown '## Claim'");
		expect(t.blockers("quest/m0/epic/two.md")).toEqual(["quest/m0/epic/one.md"]);
	});
});

test("CRLF documents preserve validation and readiness", () => {
	const t = tree();
	for (const path of collect(t.path)) t.write(path, t.read(path).replaceAll("\n", "\r\n"));
	t.accepts();
	expect(t.ready()).toEqual(["quest/m0/epic/one.md"]);
	expect(t.blockers("quest/m0/epic/two.md")).toEqual(["quest/m0/epic/one.md"]);
});

/** The fixture itself has to pass, or every case below proves nothing. */
test("the baseline is valid", () => {
	tree().accepts();
});

describe("links", () => {
	test("a dangling absolute link", () => {
		tree()
			.append(
				"quest/m0/epic/one.md",
				"\n## Related\n\n- [Gone](/quest/m0/epic/gone.md) - completed and deleted\n",
			)
			.rejects("link does not resolve: /quest/m0/epic/gone.md");
	});

	// Relative links escape the tree (AGENTS.md points at ../CONTRIBUTING.md), so
	// they resolve against the LINKING FILE's directory. The pair of cases pins
	// the direction: resolving against the wrong base would flip both verdicts.
	test("a relative link resolves against the linking file", () => {
		tree()
			.write("AGENTS.md", "# Guide\n")
			.append("quest/m0/epic/one.md", "\n## Plan\n\nSee [the guide](../../../AGENTS.md).\n")
			.accepts();
	});

	test("a relative link above the repository root", () => {
		// One `..` too many, which is exactly what a file flattened up a level
		// keeps: it still renders, and points at nothing.
		tree()
			.write("AGENTS.md", "# Guide\n")
			.append("quest/m0/epic/one.md", "\n## Plan\n\nSee [the guide](../../../../AGENTS.md).\n")
			.rejects("link does not resolve: ../../../../AGENTS.md");
	});

	// Quests reference each other root-absolutely. A relative one renders fine,
	// so nothing else would notice - but it is invisible to the dependency graph.
	test("a relative link to a quest", () => {
		tree()
			.append("quest/m0/epic/one.md", "\n## Related\n\n- [Two](two.md) - a sibling\n")
			.rejects("link to a quest must be root-absolute: two.md (write /quest/m0/epic/two.md)");
	});

	// Templates inside fenced blocks are illustrations. Flagging AGENTS.md's own
	// example would make this a check everyone learns to skip.
	test("fenced templates are not links", () => {
		tree()
			.append(
				"quest/m0/epic/one.md",
				"\n## Plan\n\n```markdown\n## Required\n\n- [Blocker](/quest/foo/bar.md) - must finish first\n```\n",
			)
			.accepts();
	});

	// A fence longer than three backticks may contain shorter ones, and `~~~` is
	// a fence too. Miscounting either inverts the fence state and silently skips
	// the REST OF THE FILE - the worst failure this tool has, because it looks
	// clean.
	test("nested and tilde fences do not leak", () => {
		const t = tree().append(
			"quest/m0/epic/one.md",
			"\n## Plan\n\n````markdown\n```bash\njust check\n```\n````\n\n~~~text\n```\n~~~\n\n## Requires\n\n- [Gone](/quest/m0/epic/gone.md) - typo'd heading and a dangling link\n",
		);
		t.rejects("unknown '## Requires'");
		t.rejects("link does not resolve: /quest/m0/epic/gone.md");
	});

	// Repeated `..` must not cancel each other on the way up. Popping
	// unconditionally let a link climb above the root and walk back down to a
	// real file, so a badly flattened path resolved and reported nothing.
	test("repeated parent components", () => {
		tree()
			.write("AGENTS.md", "# Guide\n")
			.append("quest/m0/epic/one.md", "\n## Plan\n\nSee [the guide](../../../../../AGENTS.md).\n")
			.rejects("link does not resolve: ../../../../../AGENTS.md");
	});

	// Escaping the root must fail even when the joined path happens to exist: the
	// repository's own directory name (or a sibling worktree) sits beside the
	// root, so `<root>/../<name>/AGENTS.md` is a real file that readers of the
	// repository-relative link can never reach.
	test("an escaped link resolving beside the root", () => {
		const t = tree().write("AGENTS.md", "# Guide\n");
		const name = basename(t.path);
		t.append("quest/m0/epic/one.md", `\n## Plan\n\nSee [the guide](../../../../${name}/AGENTS.md).\n`);
		t.rejects(`link does not resolve: ../../../../${name}/AGENTS.md`);
	});
});

describe("headings", () => {
	test("a missing goal", () => {
		tree()
			.write("quest/m0/epic/one.md", "# [S] One\n\n## Plan\n\nA quest with no stated outcome.\n")
			.rejects("missing '## Goal'");
	});

	test("a quest title needs a size", () => {
		tree()
			.write("quest/m0/epic/one.md", ONE.replace("# [S] One", "# One"))
			.rejects("quest title must be '# [XS|S|M|L|XL] Title'");
	});

	test("a quest title accepts XL", () => {
		tree().write("quest/m0/epic/one.md", ONE.replace("# [S] One", "# [XL] One")).accepts();
	});

	test("a quest title rejects XXL", () => {
		tree()
			.write("quest/m0/epic/one.md", ONE.replace("# [S] One", "# [XXL] One"))
			.rejects("quest title must be '# [XS|S|M|L|XL] Title'");
	});

	// The closed vocabulary exists for this: readiness greps `## Required`
	// literally, so a typo makes a blocked quest read as ready and fails nowhere.
	test("a typo in a heading", () => {
		tree()
			.write("quest/m0/epic/two.md", TWO.replace("## Required", "## Requires"))
			.rejects("unknown '## Requires'");
	});

	// A setext underline renders as an H2 and this validator would read the quest
	// as blocked - but readiness greps `^## Required$` and would call it READY.
	// Two tools disagreeing about the same file is the whole failure.
	test("a setext heading", () => {
		tree()
			.append(
				"quest/m0/epic/one.md",
				"\nRequired\n--------\n\n- [Two](/quest/m0/epic/two.md) - must finish first\n",
			)
			.rejects("must be written literally as '## Required'");
	});

	test("a decorated heading", () => {
		tree()
			.append("quest/m0/epic/one.md", "\n## `Required`\n\n- [Two](/quest/m0/epic/two.md) - must finish first\n")
			.rejects("must be written literally as '## Required'");
	});

	// Trailing whitespace is invisible in a diff and `rg '^## Required$'` does
	// not match it either, so accepting it recreates the same disagreement a
	// setext heading does.
	test("a heading with a trailing space", () => {
		tree()
			.append("quest/m0/epic/one.md", "\n## Required  \n\n- [Two](/quest/m0/epic/two.md) - must finish first\n")
			.rejects("must be written literally as '## Required'");
	});

	test("an empty Related section", () => {
		tree().append("quest/m0/epic/one.md", "\n## Related\n").rejects("'## Related' is empty");
	});

	test("an empty Closes section", () => {
		tree().append("quest/m0/epic/one.md", "\n## Closes\n").rejects("'## Closes' is empty");
	});

	// Readiness and `quest waiting` read only `## ` sections, so a section name
	// one level down would drop its items out silently.
	test("a Waiting section one level too deep", () => {
		tree()
			.append("quest/m0/epic/one.md", "\n### Waiting\n\n- Maintainer: pick the name\n")
			.rejects("'### Waiting' must be '## Waiting'");
	});

	test("a Waiting heading above the title", () => {
		tree()
			.write("quest/m0/epic/one.md", "# Waiting\n\n" + ONE)
			.rejects("'# Waiting' must be '## Waiting'");
	});

	test("a Required section one level too deep", () => {
		tree()
			.append("quest/m0/epic/one.md", "\n### Required\n\n- [Two](/quest/m0/epic/two.md) - must finish first\n")
			.rejects("'### Required' must be '## Required'");
	});

	test("a Goal one level too deep does not satisfy the Goal rule", () => {
		tree().write("quest/m0/epic/one.md", ONE.replace("## Goal", "### Goal")).rejects("missing '## Goal'");
	});

	test("a free-form heading below ## is prose", () => {
		tree().append("quest/m0/epic/one.md", "\n### Notes\n\nAny structure here.\n").accepts();
	});
});

describe("epics", () => {
	test("a quest and an epic cannot share a page and branch path", () => {
		const t = tree().write("quest/m0/epic.md", ONE);
		const finding =
			"quest/m0/epic.md: quest path collides with quest/m0/epic/README.md; rename one of these documents";
		expect(t.findings()).toEqual([finding]);
		expect(t.run("check")).toEqual({ code: 1, stdout: "", stderr: `quest: ${finding}\n` });
	});

	test("a collision persists after the epic's last child completes", () => {
		tree()
			.write("quest/m0/epic/one/README.md", ONE)
			.rejects("quest/m0/epic/one.md: quest path collides with quest/m0/epic/one/README.md");
	});

	// Git cannot hold the epic's `quest/m0/epic/README` branch beside a nested
	// `quest/m0/epic/README/README` branch, so a README-named directory collides
	// with its parent epic like any other nested path.
	test("a README-named directory collides with its parent README", () => {
		tree()
			.write("quest/m0/epic/README/README.md", ONE)
			.rejects("quest/m0/epic/README.md: quest path collides with quest/m0/epic/README/README.md");
	});

	test("a quest collides with any document under its path", () => {
		tree()
			.write("quest/m0/epic/one/README.md", ONE)
			.write("quest/m0/epic/one/README/two.md", ONE)
			.rejects("quest/m0/epic/one/README.md: quest path collides with quest/m0/epic/one/README/two.md");
	});

	// The directory is the epic's list of children: a new quest needs no link
	// anywhere to be part of it.
	test("a quest joins the epic whose directory holds it", () => {
		const t = tree().write("quest/m0/epic/three.md", "# [S] Three\n\n## Goal\n\nA new child.\n");
		t.accepts();
		expect(t.ready()).toEqual(["quest/m0/epic/one.md", "quest/m0/epic/three.md"]);
	});

	// A README whose last child merged is the epic's own remaining work: a leaf
	// quest, sized and listed as ready like any other.
	test("a README whose directory holds no other quest is a quest", () => {
		const t = tree().write(
			"quest/m0/epic/sub/README.md",
			"# Sub\n\n## Goal\n\nThe end-to-end test once every child has merged.\n",
		);
		t.rejects("quest title must be");
		t.write(
			"quest/m0/epic/sub/README.md",
			"# [S] Sub\n\n## Goal\n\nThe end-to-end test once every child has merged.\n",
		);
		t.accepts();
		expect(t.ready()).toContain("quest/m0/epic/sub/README.md");
	});

	// Completing a quest's last blocker removes its heading with the entry. A
	// bare `## Required` would block it forever.
	test("an empty Required section", () => {
		tree().append("quest/m0/epic/one.md", "\n## Required\n").rejects("'## Required' is empty");
		tree()
			.write("quest/m0/husk/README.md", "# [S] Husk\n\n## Goal\n\nIts last blocker merged.\n\n## Required\n")
			.rejects("'## Required' is empty");
	});

	// Nothing above such a quest reaches it, so nothing would ever rank or
	// render it.
	test("a quest in a directory without a README", () => {
		tree()
			.write("quest/m0/loose/three.md", ONE)
			.rejects(
				"quest/m0/loose/three.md: sits in quest/m0/loose, which has no README.md; every directory under quest/ is an epic, so add its README or move the quest",
			);
		tree()
			.write("quest/m0/loose/deeper/README.md", ONE)
			.rejects("quest/m0/loose/deeper/README.md: sits in quest/m0/loose, which has no README.md");
	});

	// An epic already waits for everything in its directory, so a link to any of
	// it is the child list this format retired; `quest check --fix` drops it.
	test.each([
		["quest/README.md", "/quest/m0/README.md"],
		["quest/m0/README.md", "/quest/m0/epic/README.md"],
		["quest/m0/README.md", "/quest/m0/epic/one.md"],
		["quest/m0/epic/README.md", "/quest/m0/epic/one.md"],
	])("%s requiring %s, which it holds", (readme, target) => {
		const t = tree().append(readme, `\n## Required\n\n- [Held](${target})\n`);
		expect(t.findings()).toHaveLength(1);
		t.rejects(
			`requires ${target}, which this epic holds; an epic waits for everything in its directory, so remove the entry (quest check --fix does)`,
		);
	});

	test("a quest required twice", () => {
		tree()
			.append("quest/m0/epic/two.md", "- [One again](/quest/m0/epic/one.md)\n")
			.rejects("requires /quest/m0/epic/one.md twice");
	});

	test("a relative Required entry", () => {
		tree()
			.write("quest/m0/epic/two.md", TWO.replace("(/quest/m0/epic/one.md)", "(one.md)"))
			.rejects("link to a quest must be root-absolute: one.md");
	});

	// A target that merely exists is not enough: quest/AGENTS.md is a file under
	// quest/ that nothing can finish.
	test("a Required entry that is not a quest", () => {
		tree()
			.write("quest/AGENTS.md", "# Contract\n")
			.append("quest/m0/epic/two.md", "- [Contract](/quest/AGENTS.md)\n")
			.rejects("requires /quest/AGENTS.md, which is not a quest document");
	});

	// `Required` is a list of entries, not prose that happens to link.
	test("prose under Required", () => {
		tree().append("quest/m0/epic/two.md", "\nSee also [One](/quest/m0/epic/one.md).\n").rejects("mid-sentence");
	});

	// A blocker is not a child, so a README holding only blockers is a quest
	// and needs a size like any other.
	test("a README with only blockers is a quest", () => {
		tree()
			.write(
				"quest/m0/husk/README.md",
				"# Husk\n\n## Goal\n\nIts last quest was completed.\n\n## Required\n\n- [One](/quest/m0/epic/one.md)\n",
			)
			.rejects("quest title must be");
	});

	// A milestone with nothing left is not its own work, so it needs no size and
	// never lists as ready.
	test("a milestone may be empty", () => {
		const t = tree().remove("quest/m0/epic");
		t.accepts();
		expect(t.ready()).toEqual([]);
	});
});

// Milestones are permanent, so a link to one keeps resolving after it
// finishes. Check forces its removal; readiness stays a grep for the heading.
describe("finished milestones", () => {
	const GATE = "# [S] Gate\n\n## Goal\n\nRuns once m0 finishes.\n\n## Required\n\n- [M0](/quest/m0/README.md)\n";

	/** The baseline plus m1, whose gate requires m0. */
	const gated = () =>
		tree().write("quest/m1/README.md", "# M1\n\n## Goal\n\nThe next milestone.\n").write("quest/m1/gate.md", GATE);

	test("a link to an open milestone blocks", () => {
		const t = gated();
		t.accepts();
		expect(t.blockers("quest/m1/gate.md")[0]).toBe("quest/m0/README.md");
	});

	test("a link to a finished milestone", () => {
		const t = gated().remove("quest/m0/epic");
		expect(t.findings()).toEqual([
			"quest/m1/gate.md:9: requires /quest/m0/README.md, a finished milestone; remove the link, and the '## Required' heading with its last entry",
		]);
		expect(t.ready()).toEqual([]);
	});

	// A milestone README may list earlier quests: those blockers keep it open.
	test("a milestone with only blockers left is open", () => {
		tree()
			.write(
				"quest/m1/README.md",
				"# M1\n\n## Goal\n\nThe next milestone.\n\n## Required\n\n- [One](/quest/m0/epic/one.md)\n",
			)
			.write("quest/m2/README.md", "# M2\n\n## Goal\n\nLater.\n")
			.write(
				"quest/m2/gate.md",
				"# [S] Gate\n\n## Goal\n\nRuns once m1 finishes.\n\n## Required\n\n- [M1](/quest/m1/README.md)\n",
			)
			.accepts();
	});

	// The root holds every milestone, so its link to one is that finding alone.
	test("the root's link to a finished milestone is one finding", () => {
		const t = tree()
			.append("quest/README.md", "\n## Required\n\n- [M0](/quest/m0/README.md)\n")
			.remove("quest/m0/epic");
		expect(t.findings()).toEqual([
			"quest/README.md:9: requires /quest/m0/README.md, which this epic holds; an epic waits for everything in its directory, so remove the entry (quest check --fix does)",
		]);
	});

	test("removing the link readies the quest", () => {
		const t = gated()
			.remove("quest/m0/epic")
			.write("quest/m1/gate.md", "# [S] Gate\n\n## Goal\n\nRuns once m0 finishes.\n");
		t.accepts();
		expect(t.ready()).toEqual(["quest/m1/gate.md"]);
	});
});

describe("Required", () => {
	test("a direct cycle", () => {
		tree()
			.append("quest/m0/epic/one.md", "\n## Required\n\n- [Two](/quest/m0/epic/two.md) - must finish first\n")
			.rejects("Required cycle:");
	});

	// A quest may require a whole epic, so the deadlock can span the
	// README. The cycle here runs strictly OUTSIDE-IN: `outer` (in m0) requires
	// the epic, and `three` inside that epic requires `outer`
	// back. No quest requires its own epic, so containment edges are the
	// only thing that can close it.
	test("a cycle through an epic", () => {
		tree()
			.write(
				"quest/m0/outer.md",
				"# [S] Outer\n\n## Goal\n\nBlocked on a whole epic.\n\n## Required\n\n- [Epic](/quest/m0/epic/README.md) - the whole epic must finish\n",
			)
			.write(
				"quest/m0/epic/three.md",
				"# [S] Three\n\n## Goal\n\nInside the epic that blocks it.\n\n## Required\n\n- [Outer](/quest/m0/outer.md) - must finish first\n",
			)
			.rejects(
				"Required cycle: quest/m0/epic/README.md -> quest/m0/epic/three.md -> quest/m0/outer.md -> quest/m0/epic/README.md",
			);
	});

	// A `#fragment` addresses a place inside a file, not a different file.
	// Keeping it on made a phantom graph node that no quest could match, so a
	// cycle through an anchored link went unreported.
	test("a cycle through an anchored link", () => {
		tree()
			.append(
				"quest/m0/epic/one.md",
				"\n## Required\n\n- [Two](/quest/m0/epic/two.md#plan) - must finish first\n",
			)
			.rejects("Required cycle:");
	});

	// Reference-style links render as real dependencies, so they must carry real
	// edges. A line-oriented parser saw no `](` here and produced none.
	test("a cycle through a reference-style link", () => {
		tree()
			.append(
				"quest/m0/epic/one.md",
				"\n## Required\n\n- [Two][two] - must finish first\n\n[two]: /quest/m0/epic/two.md\n",
			)
			.rejects("Required cycle:");
	});

	// The index and the cycle walk key on the same normalized path. A `..` left
	// in either makes a node nothing can match, so the cycle through it
	// disappears.
	test("a cycle through an unnormalized link", () => {
		tree()
			.append(
				"quest/m0/epic/one.md",
				"\n## Required\n\n- [Two](/quest/m0/epic/../epic/two.md) - must finish first\n",
			)
			.rejects("Required cycle:");
	});

	// moq-dev/moq.pro#1170: a customer-gate sentence that happens to link an
	// epic mid-sentence reads as context but IS a dependency edge.
	test("a link mid-sentence", () => {
		tree()
			.append(
				"quest/m0/epic/one.md",
				"\n## Required\n\n- A customer who also justifies [the epic](/quest/m0/epic/README.md).\n",
			)
			.rejects("mid-sentence");
	});

	// The same failure, reflowed onto a second line. The link is no longer on the
	// bullet's first line, which is all it took to slip past the shell version.
	test("a link on a wrapped bullet", () => {
		tree()
			.append(
				"quest/m0/epic/one.md",
				"\n## Required\n\n- A customer who also justifies\n  [the epic](/quest/m0/epic/README.md).\n",
			)
			.rejects("mid-sentence");
	});

	// An outside condition is its own quest, so it keeps surfacing as ready
	// instead of hiding the quest it blocks from every ready listing. The bullet
	// wraps here because that is what such bullets in trees actually looked like.
	test("an external condition", () => {
		tree()
			.append("quest/m0/epic/one.md", "\n## Required\n\n- A `moq-video` release that carries\n  the encoder\n")
			.rejects("requires A moq-video release that carries the encoder, which is not a quest document");
	});

	// An issue or release link is outside the tree too; only a quest can clear.
	test("an external link", () => {
		tree()
			.append(
				"quest/m0/epic/one.md",
				"\n## Required\n\n- [#1](https://github.com/OWNER/REPO/issues/1) - upstream fix\n",
			)
			.rejects("requires https://github.com/OWNER/REPO/issues/1, which is not a quest document");
	});

	test("a loose Required list", () => {
		const t = tree().append(
			"quest/m0/epic/one.md",
			"\n## Required\n\n- [Two](/quest/m0/epic/two.md) - must finish first\n\n- [Epic](/quest/m0/epic/README.md) - the whole epic\n",
		);
		// Both edges registered (hence the cycle) without reading as prose.
		t.rejects("Required cycle:");
		t.without("mid-sentence");
	});

	// The other side of the same seam: a link opening a SECOND paragraph is
	// inside the item, not opening it.
	test("a link in a later paragraph", () => {
		tree()
			.append(
				"quest/m0/epic/one.md",
				"\n## Required\n\n- A customer who justifies the work.\n\n  [The epic](/quest/m0/epic/README.md) would follow.\n",
			)
			.rejects("mid-sentence");
	});

	// A blocker written with emphasis still opens its bullet. Rejecting it would
	// be a false positive on legitimate Markdown.
	test("a link with emphasis", () => {
		tree()
			.append("quest/m0/epic/one.md", "\n## Required\n\n- **[Two](/quest/m0/epic/two.md)** - must finish first\n")
			.rejects("Required cycle:");
	});

	// A bullet nested under a prose lead-in is illustration, not a blocker.
	// Reading it as one is #1170 again, wearing an indent.
	test("a nested entry", () => {
		tree()
			.append(
				"quest/m0/epic/one.md",
				"\n## Required\n\n- Customer evidence:\n  - [The epic](/quest/m0/epic/README.md)\n",
			)
			.rejects("mid-sentence");
	});

	test("a blockquoted entry", () => {
		tree()
			.append(
				"quest/m0/epic/one.md",
				"\n## Required\n\n- Quoting the old plan:\n\n  > - [The epic](/quest/m0/epic/README.md)\n",
			)
			.rejects("mid-sentence");
	});
});

// Readiness: what `quest unblocked <path>` reports about the same fixture. A blocker list
// is the machine-readable result, so the cases that must come back EMPTY carry
// as much weight as the ones that must not.
describe("ready", () => {
	/** The absence of `## Required` is the whole definition of ready. */
	test("a ready quest has no blockers", () => {
		expect(tree().blockers("quest/m0/epic/one.md")).toEqual([]);
	});

	test("blocked by a quest", () => {
		expect(tree().blockers("quest/m0/epic/two.md")).toEqual(["quest/m0/epic/one.md"]);
	});

	// An epic blocker clears only when the whole epic is complete, so the
	// useful answer is which of its quests are still open - all of them, since a
	// completed quest is deleted.
	test("blocked by an epic", () => {
		const t = tree().write(
			"quest/m0/outer.md",
			"# [S] Outer\n\n## Goal\n\nBlocked on a whole epic.\n\n## Required\n\n- [Epic](/quest/m0/epic/README.md) - the whole epic must finish\n",
		);
		expect(t.blockers("quest/m0/outer.md")).toEqual([
			"quest/m0/epic/README.md",
			"  quest/m0/epic/one.md",
			"  quest/m0/epic/two.md",
		]);
	});

	// A required QUEST does not expand: its own blockers are its readiness, and
	// running this on it is how you ask. Expanding buried the entries that were
	// asked for under a subtree repeated once per path through it.
	test("a required quest is not expanded", () => {
		const t = tree().write(
			"quest/m0/epic/three.md",
			"# [S] Three\n\n## Goal\n\nLast in the chain.\n\n## Required\n\n- [Two](/quest/m0/epic/two.md) - must finish first\n",
		);
		expect(t.blockers("quest/m0/epic/three.md")).toEqual(["quest/m0/epic/two.md"]);
	});

	// `quest check` reports an empty `## Required` as a defect, and every reader
	// that greps for the heading calls the quest blocked. Reading it as ready
	// here would make this the one tool that disagrees.
	test("an empty Required section still blocks", () => {
		const t = tree().append("quest/m0/epic/one.md", "\n## Required\n");
		expect(t.blockers("quest/m0/epic/one.md")).toEqual([
			"an empty '## Required' section, which blocks the quest until the heading is removed",
		]);
	});

	// The listing is the query the start flow reproduces by grepping. An
	// epic is absent while its directory holds other quests, and `two.md` is
	// blocked.
	test("the listing", () => {
		const t = tree();
		expect(t.ready()).toEqual(["quest/m0/epic/one.md"]);
		t.write("quest/m0/outer.md", "# [S] Outer\n\n## Goal\n\nReady too.\n");
		expect(t.ready()).toEqual(["quest/m0/epic/one.md", "quest/m0/outer.md"]);
	});

	// `quest check` proves the graph acyclic, but readiness also runs on trees
	// nobody has checked yet - the branch that just introduced the cycle - and a
	// cycle there has to print rather than recurse forever.
	test("a cycle terminates", () => {
		const t = tree()
			.append("quest/m0/epic/README.md", "\n## Required\n\n- [Itself](/quest/m0/epic/README.md)\n")
			.write(
				"quest/m0/outer.md",
				"# [S] Outer\n\n## Goal\n\nBlocked on an epic that requires itself.\n\n## Required\n\n- [Epic](/quest/m0/epic/README.md) - the whole epic must finish\n",
			);
		expect(t.blockers("quest/m0/outer.md")).toEqual([
			"quest/m0/epic/README.md",
			"  quest/m0/epic/README.md",
			"  quest/m0/epic/one.md",
			"  quest/m0/epic/two.md",
		]);
	});

	// Path order: an epic before its children, and milestone numbers by value.
	test("the listing is in path order", () => {
		const t = tree()
			.write("quest/m0/epic/two.md", "# [S] Two\n\n## Goal\n\nReady.\n")
			.write("quest/m0/aaa.md", "# [S] First\n\n## Goal\n\nSorts before the epic.\n")
			.write("quest/m10/README.md", "# M10\n\n## Goal\n\nLater.\n")
			.write("quest/m10/one.md", ONE)
			.write("quest/m2/README.md", "# M2\n\n## Goal\n\nSooner.\n")
			.write("quest/m2/one.md", ONE);
		t.accepts();
		expect(t.ready()).toEqual([
			"quest/m0/aaa.md",
			"quest/m0/epic/one.md",
			"quest/m0/epic/two.md",
			"quest/m2/one.md",
			"quest/m10/one.md",
		]);
	});
});

// Shapes the Rust parser handled that a plain CommonMark port would not. Each
// was found by running both implementations over the same documents.
describe("parser parity", () => {
	// Blank text renders as nothing, so it does not displace an opening link.
	test.each(["&nbsp;", "` ` "])("a link after blank text still opens its entry: %j", (lead) => {
		tree()
			.append("quest/m0/epic/one.md", `\n## Required\n\n- ${lead}[Two](/quest/m0/epic/two.md)\n`)
			.rejects("Required cycle:");
	});

	test("a struck-through heading is the heading, and not literal", () => {
		tree()
			.append("quest/m0/epic/one.md", "\n## ~~Required~~\n\n- [Two](/quest/m0/epic/two.md)\n")
			.rejects("'Required' must be written literally");
	});

	test("struck-through blocker text renders without its markers", () => {
		const t = tree().append("quest/m0/epic/one.md", "\n## Required\n\n- ~~Old~~ plain blocker\n");
		expect(t.blockers("quest/m0/epic/one.md")).toEqual(["Old plain blocker"]);
	});

	test("a link in a table cell does not open its entry", () => {
		tree()
			.append("quest/m0/epic/one.md", "\n## Required\n\n- [Two](/quest/m0/epic/two.md) | note\n  --- | ---\n")
			.rejects("mid-sentence");
	});

	test("a wrapped setext heading reads as one line", () => {
		const t = tree().append("quest/m0/epic/one.md", "\nRe\nquired\n--------\n\n- [Two](/quest/m0/epic/two.md)\n");
		t.rejects("'Required' must be written literally");
		expect(t.findings().every((f) => !f.includes("\n"))).toBe(true);
	});

	// `//host/path` is protocol-relative on GitHub, not a file in this tree.
	test("a protocol-relative link does not resolve", () => {
		tree()
			.append("quest/m0/epic/one.md", "\n## Related\n\n- [Two](//quest/m0/epic/two.md) - same file, wrong link\n")
			.rejects("link does not resolve: //quest/m0/epic/two.md");
	});

	// grep sees a CR-only file as one line, so `^## Required$` matches nothing
	// in it; the literal-heading rule has to agree.
	test("a CR-only document's headings are not literal", () => {
		const t = tree();
		t.write("quest/m0/epic/two.md", t.read("quest/m0/epic/two.md").replaceAll("\n", "\r"));
		t.rejects("'Required' must be written literally");
	});
});

// Intended changes from the Rust parser, listed in the TypeScript port's PR.
describe("parser changes", () => {
	test("blocker text separates the blocks it spans", () => {
		const t = tree().append(
			"quest/m0/epic/one.md",
			"\n## Required\n\n- Customer evidence:\n  - [The epic](/quest/m0/epic/README.md)\n",
		);
		expect(t.blockers("quest/m0/epic/one.md")).toEqual(["Customer evidence: The epic"]);
	});

	test("an email autolink is skipped like mailto:", () => {
		tree().append("quest/m0/epic/one.md", "\nWrite to <a@b.c>.\n").accepts();
	});
});

describe("scheduled", () => {
	const scheduled = (date: string) => `\n## Scheduled\n\n- ${date}\n`;

	test("a date blocks its quest until that day arrives", () => {
		const t = tree().append("quest/m0/epic/one.md", scheduled("2026-11-11 - the filing window opens"));
		t.accepts();
		expect(t.ready("2026-11-10")).toEqual([]);
		expect(t.blockers("quest/m0/epic/one.md", "2026-11-10")).toEqual([
			"Scheduled: 2026-11-11 - the filing window opens",
		]);
		expect(t.ready("2026-11-11")).toEqual(["quest/m0/epic/one.md"]);
		expect(t.blockers("quest/m0/epic/one.md", "2026-11-11")).toEqual([]);
		expect(t.ready("2027-01-01")).toEqual(["quest/m0/epic/one.md"]);
	});

	test("an epic's or milestone's date holds back every quest under it", () => {
		for (const readme of ["quest/m0/epic/README.md", "quest/m0/README.md"]) {
			const t = tree().append(readme, scheduled("2027-03-01"));
			t.accepts();
			expect(t.ready("2027-02-28")).toEqual([]);
			expect(t.blockers("quest/m0/epic/two.md", "2027-02-28")).toEqual([
				"quest/m0/epic/one.md",
				readme,
				"  Scheduled: 2027-03-01",
			]);
			expect(t.ready("2027-03-01")).toEqual(["quest/m0/epic/one.md"]);
		}
	});

	test("a date is listed before Required entries, on the quest and on an epic above it", () => {
		const t = tree()
			.append("quest/m0/epic/two.md", scheduled("2027-01-15"))
			.append(
				"quest/m0/epic/README.md",
				`${scheduled("2027-01-01")}\n## Required\n\n- [Other](/quest/m0/other.md)\n`,
			)
			.write("quest/m0/other.md", "# [S] Other\n\n## Goal\n\nWork.\n");
		t.accepts();
		expect(t.blockers("quest/m0/epic/two.md", "2026-12-01")).toEqual([
			"Scheduled: 2027-01-15",
			"quest/m0/epic/one.md",
			"quest/m0/epic/README.md",
			"  Scheduled: 2027-01-01",
			"  quest/m0/other.md",
		]);
	});

	test.each(["2027-1-15", "2027-02-30", "Jan 15 2027", "2027-01-15 why", "after [One](/quest/m0/epic/one.md)"])(
		"an item that is not a real date is rejected and blocks: %j",
		(item) => {
			const t = tree().append("quest/m0/epic/one.md", scheduled(item));
			t.rejects("'## Scheduled' item must be a date, as 'YYYY-MM-DD' optionally followed by ' - why'");
			expect(t.ready("2999-01-01")).toEqual([]);
		},
	);

	test("a second date is rejected", () => {
		tree()
			.append("quest/m0/epic/one.md", "\n## Scheduled\n\n- 2027-01-15\n- 2027-02-15\n")
			.rejects("quest/m0/epic/one.md:10: '## Scheduled' holds one date");
	});

	test("an empty section is rejected and blocks nothing", () => {
		const t = tree().append("quest/m0/epic/one.md", "\n## Scheduled\n");
		t.rejects("'## Scheduled' is empty");
		expect(t.ready()).toEqual(["quest/m0/epic/one.md"]);
	});
});

// `quest unblocked` ranks a blocker by its own milestone, so a link to a later
// one stalls the earlier quest behind all of that milestone's work.
describe("Required links to a later milestone", () => {
	const later = () =>
		tree()
			.write("quest/m1/README.md", "# M1\n\n## Goal\n\nLater.\n")
			.write("quest/m1/late.md", "# [S] Late\n\n## Goal\n\nLater work.\n");
	const REQ = "\n## Required\n\n- [Late](/quest/m1/late.md)\n";

	test("a quest requiring a later quest", () => {
		expect(later().append("quest/m0/epic/two.md", REQ).findings()).toEqual([
			"quest/m0/epic/two.md:13: in milestone m0, requires quest/m1/late.md in later milestone m1; move quest/m1/late.md to m0 or move quest/m0/epic/two.md to m1 with `quest mv`, or remove the link",
		]);
	});

	test("an epic README requiring a later quest", () => {
		const findings = later().append("quest/m0/epic/README.md", REQ).findings();
		expect(findings).toHaveLength(1);
		expect(findings[0]).toContain("move quest/m1/late.md to m0 or move quest/m0/epic to m1");
	});

	test("a milestone README offers only moving the other side", () => {
		const findings = later().append("quest/m0/README.md", REQ).findings();
		expect(findings).toHaveLength(1);
		expect(findings[0]).toContain(
			"in later milestone m1; move quest/m1/late.md to m0 with `quest mv`, or remove the link",
		);
	});

	test("a later milestone README offers only moving the requirer", () => {
		const findings = later()
			.append("quest/m0/epic/two.md", "\n## Required\n\n- [M1](/quest/m1/README.md)\n")
			.findings();
		expect(findings[0]).toContain("move quest/m0/epic/two.md to m1 with `quest mv`, or remove the link");
	});

	test("m10 follows m9", () => {
		const t = tree()
			.write("quest/m9/README.md", "# M9\n\n## Goal\n\nNine.\n")
			.write("quest/m9/nine.md", "# [S] Nine\n\n## Goal\n\nNine.\n")
			.write("quest/m10/README.md", "# M10\n\n## Goal\n\nTen.\n")
			.write("quest/m10/a.md", "# [S] A\n\n## Goal\n\nA.\n\n## Required\n\n- [M9](/quest/m9/README.md)\n");
		t.accepts();
		t.write("quest/m10/a.md", "# [S] A\n\n## Goal\n\nA.\n").write(
			"quest/m9/b.md",
			"# [S] B\n\n## Goal\n\nB.\n\n## Required\n\n- [A](/quest/m10/a.md)\n",
		);
		expect(t.findings()).toEqual([
			"quest/m9/b.md:9: in milestone m9, requires quest/m10/a.md in later milestone m10; move quest/m10/a.md to m9 or move quest/m9/b.md to m10 with `quest mv`, or remove the link",
		]);
	});

	test("earlier and same-milestone links pass", () => {
		later()
			.write("quest/m1/other.md", "# [S] Other\n\n## Goal\n\nSame milestone.\n")
			.append(
				"quest/m1/late.md",
				"\n## Required\n\n- [One](/quest/m0/epic/one.md)\n- [Other](/quest/m1/other.md)\n",
			)
			.accepts();
	});
});
