import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CATEGORY_ORDER,
	DEFAULT_SHORTCUT,
	DEFAULT_TASKS,
	PROMPT_CONTEXT_KEYS,
	evaluateGuards,
	evaluateWhen,
	formatList,
	parseGuard,
	groupTasksByCategory,
	isValidKeyId,
	isValidWhen,
	mergeTasks,
	parseConfig,
	orderTasksByCategory,
	renderPrompt,
	resolveShortcut,
	resolveTask,
	shouldAutoRun,
	type DoAlwaysTask,
	type PromptContext,
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

test("parseConfig reads a boolean autoRun and omits it when absent", () => {
	const on = parseConfig(JSON.stringify([{ name: "x", prompt: "p", autoRun: true }]), "test.json");
	assert.equal(on.tasks[0].autoRun, true);
	const off = parseConfig(JSON.stringify([{ name: "x", prompt: "p", autoRun: false }]), "test.json");
	assert.equal(off.tasks[0].autoRun, false);
	const absent = parseConfig(JSON.stringify([{ name: "x", prompt: "p" }]), "test.json");
	assert.equal(absent.tasks[0].autoRun, undefined);
	assert.ok(!("autoRun" in absent.tasks[0]), "autoRun key omitted when not set");
});

test("parseConfig ignores a non-boolean autoRun", () => {
	const out = parseConfig(JSON.stringify([{ name: "x", prompt: "p", autoRun: "yes" }]), "test.json");
	assert.equal(out.tasks[0].autoRun, undefined);
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

test("parseConfig reads a valid merge field", () => {
	assert.equal(parseConfig(JSON.stringify({ tasks: [], merge: "append" }), "test.json").merge, "append");
	assert.equal(parseConfig(JSON.stringify({ tasks: [], merge: "override" }), "test.json").merge, "override");
});

test("parseConfig accepts a case-insensitive merge field", () => {
	assert.equal(parseConfig(JSON.stringify({ tasks: [], merge: "APPEND" }), "test.json").merge, "append");
});

test("parseConfig ignores an invalid merge field and reports it", () => {
	const errors: string[] = [];
	const out = parseConfig(JSON.stringify({ tasks: [], merge: "nope" }), "test.json", (m) => errors.push(m));
	assert.equal(out.merge, undefined);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /invalid \"merge\"/);
});

test("parseConfig ignores a non-string merge field and reports it", () => {
	const errors: string[] = [];
	const out = parseConfig(JSON.stringify({ tasks: [], merge: 42 }), "test.json", (m) => errors.push(m));
	assert.equal(out.merge, undefined);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /invalid \"merge\"/);
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

test("mergeTasks append keeps globals and only adds new names", () => {
	const global: DoAlwaysTask[] = [{ name: "review", prompt: "r" }];
	const project: DoAlwaysTask[] = [
		{ name: "review", prompt: "should be dropped" }, // duplicate name
		{ name: "lint", prompt: "l" }, // new
	];
	const out = mergeTasks(global, project, [], "append");
	assert.deepEqual(out.map((t) => [t.name, t.prompt]), [
		["review", "r"],
		["lint", "l"],
	]);
});

test("mergeTasks append preserves global order and drops duplicate names", () => {
	const global: DoAlwaysTask[] = [
		{ name: "a", prompt: "a" },
		{ name: "b", prompt: "b" },
	];
	const project: DoAlwaysTask[] = [
		{ name: "b", prompt: "x" }, // dropped (already exists)
		{ name: "c", prompt: "c" },
	];
	const out = mergeTasks(global, project, [], "append");
	assert.deepEqual(out.map((t) => t.name), ["a", "b", "c"]);
});

test("mergeTasks falls back when nothing is defined in append mode", () => {
	const fallback: DoAlwaysTask[] = [{ name: "fallback", prompt: "fb" }];
	const out = mergeTasks([], [], fallback, "append");
	assert.deepEqual(out, fallback);
});

test("mergeTasks defaults to override when mode is omitted", () => {
	const global: DoAlwaysTask[] = [{ name: "review", prompt: "old" }];
	const project: DoAlwaysTask[] = [{ name: "review", prompt: "new" }];
	const out = mergeTasks(global, project, []);
	assert.deepEqual(out, [{ name: "review", prompt: "new" }]);
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
	assert.equal(out[0].name, "Review changes");
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

// ---------------------------------------------------------------------------
// shouldAutoRun
// ---------------------------------------------------------------------------

test("shouldAutoRun defaults Plan-category tasks to true", () => {
	assert.equal(shouldAutoRun({ name: "a", category: "Plan", prompt: "p" }), true);
	assert.equal(shouldAutoRun({ name: "b", category: "plan", prompt: "p" }), true);
	assert.equal(shouldAutoRun({ name: "c", category: "  PLAN  ", prompt: "p" }), true);
});

test("shouldAutoRun defaults non-Plan and uncategorized tasks to false", () => {
	assert.equal(shouldAutoRun({ name: "a", category: "Do", prompt: "p" }), false);
	assert.equal(shouldAutoRun({ name: "b", category: "Ops", prompt: "p" }), false);
	assert.equal(shouldAutoRun({ name: "c", prompt: "p" }), false);
});

test("shouldAutoRun lets an explicit flag override the category default", () => {
	assert.equal(shouldAutoRun({ name: "a", category: "Plan", autoRun: false, prompt: "p" }), false);
	assert.equal(shouldAutoRun({ name: "b", category: "Do", autoRun: true, prompt: "p" }), true);
	assert.equal(shouldAutoRun({ name: "c", autoRun: true, prompt: "p" }), true);
});

test("parseConfig reads a valid when condition and omits it when absent", () => {
	const withString = parseConfig(JSON.stringify([{ name: "x", prompt: "p", when: "git" }]), "test.json");
	assert.equal(withString.tasks[0].when, "git");
	const withObject = parseConfig(JSON.stringify([{ name: "x", prompt: "p", when: { git: true } }]), "test.json");
	assert.deepEqual(withObject.tasks[0].when, { git: true });
	const absent = parseConfig(JSON.stringify([{ name: "x", prompt: "p" }]), "test.json");
	assert.equal(absent.tasks[0].when, undefined);
	assert.ok(!("when" in absent.tasks[0]), "when key omitted when not set");
});

test("parseConfig ignores a non-string, non-object when and reports it", () => {
	const out = parseConfig(JSON.stringify([{ name: "x", prompt: "p", when: 42 }]), "test.json");
	assert.equal(out.tasks[0].when, undefined);
});

test("parseConfig ignores an invalid when object and reports it", () => {
	const errors: string[] = [];
	const out = parseConfig(
		JSON.stringify([{ name: "x", prompt: "p", when: { nope: true } }]),
		"test.json",
		(m) => errors.push(m),
	);
	assert.equal(out.tasks[0].when, undefined);
	assert.ok(!("when" in out.tasks[0]), "when omitted when invalid");
	assert.equal(errors.length, 1);
	assert.match(errors[0], /invalid "when"/);
});

// ---------------------------------------------------------------------------
// isValidWhen
// ---------------------------------------------------------------------------

test("isValidWhen accepts the git string conditions", () => {
	assert.equal(isValidWhen("git"), true);
	assert.equal(isValidWhen("!git"), true);
});

test("isValidWhen rejects other string conditions", () => {
	assert.equal(isValidWhen("branch"), false);
	assert.equal(isValidWhen("f4"), false);
	assert.equal(isValidWhen("!branch"), false);
});

test("isValidWhen accepts a valid when object", () => {
	assert.equal(isValidWhen({ git: true }), true);
	assert.equal(isValidWhen({ branch: "main", file: "package.json", repo: "x" }), true);
	assert.equal(isValidWhen({ git: false, branch: "dev" }), true);
});

test("isValidWhen rejects an invalid when object", () => {
	assert.equal(isValidWhen({ git: "yes" }), false); // git must be boolean
	assert.equal(isValidWhen({ branch: 5 }), false); // branch must be a string
	assert.equal(isValidWhen({ file: 5 }), false); // file must be a string
	assert.equal(isValidWhen({ repo: null }), false); // repo must be a string
	assert.equal(isValidWhen({ unknown: true }), false); // unknown key
	assert.equal(isValidWhen([]), false); // arrays are not valid objects here
	assert.equal(isValidWhen(null), false);
	assert.equal(isValidWhen(42), false);
});

// ---------------------------------------------------------------------------
// evaluateWhen
// ---------------------------------------------------------------------------

test("evaluateWhen shows a task when no when condition is set", () => {
	assert.equal(evaluateWhen({ name: "a", prompt: "p" }, dirtyCtx), true);
	assert.equal(evaluateWhen({ name: "a", prompt: "p", when: undefined }, dirtyCtx), true);
});

test("evaluateWhen honors the git string condition", () => {
	assert.equal(evaluateWhen({ name: "a", prompt: "p", when: "git" }, dirtyCtx), true);
	assert.equal(evaluateWhen({ name: "a", prompt: "p", when: "git" }, nonGitCtx), false);
	assert.equal(evaluateWhen({ name: "a", prompt: "p", when: "!git" }, dirtyCtx), false);
	assert.equal(evaluateWhen({ name: "a", prompt: "p", when: "!git" }, nonGitCtx), true);
});

test("evaluateWhen honors the object git condition", () => {
	assert.equal(evaluateWhen({ name: "a", prompt: "p", when: { git: true } }, dirtyCtx), true);
	assert.equal(evaluateWhen({ name: "a", prompt: "p", when: { git: true } }, nonGitCtx), false);
	assert.equal(evaluateWhen({ name: "a", prompt: "p", when: { git: false } }, dirtyCtx), false);
	assert.equal(evaluateWhen({ name: "a", prompt: "p", when: { git: false } }, nonGitCtx), true);
});

test("evaluateWhen honors the branch condition", () => {
	assert.equal(evaluateWhen({ name: "a", prompt: "p", when: { branch: "main" } }, dirtyCtx), true);
	assert.equal(evaluateWhen({ name: "a", prompt: "p", when: { branch: "dev" } }, dirtyCtx), false);
});

test("evaluateWhen honors the repo condition", () => {
	assert.equal(evaluateWhen({ name: "a", prompt: "p", when: { repo: "proj" } }, dirtyCtx), true);
	assert.equal(evaluateWhen({ name: "a", prompt: "p", when: { repo: "other" } }, dirtyCtx), false);
});

test("evaluateWhen honors the file condition against the working tree", () => {
	const dir = mkdtempSync(tmpdir() + "/do-always-when-");
	writeFileSync(join(dir, "keep.txt"), "x");
	const ctx: PromptContext = { ...dirtyCtx, cwd: dir };
	try {
		assert.equal(evaluateWhen({ name: "a", prompt: "p", when: { file: "keep.txt" } }, ctx), true);
		assert.equal(evaluateWhen({ name: "a", prompt: "p", when: { file: "missing.txt" } }, ctx), false);
	} finally {
		rmdirSync(dir, { recursive: true });
	}
});

test("evaluateWhen ANDs multiple object conditions", () => {
	const gitAndBranch = { git: true, branch: "main" };
	assert.equal(evaluateWhen({ name: "a", prompt: "p", when: gitAndBranch }, dirtyCtx), true);
	const conflicting = { git: false, branch: "main" };
	assert.equal(evaluateWhen({ name: "a", prompt: "p", when: conflicting }, dirtyCtx), false);
});

test("parseConfig reads a boolean requireDirty and omits it when absent", () => {
	const on = parseConfig(JSON.stringify([{ name: "x", prompt: "p", requireDirty: true }]), "test.json");
	assert.equal(on.tasks[0].requireDirty, true);
	const off = parseConfig(JSON.stringify([{ name: "x", prompt: "p", requireDirty: false }]), "test.json");
	assert.equal(off.tasks[0].requireDirty, false);
	const absent = parseConfig(JSON.stringify([{ name: "x", prompt: "p" }]), "test.json");
	assert.equal(absent.tasks[0].requireDirty, undefined);
	assert.ok(!("requireDirty" in absent.tasks[0]), "requireDirty key omitted when not set");
});

test("parseConfig ignores a non-boolean requireDirty", () => {
	const out = parseConfig(JSON.stringify([{ name: "x", prompt: "p", requireDirty: "yes" }]), "test.json");
	assert.equal(out.tasks[0].requireDirty, undefined);
});

const dirtyCtx: PromptContext = {
	cwd: "/tmp/proj",
	date: "2026-09-29",
	branch: "main",
	last_commit: "x",
	files_changed: "a.ts",
	files_changed_count: "1",
	user: "y",
	diff_stat: "1 file changed",
	repo: "proj",
	staged_files: "a.ts",
	unstaged_files: "a.ts",
};
const cleanCtx: PromptContext = { ...dirtyCtx, files_changed: "none", files_changed_count: "0" };
// A non-git directory: branch falls back to "unknown" outside a repo.
const nonGitCtx: PromptContext = {
	...dirtyCtx,
	branch: "unknown",
	last_commit: "unknown",
	files_changed: "none",
	files_changed_count: "0",
	repo: "notgit",
	staged_files: "none",
	unstaged_files: "none",
};

test("evaluateGuards lets a task through when no guard is set", () => {
	assert.equal(evaluateGuards({ name: "a", prompt: "p" }, cleanCtx), null);
});

test("evaluateGuards blocks a requireDirty task only on a clean tree", () => {
	const guarded = { name: "a", prompt: "p", requireDirty: true };
	assert.equal(evaluateGuards(guarded, dirtyCtx), null, "dirty tree passes");
	assert.equal(evaluateGuards(guarded, cleanCtx), "working tree is clean — nothing to review");
});

test("evaluateGuards honors requireBranch", () => {
	const onBranch = { name: "a", prompt: "p", guards: [{ type: "requireBranch", value: "main" }] };
	const otherBranch = { name: "a", prompt: "p", guards: [{ type: "requireBranch", value: "release" }] };
	assert.equal(evaluateGuards(onBranch, dirtyCtx), null, "branch passes");
	assert.match(evaluateGuards(otherBranch, dirtyCtx), /not on branch "release"/);
});

test("evaluateGuards honors requireRepo", () => {
	const thisRepo = { name: "a", prompt: "p", guards: [{ type: "requireRepo", value: "proj" }] };
	const otherRepo = { name: "a", prompt: "p", guards: [{ type: "requireRepo", value: "elsewhere" }] };
	assert.equal(evaluateGuards(thisRepo, dirtyCtx), null, "repo passes");
	assert.match(evaluateGuards(otherRepo, dirtyCtx), /not in repo "elsewhere"/);
});

test("evaluateGuards honors requireFilePattern within a segment", () => {
	const tsMatch = { name: "a", prompt: "p", guards: [{ type: "requireFilePattern", value: "*.ts" }] };
	const jsOnly = { name: "a", prompt: "p", guards: [{ type: "requireFilePattern", value: "*.js" }] };
	assert.equal(evaluateGuards(tsMatch, dirtyCtx), null, "matching file passes");
	assert.match(evaluateGuards(jsOnly, dirtyCtx), /no changed files match "\*\.js"/);
});

test("evaluateGuards honors requireFilePattern with a ** glob across segments", () => {
	const ctx: PromptContext = { ...dirtyCtx, files_changed: "src/deep/nested/util.ts" };
	const anyTs = { name: "a", prompt: "p", guards: [{ type: "requireFilePattern", value: "**/*.ts" }] };
	const deepOnly = { name: "a", prompt: "p", guards: [{ type: "requireFilePattern", value: "src/**" }] };
	const noMatch = { name: "a", prompt: "p", guards: [{ type: "requireFilePattern", value: "**/*.py" }] };
	assert.equal(evaluateGuards(anyTs, ctx), null, "** matches across segments");
	assert.equal(evaluateGuards(deepOnly, ctx), null, "prefix glob passes");
	assert.match(evaluateGuards(noMatch, ctx), /no changed files match "\*\*\/\*\.py"/);
});

test("evaluateGuards combines legacy requireDirty with new guards", () => {
	// Dirty tree + branch matches -> passes even though requireDirty is set.
	const combined = {
name: "a",
prompt: "p",
requireDirty: true,
guards: [{ type: "requireBranch", value: "main" }],
	};
	assert.equal(evaluateGuards(combined, dirtyCtx), null);
	// Clean tree -> legacy requireDirty still blocks first.
	assert.equal(evaluateGuards(combined, cleanCtx), "working tree is clean — nothing to review");
	// Dirty but wrong branch -> the new guard blocks.
	const otherCtx: PromptContext = { ...dirtyCtx, branch: "dev" };
	assert.match(evaluateGuards(combined, otherCtx), /not on branch "main"/);
});

test("parseGuard accepts a valid guard of each kind", () => {
	assert.deepEqual(parseGuard({ type: "requireDirty" }, "t.json"), { type: "requireDirty" });
	assert.deepEqual(parseGuard({ type: "requireBranch", value: "main" }, "t.json"), {
type: "requireBranch",
value: "main",
	});
	assert.deepEqual(parseGuard({ type: "requireRepo", value: "x" }, "t.json"), {
type: "requireRepo",
value: "x",
	});
	assert.deepEqual(parseGuard({ type: "requireFilePattern", value: "**/*.ts" }, "t.json"), {
type: "requireFilePattern",
value: "**/*.ts",
	});
});

test("parseGuard rejects an invalid guard and reports it", () => {
	const errors: string[] = [];
	const onError = (m: string) => errors.push(m);
	assert.equal(parseGuard(42, "t.json", onError), undefined);
	assert.equal(parseGuard({ type: "nope" }, "t.json", onError), undefined);
	assert.equal(parseGuard({ type: "requireBranch" }, "t.json", onError), undefined);
	assert.equal(errors.length, 3);
});

test("parseConfig parses a guards array and drops invalid entries", () => {
	const on = parseConfig(
JSON.stringify([{ name: "x", prompt: "p", guards: [{ type: "requireBranch", value: "main" }] }]),
"test.json",
	);
	assert.deepEqual(on.tasks[0].guards, [{ type: "requireBranch", value: "main" }]);
	// An invalid entry is skipped with a warning, but valid ones survive.
	const errors: string[] = [];
	const off = parseConfig(
JSON.stringify([
{
name: "x",
prompt: "p",
guards: [{ type: "requireBranch", value: "main" }, { type: "nope" }],
},
]),
"test.json",
(m) => errors.push(m),
	);
	assert.deepEqual(off.tasks[0].guards, [{ type: "requireBranch", value: "main" }]);
	assert.equal(errors.length, 1);
});

test("parseConfig warns on a non-array guards value", () => {
	const errors: string[] = [];
	const out = parseConfig(
JSON.stringify([{ name: "x", prompt: "p", guards: { type: "requireBranch" } }]),
"test.json",
(m) => errors.push(m),
	);
	assert.equal(out.tasks[0].guards, undefined);
	assert.equal(errors.length, 1);
});

test("DEFAULT_TASKS marks Review changes and Commit as requireDirty", () => {
	const byName = new Map(DEFAULT_TASKS.map((t) => [t.name, t]));
	assert.equal(byName.get("Review changes")?.requireDirty, true);
	assert.equal(byName.get("Commit")?.requireDirty, true);
	assert.equal(byName.get("Review")?.requireDirty, undefined, "the old 'Review' name no longer exists");
	assert.ok(byName.has("Review code"), "the new 'Review code' task exists");
});

test("DEFAULT_TASKS is non-empty and internally consistent", () => {
	assert.ok(DEFAULT_TASKS.length > 0, "has at least one default task");
	for (const t of DEFAULT_TASKS) {
		assert.ok(typeof t.name === "string" && t.name.length > 0, `task "${t.name}" has a name`);
		assert.ok(typeof t.prompt === "string" && t.prompt.length > 0, `"${t.name}" has a prompt`);
	}
	// The first default should be Review changes, and resolvable by number.
	assert.equal(DEFAULT_TASKS[0].name, "Review changes");
	assert.equal(resolveTask(DEFAULT_TASKS, "1")?.name, "Review changes");
	// No default task sets an explicit autoRun; the default is derived from the
	// category (Plan tasks auto-run, the rest fill the editor).
	for (const t of DEFAULT_TASKS) {
		assert.equal(t.autoRun, undefined, `default task "${t.name}" has no explicit autoRun`);
	}
	assert.equal(shouldAutoRun(DEFAULT_TASKS[0]), true, "first default (Review changes, Plan) auto-runs");
});

// ---------------------------------------------------------------------------
// renderPrompt
// ---------------------------------------------------------------------------

test("renderPrompt substitutes known keys", () => {
	assert.equal(renderPrompt("On {{branch}}", { branch: "fix/login" }), "On fix/login");
});

test("renderPrompt substitutes every occurrence of a key", () => {
	assert.equal(renderPrompt("{{x}} and {{x}}", { x: "1" }), "1 and 1");
});

test("renderPrompt leaves unknown keys as-is", () => {
	const out = renderPrompt("a {{nope}} b {{a-b}} c {{a.b}} d {{}} e", { x: "1" });
	assert.equal(out, "a {{nope}} b {{a-b}} c {{a.b}} d {{}} e");
});

test("renderPrompt tolerates whitespace inside braces", () => {
	assert.equal(renderPrompt("{{ branch }}", { branch: "main" }), "main");
});

test("renderPrompt blanks a key present with an empty value", () => {
	assert.equal(renderPrompt("[{{x}}]", { x: "" }), "[]");
});

test("renderPrompt leaves a template without placeholders unchanged", () => {
	const t = "No placeholders here, just {braces} and }} text";
	assert.equal(renderPrompt(t, { x: "1" }), t);
});

test("DEFAULT_TASKS prompts only use known context keys", () => {
	const known = new Set<string>(PROMPT_CONTEXT_KEYS);
	for (const t of DEFAULT_TASKS) {
		for (const m of t.prompt.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
			assert.ok(known.has(m[1]), `"${t.name}" uses unknown placeholder {{${m[1]}}}`);
		}
	}
});

test("rendering every default prompt with a full context leaves no placeholders", () => {
	const ctx: Record<string, string> = {
		cwd: "/tmp/proj",
		date: "2026-09-29",
		branch: "fix/login-null",
		last_commit: "Fix null check in login",
		files_changed: "auth.ts, login.ts, test/auth.test.ts",
		files_changed_count: "3",
		user: "Agine",
		diff_stat: "3 files changed, 41 insertions(+), 7 deletions(-)",
		repo: "pi-do-always",
		staged_files: "a.ts, b.ts",
		unstaged_files: "c.ts",
	};
	for (const t of DEFAULT_TASKS) {
		assert.doesNotMatch(renderPrompt(t.prompt, ctx), /\{\{/, t.name);
	}
});

test("rendering default prompts with a fallback (non-git) context leaves no placeholders", () => {
	const ctx: Record<string, string> = {
		cwd: "/tmp/notgit",
		date: "2026-09-29",
		branch: "unknown",
		last_commit: "unknown",
		files_changed: "none",
		files_changed_count: "0",
		user: "unknown",
		diff_stat: "none",
		repo: "notgit",
		staged_files: "none",
		unstaged_files: "none",
	};
	for (const t of DEFAULT_TASKS) {
		assert.doesNotMatch(renderPrompt(t.prompt, ctx), /\{\{/, t.name);
	}
});
