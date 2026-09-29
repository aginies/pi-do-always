import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_CATEGORY_ORDER,
	DEFAULT_SHORTCUT,
	DEFAULT_TASKS,
	formatList,
	groupTasksByCategory,
	isValidKeyId,
	mergeTasks,
	parseConfig,
	orderTasksByCategory,
	resolveShortcut,
	resolveTask,
	type DoAlwaysTask,
} from "../tasks";

const sample: DoAlwaysTask[] = [
	{ name: "review", description: "Review code", prompt: "review prompt" },
	{ name: "readme", description: "Update README", prompt: "readme prompt" },
];

// ---------------------------------------------------------------------------
// parseConfig
// ---------------------------------------------------------------------------

test("parseConfig accepts a bare array of tasks", () => {
	const raw = JSON.stringify(sample);
	const out = parseConfig(raw, "test.json");
	assert.deepEqual(out.tasks, sample);
	assert.equal(out.shortcut, undefined);
});

test("parseConfig accepts {\"tasks\": [...]}", () => {
	const raw = JSON.stringify({ tasks: sample });
	const out = parseConfig(raw, "test.json");
	assert.deepEqual(out.tasks, sample);
	assert.equal(out.shortcut, undefined);
});

test("parseConfig returns empty and reports on invalid JSON", () => {
	const errors: string[] = [];
	const out = parseConfig("{not json", "test.json", (m) => errors.push(m));
	assert.deepEqual(out.tasks, []);
	assert.equal(out.shortcut, undefined);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /invalid JSON/);
});

test("parseConfig returns empty and reports when the shape is wrong", () => {
	const errors: string[] = [];
	// A plain object is not an array and has no tasks key.
	const out = parseConfig(JSON.stringify({ foo: 1 }), "test.json", (m) => errors.push(m));
	assert.deepEqual(out.tasks, []);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /must be a JSON array/);
});

test("parseConfig returns empty and reports for a non-object JSON value (null)", () => {
	const errors: string[] = [];
	// null parses to a non-nullish primitive-less value with no tasks key.
	const out = parseConfig("null", "test.json", (m) => errors.push(m));
	assert.deepEqual(out.tasks, []);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /must be a JSON array/);
});

test("parseConfig skips invalid entries and reports each", () => {
	const errors: string[] = [];
	const raw = JSON.stringify([
		{ name: "ok", prompt: "ok prompt" },
		{ prompt: "no name" }, // missing name
		{ name: "no-prompt" }, // missing prompt
		{ name: "", prompt: "empty name" }, // empty name
		{ name: "empty-prompt", prompt: "" }, // empty prompt
		null,
	]);
	const out = parseConfig(raw, "test.json", (m) => errors.push(m));
	assert.equal(out.tasks.length, 1);
	assert.equal(out.tasks[0].name, "ok");
	assert.equal(out.tasks[0].prompt, "ok prompt");
	assert.equal(out.tasks[0].description, undefined);
	assert.equal(errors.length, 5);
});

test("parseConfig keeps a valid but missing description as undefined", () => {
	const out = parseConfig(JSON.stringify([{ name: "x", prompt: "p" }]), "test.json");
	assert.equal(out.tasks[0].description, undefined);
});

test("parseConfig reads a string shortcut from the object form", () => {
	const out = parseConfig(JSON.stringify({ tasks: sample, shortcut: "ctrl+shift+p" }), "test.json");
	assert.equal(out.shortcut, "ctrl+shift+p");
	assert.deepEqual(out.tasks, sample);
});

test("parseConfig trims whitespace around the shortcut", () => {
	const out = parseConfig(JSON.stringify({ tasks: [], shortcut: "  f5  " }), "test.json");
	assert.equal(out.shortcut, "f5");
});

test("parseConfig treats null and empty-string shortcut as disabled", () => {
	assert.equal(parseConfig(JSON.stringify({ tasks: [], shortcut: null }), "test.json").shortcut, null);
	assert.equal(parseConfig(JSON.stringify({ tasks: [], shortcut: "" }), "test.json").shortcut, null);
});

test("parseConfig ignores a non-string, non-null shortcut and reports it", () => {
	const errors: string[] = [];
	const out = parseConfig(JSON.stringify({ tasks: [], shortcut: 42 }), "test.json", (m) => errors.push(m));
	assert.equal(out.shortcut, undefined);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /invalid \"shortcut\"/);
});

// ---------------------------------------------------------------------------
// isValidKeyId
// ---------------------------------------------------------------------------

