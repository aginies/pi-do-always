// Subcommand keywords vs task names.
//
// `/do-always` matches its keywords (list, list-details, replan, questionnaire,
// mode, chain, testplan) before it resolves a task, so a task — or an alias —
// spelled exactly like one is shadowed. The keywords keep priority (nothing that
// works today changes meaning), the collision is reported when the config loads,
// and `/do-always task <name|number>` is the escape hatch that always reaches the
// task. Double quotes keep a multi-word name in one piece, which also makes a
// task whose name ends in a mode word addressable by `/do-always mode`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SUBCOMMAND_KEYWORDS, shadowingSubcommand, splitArgs } from "../tasks";
import { harness, lastNote } from "./harness";

// ── Pure helpers ─────────────────────────────────────────────────────────────

test("splitArgs splits on whitespace and honors double quotes", () => {
	assert.deepEqual(splitArgs("a b"), ["a", "b"]);
	assert.deepEqual(splitArgs("  a   b  "), ["a", "b"], "runs of whitespace collapse");
	assert.deepEqual(splitArgs('"a b" c'), ["a b", "c"], "a quoted name stays one token");
	assert.deepEqual(splitArgs('a "b c"'), ["a", "b c"]);
	assert.deepEqual(splitArgs('"a b"'), ["a b"]);
	assert.deepEqual(splitArgs('""'), [], "an empty quoted token yields nothing (no empty task name)");
	assert.deepEqual(splitArgs(""), []);
	assert.deepEqual(splitArgs("   "), []);
	assert.deepEqual(splitArgs('"unclosed tail'), ["unclosed tail"], "an open quote runs to the end");
	assert.deepEqual(splitArgs('say "hello world" now'), ["say", "hello world", "now"]);
});

test("shadowingSubcommand reports the keyword a name collides with", () => {
	assert.equal(shadowingSubcommand("list"), "list");
	assert.equal(shadowingSubcommand(" LIST "), "list", "case- and space-insensitive");
	assert.equal(shadowingSubcommand("mode"), "mode");
	assert.equal(shadowingSubcommand("task"), "task", "the escape hatch itself is a keyword");
	assert.equal(shadowingSubcommand("Review changes"), undefined);
	assert.equal(shadowingSubcommand("listy"), undefined, "only an exact match shadows");
	assert.equal(shadowingSubcommand(""), undefined);
	assert.ok(SUBCOMMAND_KEYWORDS.includes("chain") && SUBCOMMAND_KEYWORDS.includes("testplan"));
});

// ── The escape hatch ─────────────────────────────────────────────────────────

const LIST_TASK = { name: "list", category: "Do", prompt: "List the widgets.", mode: "run" };
const REVIEW_RUN = { name: "Review run", category: "Do", prompt: "Review the run.", mode: "run" };

test("a task named like a subcommand is shadowed, but /do-always task reaches it", async () => {
	const h = harness([LIST_TASK]);
	await h.start();
	// The collision is reported when the config loads, with the way out.
	assert.ok(
		h.notes().some((n) => n.includes('task "list" collides with the /do-always list subcommand')),
		h.notes().join(" | "),
	);
	assert.ok(h.notes().some((n) => n.includes('/do-always task list')), "…and names the escape hatch");

	await h.command("list");
	assert.equal(h.sent().length, 0, "the keyword still wins: nothing was run");
	assert.ok(lastNote(h).includes("1. list"), "it printed the task list instead");

	await h.command("task list");
	assert.deepEqual(h.sent(), ["List the widgets."], "the escape hatch runs the task");
});

test("/do-always task takes a number, an alias and a quoted name", async () => {
	const h = harness([LIST_TASK, { ...REVIEW_RUN, aliases: ["rr"] }]);
	await h.start();
	await h.command("task 2");
	assert.deepEqual(h.sent(), ["Review the run."], "by position in the visible list");
	await h.command("task rr");
	assert.equal(h.sent().length, 2, "by alias");
	await h.command('task "Review run"');
	assert.equal(h.sent().length, 3, "quoted, so the spaces survive");
	await h.command("task Review run");
	assert.equal(h.sent().length, 4, "unquoted multi-word names work too");
});

test("/do-always task reports what it cannot resolve", async () => {
	const h = harness([LIST_TASK]);
	await h.start();
	await h.command("task");
	assert.ok(lastNote(h).includes("/do-always task <name|number>"), lastNote(h));
	assert.equal(h.sent().length, 0);
	await h.command("task nope");
	assert.ok(lastNote(h).includes('unknown task "nope"'), lastNote(h));
	assert.equal(h.sent().length, 0);
});

test("/do-always task still respects a task's when condition and guards", async () => {
	const h = harness([{ name: "list", prompt: "Nope.", when: "git", mode: "run" }]);
	await h.start();
	await h.command("task list");
	// The harness dir is not a git repo, so `when: git` hides the task.
	assert.ok(lastNote(h).includes('hidden by its "when" condition'), lastNote(h));
	assert.equal(h.sent().length, 0);
});

test("a quoted name disambiguates /do-always mode from a trailing mode word", async () => {
	const h = harness([REVIEW_RUN]);
	await h.start();
	// Unquoted, the last token reads as the mode: "Review" is then unknown.
	await h.command("mode Review run");
	assert.ok(lastNote(h).includes('unknown task "Review"'), lastNote(h));
	// Quoted, the whole name is the task and the mode is cycled: the task's
	// config mode is `run`, so the cycle goes run → plan → fill.
	await h.command('mode "Review run"');
	assert.ok(lastNote(h).includes('"Review run" → plan'), lastNote(h));
	await h.command('mode "Review run"');
	assert.ok(lastNote(h).includes('"Review run" → fill'), lastNote(h));
	await h.command('mode "Review run" default');
	assert.ok(lastNote(h).includes('"Review run" → run'), "back to its config default");
	// And an explicit mode still works with the quoted name.
	await h.command('mode "Review run" plan');
	assert.ok(lastNote(h).includes('"Review run" → plan'), lastNote(h));
});

test("the other subcommands are untouched by the escape hatch", async () => {
	const h = harness([LIST_TASK], { chains: { ship: ["list"] } });
	await h.start();
	await h.command("chain");
	assert.ok(lastNote(h).includes("1. ship"), "chain still lists");
	await h.command("questionnaire");
	assert.ok(lastNote(h).includes("questionnaire disabled"), "questionnaire still toggles");
	await h.command("mode");
	assert.ok(lastNote(h).includes("list — run"), "mode still lists");
	await h.command("list-details");
	// In the TUI the details open in an editor view, not a notification.
	assert.ok(h.editor().some((body) => body.includes("List the widgets.")), "list-details still shows prompts");
});
