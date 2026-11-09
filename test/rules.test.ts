// The rules `quest hook` checks on a tool call, and the shell parsing they rest on.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, expect, test } from "vitest";

import { RULES, USER_ASKED, broken } from "../src/cli/rules";
import { parse } from "../src/cli/shell";
import { tempDir } from "./fixture";

const DASH = String.fromCharCode(0x2014);
const DENIED_REWRITE = `${RULES.rewrite} If the user asked for this in their own words, prefix the command with \`${USER_ASKED}\`.`;
const FOOTER = "(Written by Opus 5.5 with high effort)";
let cwd = "";
beforeEach(() => {
	cwd = tempDir();
});
const bash = (command: string) => broken({ tool: "Bash", input: { command }, cwd });

test("parse splits commands and attaches redirections and here-documents", () => {
	expect(
		parse(
			`A=1 git push 'a b' "c\\"d" && echo x | tee out.log >/dev/null 2>&1; cat > .tmp/body.md <<'EOF'\nline $x\nEOF\ngh x`,
		),
	).toEqual([
		{ argv: ["A=1", "git", "push", "a b", 'c"d'], redirects: [] },
		{ argv: ["echo", "x"], redirects: [] },
		{
			argv: ["tee", "out.log"],
			redirects: [
				{ op: ">", target: "/dev/null" },
				{ op: ">&", target: "1" },
			],
		},
		{ argv: ["cat"], redirects: [{ op: ">", target: ".tmp/body.md" }], stdin: "line $x\n" },
		{ argv: ["gh", "x"], redirects: [] },
	]);
	expect(parse("echo $(git push) # git rebase")).toEqual([
		{ argv: ["echo", "$(git push)"], redirects: [], expanded: ["$(git push)"] },
	]);
	expect(parse("cat <<EOF\n$x\nEOF")).toEqual([{ argv: ["cat"], redirects: [], stdin: "$x\n", stdinExpanded: true }]);
	expect(parse("echo '$x' \"a $y\"")).toEqual([{ argv: ["echo", "$x", "a $y"], redirects: [], expanded: ["a $y"] }]);
	expect(parse("cat <<-END\n\tbody\n\tEND")).toEqual([{ argv: ["cat"], redirects: [], stdin: "body\n" }]);
});

test.each([
	"git push",
	"git push origin",
	"git push origin main",
	"git push -u origin feature",
	"git -C repo push origin refs/heads/a:refs/heads/a feature",
	"direnv exec . git push origin main",
	"bash -c 'git push origin main'",
	"git push --tags origin feature",
	"git push --repo origin main refs/heads/a:refs/heads/a",
])("a push without an explicit refspec is blocked: %s", (command) => {
	expect(bash(command)).toEqual([RULES.refspec]);
});

test.each([
	"git push origin refs/heads/a:refs/heads/a",
	"git push origin HEAD:refs/heads/a",
	"git push -o ci.skip origin refs/heads/a:refs/heads/a",
	"git push origin --delete feature",
	"git push --tags origin",
	"git push --tags origin HEAD:refs/heads/a",
	"git push --repo origin refs/heads/a:refs/heads/a",
	"git push --help",
	// A help flag anywhere passes, even as a value, accepting the rare missed nudge.
	"git push -o --help origin main",
	"git log --grep 'git push origin main'",
	"echo git push",
])("a push with explicit refspecs, or no push, passes: %s", (command) => {
	expect(bash(command)).toEqual([]);
});

test.each([
	"git push --force origin refs/heads/a:refs/heads/a",
	"git push -f origin refs/heads/a:refs/heads/a",
	"git push -uf origin refs/heads/a:refs/heads/a",
	"git push --force-with-lease=a origin refs/heads/a:refs/heads/a",
	"git push origin +refs/heads/a:refs/heads/a",
])("a force-push is blocked unless the user asked: %s", (command) => {
	expect(bash(command)).toEqual([DENIED_REWRITE]);
	expect(bash(`${USER_ASKED} ${command}`)).toEqual([]);
});

test("a rebase is blocked unless the user asked, or it ends one", () => {
	expect(bash("git rebase origin/main")).toEqual([DENIED_REWRITE]);
	expect(bash("git pull --rebase origin main")).toEqual([DENIED_REWRITE]);
	expect(bash(`${USER_ASKED} git rebase origin/main`)).toEqual([]);
	expect(bash(`${USER_ASKED} bash -c 'git rebase origin/main'`)).toEqual([]);
	expect(bash("bash -c 'git rebase origin/main'")).toEqual([DENIED_REWRITE]);
	expect(bash("git rebase --abort")).toEqual([]);
	expect(bash("git rebase --help")).toEqual([]);
	expect(bash("git rebase --interactive -h")).toEqual([]);
	expect(bash("git pull --no-rebase origin main")).toEqual([]);
	expect(bash("gh pr merge 5 --rebase")).toEqual([]);
});