test("isValidKeyId accepts plain and modified keys", () => {
	for (const key of ["f4", "a", "5", "enter", "escape", "pageup", "ctrl+shift+p", "alt+f4", "super+k", "CTRL+SHIFT+P"]) {
		assert.ok(isValidKeyId(key), `expected "${key}" to be valid`);
	}
});

test("isValidKeyId rejects malformed keys", () => {
	for (const key of ["", "+", "ctrl+", "+p", "ctrl+ctrl+p", "foo", "f13", "ctrl+shift", "ctrl+shift+", "a+b"]) {
		assert.ok(!isValidKeyId(key), `expected "${key}" to be invalid`);
	}
});

// ---------------------------------------------------------------------------
// resolveShortcut
// ---------------------------------------------------------------------------

test("resolveShortcut falls back to DEFAULT_SHORTCUT when unset", () => {
	assert.equal(DEFAULT_SHORTCUT, "f4");
	assert.equal(resolveShortcut(undefined, undefined), DEFAULT_SHORTCUT);
});

test("resolveShortcut prefers the global value when the project file is silent", () => {
	assert.equal(resolveShortcut("f7", undefined), "f7");
});

test("resolveShortcut prefers the project value, including null to disable", () => {
	assert.equal(resolveShortcut("f7", "ctrl+shift+p"), "ctrl+shift+p");
	assert.equal(resolveShortcut("f7", null), null);
});

// ---------------------------------------------------------------------------
// mergeTasks
// ---------------------------------------------------------------------------

test("mergeTasks replaces a global task with the same project name", () => {
	const global: DoAlwaysTask[] = [{ name: "review", prompt: "old" }];
	const project: DoAlwaysTask[] = [{ name: "review", prompt: "new" }];
	const out = mergeTasks(global, project, []);
	assert.deepEqual(out, [{ name: "review", prompt: "new" }]);
});

test("mergeTasks appends new project tasks after globals", () => {
	const global: DoAlwaysTask[] = [{ name: "review", prompt: "r" }];
	const project: DoAlwaysTask[] = [{ name: "review", prompt: "r2" }, { name: "readme", prompt: "md" }];
	const out = mergeTasks(global, project, []);
	assert.deepEqual(out, [
		{ name: "review", prompt: "r2" },
		{ name: "readme", prompt: "md" },
	]);
});

test("mergeTasks falls back when nothing is defined", () => {
	const fallback: DoAlwaysTask[] = [{ name: "fallback", prompt: "fb" }];
	const out = mergeTasks([], [], fallback);
	assert.deepEqual(out, fallback);
});

// ---------------------------------------------------------------------------
// orderTasksByCategory
// ---------------------------------------------------------------------------

test("orderTasksByCategory groups by category in the configured order", () => {
	const tasks: DoAlwaysTask[] = [
		{ name: "review", category: "Plan", prompt: "r" },
		{ name: "readme", category: "Docs", prompt: "m" },
		{ name: "build", category: "Do", prompt: "b" },
		{ name: "commit", category: "Ops", prompt: "c" },
		{ name: "cleanup", category: "Plan", prompt: "cl" },
	];
	const out = orderTasksByCategory(tasks);
	assert.deepEqual(
		out.map((t) => t.name),
		["review", "cleanup", "build", "readme", "commit"],
	);
});

test("orderTasksByCategory preserves original order within a group", () => {
	const tasks: DoAlwaysTask[] = [
		{ name: "b", category: "Do", prompt: "" },
		{ name: "a", category: "Plan", prompt: "" },
		{ name: "c", category: "Do", prompt: "" },
		{ name: "d", category: "Plan", prompt: "" },
	];
	const out = orderTasksByCategory(tasks);
	assert.deepEqual(
		out.map((t) => t.name),
		["a", "d", "b", "c"],
	);
});

test("orderTasksByCategory puts uncategorized tasks under Other, last", () => {
	const tasks: DoAlwaysTask[] = [
		{ name: "x", prompt: "" },
		{ name: "y", category: "Plan", prompt: "" },
		{ name: "z", prompt: "" },
	];
	const out = orderTasksByCategory(tasks);
	assert.deepEqual(
		out.map((t) => t.name),
		["y", "x", "z"],
	);
});

test("orderTasksByCategory places unknown categories after the known ones", () => {
	const tasks: DoAlwaysTask[] = [
		{ name: "a", category: "Zeta", prompt: "" },
		{ name: "b", category: "Plan", prompt: "" },
		{ name: "c", category: "Alpha", prompt: "" },
	];
	const out = orderTasksByCategory(tasks);
	assert.deepEqual(
		out.map((t) => t.name),
		["b", "c", "a"],
	);
});

test("orderTasksByCategory uses DEFAULT_CATEGORY_ORDER by default", () => {
	const out = orderTasksByCategory(DEFAULT_TASKS);
	// First group is the first entry of DEFAULT_CATEGORY_ORDER ("Plan"); the very
	// first task is the first Plan task.
	assert.equal(DEFAULT_CATEGORY_ORDER[0], "Plan");
	assert.equal(out[0].name, "Review");
	assert.equal(out[0].category, "Plan");
	// All tasks are preserved.
	assert.equal(out.length, DEFAULT_TASKS.length);
	assert.deepEqual(new Set(out.map((t) => t.name)), new Set(DEFAULT_TASKS.map((t) => t.name)));
});

test("orderTasksByCategory groups case-insensitively", () => {
	const tasks: DoAlwaysTask[] = [
		{ name: "a", prompt: "p", category: "plan" },
		{ name: "b", prompt: "p", category: "Plan" },
		{ name: "c", prompt: "p", category: "PLAN" },
	];
	const out = orderTasksByCategory(tasks);
	// All three are the same category, so they stay together in input order.
	assert.deepEqual(out.map((t) => t.name), ["a", "b", "c"]);
});

test("groupTasksByCategory returns title-cased, ordered groups", () => {
	const tasks: DoAlwaysTask[] = [
		{ name: "a", prompt: "p", category: "docs" },
		{ name: "b", prompt: "p", category: "Plan" },
		{ name: "c", prompt: "p" }, // uncategorized -> Other
	];
	const groups = groupTasksByCategory(tasks);
	assert.deepEqual(
		groups.map((g) => [g.name, g.items.map((t) => t.name)]),
		[
			["Plan", ["b"]],
			["Docs", ["a"]],
			["Other", ["c"]],
		],
	);
});

// ---------------------------------------------------------------------------
// resolveTask
// ---------------------------------------------------------------------------

test("resolveTask picks by number (1-based)", () => {
	assert.equal(resolveTask(sample, "1")?.name, "review");
	assert.equal(resolveTask(sample, " 2 ")?.name, "readme"); // trims
});

test("resolveTask returns undefined for out-of-range numbers", () => {
	assert.equal(resolveTask(sample, "0"), undefined);
	assert.equal(resolveTask(sample, "3"), undefined);
	assert.equal(resolveTask(sample, "9"), undefined);
});

test("resolveTask matches by name (case-insensitive)", () => {
	assert.equal(resolveTask(sample, "review")?.name, "review");
	assert.equal(resolveTask(sample, "README")?.name, "readme");
});

test("resolveTask returns undefined for empty or unknown input", () => {
	assert.equal(resolveTask(sample, ""), undefined);
	assert.equal(resolveTask(sample, "   "), undefined);
	assert.equal(resolveTask(sample, "nope"), undefined);
});

// ---------------------------------------------------------------------------
// formatList
// ---------------------------------------------------------------------------

test("formatList renders a numbered one-line-per-task list", () => {
	assert.equal(
		formatList(sample),
		"1. review — Review code\n2. readme — Update README",
	);
});

test("formatList shows an empty label when a task has no description", () => {
	assert.equal(formatList([{ name: "x", prompt: "p" }]), "1. x — ");
});

test("formatList emits a header per category when tasks span multiple groups", () => {
	const tasks: DoAlwaysTask[] = [
		{ name: "review", prompt: "p", description: "Review code", category: "Plan" },
		{ name: "build", prompt: "p", description: "Build it", category: "Do" },
	];
	assert.equal(
		formatList(tasks),
		"PLAN\n1. review — Review code\nDO\n2. build — Build it",
	);
});

test("formatList omits headers when all tasks share one category", () => {
	const tasks: DoAlwaysTask[] = [
		{ name: "a", prompt: "p", description: "A", category: "Plan" },
		{ name: "b", prompt: "p", description: "B", category: "Plan" },
	];
	assert.equal(formatList(tasks), "1. a — A\n2. b — B");
});

// ---------------------------------------------------------------------------
// DEFAULT_TASKS
// ---------------------------------------------------------------------------

test("DEFAULT_TASKS is non-empty and internally consistent", () => {
	assert.ok(DEFAULT_TASKS.length > 0, "has at least one default task");
	for (const t of DEFAULT_TASKS) {
		assert.ok(typeof t.name === "string" && t.name.length > 0, `task "${t.name}" has a name`);
		assert.ok(typeof t.prompt === "string" && t.prompt.length > 0, `"${t.name}" has a prompt`);
	}
	// The first default should be Review, and resolvable by number.
	assert.equal(DEFAULT_TASKS[0].name, "Review");
	assert.equal(resolveTask(DEFAULT_TASKS, "1")?.name, "Review");
});