test("scratch writes under /tmp are blocked, reads and checkout paths pass", () => {
	for (const command of [
		"echo x > /tmp/log",
		"just test > /tmp/test.log 2>&1",
		"cmd | tee /tmp/out",
		"mkdir -p /tmp/work",
		"git clone https://example.com/r /tmp/r",
		"git clone -b main https://example.com/r /tmp/r",
		"git worktree add -b x /tmp/x",
		"git clone --separate-git-dir /tmp/repo.git /tmp/source .tmp/clone",
		"mktemp -d",
		"mktemp -t body.XXXX",
		"TMPDIR=/tmp/x mktemp -d",
	])
		expect(bash(command), command).toEqual([RULES.tmp]);
	for (const command of [
		"cat /tmp/claude-1000/tasks/x.output",
		"ls /tmp",
		"echo x > .tmp/log 2>/dev/null",
		"mktemp -p .tmp",
		"mktemp .tmp/body.XXXX",
		'TMPDIR="$PWD/.tmp" mktemp -d',
		"env TMPDIR=.tmp mktemp -t body.XXXX",
		"git clone /tmp/source .tmp/clone",
		"git clone --depth 1 /tmp/source",
		"git worktree add -b x .worktrees/x /tmp/ignored",
		// `$TMPDIR` may name the checkout, as a kix runner job sets it.
		'cat > "$TMPDIR/body.md" <<EOF\nx\nEOF',
		"mkdir -m 700 .tmp/x",
		"mktemp --help",
		"mktemp -u",
	])
		expect(bash(command), command).toEqual([]);
	expect(broken({ tool: "Write", input: { file_path: "/tmp/x.md", content: "x" }, cwd })).toEqual([RULES.tmp]);
	expect(
		broken({
			tool: "apply_patch",
			input: { command: "*** Begin Patch\n*** Add File: /tmp/x\n+x\n*** End Patch" },
			cwd,
		}),
	).toEqual([RULES.tmp]);
});

test("an edit that adds an em dash is blocked; one keeping or quoting it passes", () => {
	const edit = (old_string: string, new_string: string) =>
		broken({ tool: "Edit", input: { file_path: "a.md", old_string, new_string }, cwd });
	expect(edit("a, b", `a ${DASH} b`)).toEqual([RULES.emDash]);
	expect(edit(`a ${DASH} b`, `a ${DASH} c`)).toEqual([]);
	expect(edit("", `> they said a ${DASH} b`)).toEqual([]);
	expect(
		broken({
			tool: "MultiEdit",
			input: { file_path: "a.md", edits: [{ old_string: "a", new_string: DASH }] },
			cwd,
		}),
	).toEqual([RULES.emDash]);

	const file = join(cwd, "kept.md");
	writeFileSync(file, `old ${DASH} text\n`);
	const write = (content: string) => broken({ tool: "Write", input: { file_path: file, content }, cwd });
	expect(write(`old ${DASH} text\nmore\n`)).toEqual([]);
	expect(write(`old ${DASH} text ${DASH} more\n`)).toEqual([RULES.emDash]);

	const patch = (lines: string) =>
		broken({
			tool: "apply_patch",
			input: { command: `*** Begin Patch\n*** Update File: a.md\n${lines}\n*** End Patch` },
			cwd,
		});
	expect(patch(`-a, b\n+a ${DASH} b`)).toEqual([RULES.emDash]);
	expect(patch(`-a ${DASH} b\n+a ${DASH} c`)).toEqual([]);
});

test("commit messages may not add em dashes", () => {
	expect(bash(`git commit -m "fix: a ${DASH} b"`)).toEqual([RULES.emDash]);
	expect(bash(`git commit -F - <<'EOF'\nfix: a ${DASH} b\nEOF`)).toEqual([RULES.emDash]);
	expect(bash('git commit -m "fix: a, b"')).toEqual([]);
});

test("a new GitHub post needs the footer and no em dashes; edits and bodies off the line pass", () => {
	expect(bash(`gh pr comment 5 --body "Done.\n\n${FOOTER}"`)).toEqual([]);
	expect(bash('gh pr comment 5 --body "Done."')).toEqual([RULES.footer]);
	expect(bash(`gh pr comment 5 --body "${FOOTER}\nMore."`)).toEqual([RULES.footer]);
	expect(bash(`gh pr comment 5 --body "Done ${DASH} mostly.\n\n${FOOTER}"`)).toEqual([RULES.emDash]);
	expect(bash(`gh pr create --title "a ${DASH} b" --body-file - <<'EOF'\nBody\n\n${FOOTER}\nEOF`)).toEqual([
		RULES.emDash,
	]);
	// A body file is never read: it may hold something else by the time the line posts it.
	writeFileSync(join(cwd, "stale.md"), `Body ${DASH}\n`);
	expect(bash("gh pr comment 5 --body-file stale.md")).toEqual([]);
	expect(bash("gh pr comment 5 --body-file - < stale.md")).toEqual([]);
	expect(bash("git commit -F stale.md")).toEqual([]);
	expect(bash("gh api repos/o/r/issues/5/comments -F body=@stale.md")).toEqual([]);
	expect(bash("gh api repos/o/r/issues/5/comments -f body=Done")).toEqual([RULES.footer]);
	expect(bash("gh pr edit 5 --body Done")).toEqual([]);
	expect(bash("gh api -X PATCH repos/o/r/pulls/5 -f body=Done")).toEqual([]);
	expect(bash("gh pr review 5 --approve")).toEqual([]);
	expect(bash("cat .tmp/body.md | gh pr comment 5 --body-file -")).toEqual([]);
	expect(bash('gh pr comment 5 --body "$body"')).toEqual([]);
	expect(bash("gh pr comment 5 --body-file - <<EOF\n$(cat .tmp/body.md)\nEOF")).toEqual([]);
	expect(bash("gh pr comment 5 --body-file - <<'EOF'\nRun `$(y)`.\nEOF")).toEqual([RULES.footer]);
	expect(bash("gh pr comment 5 --body 'Run `$(y)`.'")).toEqual([RULES.footer]);
});
