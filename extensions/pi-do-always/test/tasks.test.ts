import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CHAIN_MAX,
	COMMIT_BROWSER_MAX,
	COMMIT_SELECT_MAX,
	DEFAULT_CATEGORY_ORDER,
	DEFAULT_SHORTCUT,
	DEFAULT_TASKS,
	MAX_FILES_LISTED,
	PLAN_NUDGE_PROMPT,
	PROMPT_CONTEXT_KEYS,
	TEST_PLAN_SAMPLE_MALFORMED,
	TEST_PLAN_SAMPLE_OK,
	buildTableRows,
	chainAdd,
	chainClear,
	chainRemove,
	chainRunLabel,
	chainUndo,
	evaluateGuards,
	evaluateWhen,
	formatChainSequence,
	formatCommitReviewPrompt,
	formatList,
	formatPlanExecutionPrompt,
	planBlockDiagnostics,
	formatSelectedCommits,
	groupCommitsByDate,
	parseGitLogOutput,
	parsePlanProposal,
	parseGuard,
	groupTasksByCategory,
	isPlanTask,
	isTaskVisible,
	isValidKeyId,
	isValidWhen,
	mergeTasks,
	parseConfig,
	parseConfigRegexpValueForKey,
	parseCommitSubject,
	parseStatusPorcelain,
	parseStatusStagedUnstaged,
	orderTasksByCategory,
	planItemKey,
	planSelectAll,
	planSelectionClear,
	planSelectedItems,
	planTierState,
	planToggleItem,
	planToggleTier,
	renderPrompt,
	reportAbandonedFooter,
	reportFileName,
	reportFooter,
	reportHeader,
	reportStepSection,
	reportWorthKeeping,
	assistantText,
	resolveReportPath,
	resolveShortcut,
	resolveTask,
	shouldAutoRun,
	stepSummary,
	stripPlanBlocks,
	chainSummary,
	formatDuration,
	MAX_FILE_LINES,
	toPromptContext,
	validateChain,
	GUARD_TYPES,
	type CommitInfo,
	type DateGroup,
	type DoAlwaysTask,
	type Guard,
	type PlanProposal,
	type PromptContext,
	type SelectedCommit,
	type TaskContext,
} from "../tasks";

const sample: DoAlwaysTask[] = [
	{ name: "review", description: "Review code", prompt: "review prompt" },
	{ name: "readme", description: "Update README", prompt: "readme prompt" },
];

// Structured-context fixtures shared by the evaluateWhen / evaluateGuards tests.
const dirtyCtx: TaskContext = {
	cwd: "/tmp/proj",
	date: "2026-09-29",
	branch: "main",
	lastCommit: "x",
	files: ["a.ts"],
	user: "y",
	diffStat: "1 file changed",
	repo: "proj",
	stagedFiles: ["a.ts"],
	unstagedFiles: ["a.ts"],
	selectedCommits: "none",
	isGitRepo: true,
};
const cleanCtx: TaskContext = { ...dirtyCtx, files: [], diffStat: "none", stagedFiles: [], unstagedFiles: [] };
// A non-git directory: git facts fall back to neutral values.
const nonGitCtx: TaskContext = {
	...dirtyCtx,
	branch: "unknown",
	lastCommit: "unknown",
	files: [],
	user: "unknown",
	diffStat: "none",
	repo: "notgit",
	stagedFiles: [],
	unstagedFiles: [],
	isGitRepo: false,
};

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

test("parseConfig reads a valid browser field and omits it when absent", () => {
	const on = parseConfig(JSON.stringify([{ name: "x", prompt: "p", browser: "commits" }]), "test.json");
	assert.equal(on.tasks[0].browser, "commits");
	const absent = parseConfig(JSON.stringify([{ name: "x", prompt: "p" }]), "test.json");
	assert.ok(!("browser" in absent.tasks[0]), "browser key omitted when not set");
});

test("parseConfig ignores an invalid browser field and reports it", () => {
	const errors: string[] = [];
	const out = parseConfig(JSON.stringify([{ name: "x", prompt: "p", browser: "nope" }]), "test.json", (m) => errors.push(m));
	assert.equal(out.tasks[0].browser, undefined);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /invalid "browser"/);
});

test("parseConfig reads a boolean hidden flag and omits it when absent", () => {
	const on = parseConfig(JSON.stringify([{ name: "x", prompt: "p", hidden: true }]), "test.json");
	assert.equal(on.tasks[0].hidden, true);
	const absent = parseConfig(JSON.stringify([{ name: "x", prompt: "p" }]), "test.json");
	assert.ok(!("hidden" in absent.tasks[0]), "hidden key omitted when not set");
});

test("parseConfig reads a boolean notForCommits flag and omits it when absent", () => {
	const on = parseConfig(JSON.stringify([{ name: "x", prompt: "p", notForCommits: true }]), "test.json");
	assert.equal(on.tasks[0].notForCommits, true);
	const absent = parseConfig(JSON.stringify([{ name: "x", prompt: "p" }]), "test.json");
	assert.ok(!("notForCommits" in absent.tasks[0]), "notForCommits key omitted when not set");
});

test("parseConfig reads a boolean hidePlan flag and omits it when absent", () => {
	const on = parseConfig(JSON.stringify([{ name: "x", prompt: "p", hidePlan: true }]), "test.json");
	assert.equal(on.tasks[0].hidePlan, true);
	const off = parseConfig(JSON.stringify([{ name: "x", prompt: "p", hidePlan: false }]), "test.json");
	assert.equal(off.tasks[0].hidePlan, false);
	const absent = parseConfig(JSON.stringify([{ name: "x", prompt: "p" }]), "test.json");
	assert.ok(!("hidePlan" in absent.tasks[0]), "hidePlan key omitted when not set");
});

test("parseConfig ignores a non-boolean hidePlan", () => {
	const out = parseConfig(JSON.stringify([{ name: "x", prompt: "p", hidePlan: "no" }]), "test.json");
	assert.equal(out.tasks[0].hidePlan, undefined);
});

test("parseConfig reads a global hidePlan from the object form", () => {
	assert.equal(parseConfig(JSON.stringify({ tasks: [], hidePlan: false }), "test.json").hidePlan, false);
	assert.equal(parseConfig(JSON.stringify({ tasks: [], hidePlan: true }), "test.json").hidePlan, true);
	assert.equal(parseConfig(JSON.stringify({ tasks: [] }), "test.json").hidePlan, undefined);
	assert.equal(parseConfig(JSON.stringify([{ name: "x", prompt: "p" }]), "test.json").hidePlan, undefined);
});

test("parseConfig ignores a non-boolean global hidePlan and reports it", () => {
	const errors: string[] = [];
	const out = parseConfig(JSON.stringify({ tasks: [], hidePlan: 1 }), "test.json", (m) => errors.push(m));
	assert.equal(out.hidePlan, undefined);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /invalid "hidePlan"/);
});

test("parseConfig reads a global planNudge from the object form", () => {
	assert.equal(parseConfig(JSON.stringify({ tasks: [], planNudge: false }), "test.json").planNudge, false);
	assert.equal(parseConfig(JSON.stringify({ tasks: [], planNudge: true }), "test.json").planNudge, true);
	assert.equal(parseConfig(JSON.stringify({ tasks: [] }), "test.json").planNudge, undefined);
	assert.equal(parseConfig(JSON.stringify([{ name: "x", prompt: "p" }]), "test.json").planNudge, undefined);
});

test("parseConfig ignores a non-boolean global planNudge and reports it", () => {
	const errors: string[] = [];
	const out = parseConfig(JSON.stringify({ tasks: [], planNudge: 1 }), "test.json", (m) => errors.push(m));
	assert.equal(out.planNudge, undefined);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /invalid "planNudge"/);
});

test("PLAN_NUDGE_PROMPT carries the plan-block contract", () => {
	// The nudge must restate the machine-readable contract the parse layer
	// relies on: a plan-tagged fence, JSON-only content, block last.
	assert.match(PLAN_NUDGE_PROMPT, /```plan/);
	assert.match(PLAN_NUDGE_PROMPT, /\"summary\"/);
	assert.match(PLAN_NUDGE_PROMPT, /\"tiers\"/);
	assert.match(PLAN_NUDGE_PROMPT, /very last thing in your reply/);
	assert.match(PLAN_NUDGE_PROMPT, /empty "tiers" array/);
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

test("DEFAULT_CATEGORY_ORDER includes Browse right after Plan", () => {
	assert.deepEqual(DEFAULT_CATEGORY_ORDER, ["Plan", "Browse", "Do", "Docs", "Ops", "Other"]);
});

test("orderTasksByCategory places Browse between Plan and Do", () => {
	const tasks: DoAlwaysTask[] = [
		{ name: "a", category: "Do", prompt: "" },
		{ name: "b", category: "Browse", prompt: "" },
		{ name: "c", category: "Plan", prompt: "" },
	];
	const out = orderTasksByCategory(tasks);
	assert.deepEqual(
		out.map((t) => t.name),
		["c", "b", "a"],
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

// ── resolveTask with aliases ────────────────────────────────────────────────

const aliasedSample: DoAlwaysTask[] = [
	{ name: "review", prompt: "p", aliases: ["r", "rev"] },
	{ name: "build", prompt: "p", aliases: ["b", "bl"] },
	{ name: "readme", prompt: "p" },
];

test("resolveTask resolves by alias (case-insensitive)", () => {
	assert.equal(resolveTask(aliasedSample, "r")?.name, "review");
	assert.equal(resolveTask(aliasedSample, "R")?.name, "review");
	assert.equal(resolveTask(aliasedSample, "rev")?.name, "review");
	assert.equal(resolveTask(aliasedSample, "b")?.name, "build");
	assert.equal(resolveTask(aliasedSample, "BL")?.name, "build");
});

test("resolveTask prefers alias over name when both match", () => {
	// "review" matches the name; "r" only matches the alias.
	assert.equal(resolveTask(aliasedSample, "r")?.name, "review");
	// "readme" does not match any alias; falls through to name.
	assert.equal(resolveTask(aliasedSample, "readme")?.name, "readme");
});

test("resolveTask falls back to name when no alias matches", () => {
	assert.equal(resolveTask(aliasedSample, "readme")?.name, "readme");
	assert.equal(resolveTask(aliasedSample, "README")?.name, "readme");
});

test("resolveTask returns undefined when neither alias nor name matches", () => {
	assert.equal(resolveTask(aliasedSample, "deploy"), undefined);
	assert.equal(resolveTask(aliasedSample, "D"), undefined);
});

// ── formatList ───────────────────────────────────────────────────────────────

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
	const ctx: TaskContext = { ...dirtyCtx, cwd: dir };
	try {
		assert.equal(evaluateWhen({ name: "a", prompt: "p", when: { file: "keep.txt" } }, ctx), true);
		assert.equal(evaluateWhen({ name: "a", prompt: "p", when: { file: "missing.txt" } }, ctx), false);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test("evaluateWhen ANDs multiple object conditions", () => {
	const gitAndBranch = { git: true, branch: "main" };
	assert.equal(evaluateWhen({ name: "a", prompt: "p", when: gitAndBranch }, dirtyCtx), true);
	const conflicting = { git: false, branch: "main" };
	assert.equal(evaluateWhen({ name: "a", prompt: "p", when: conflicting }, dirtyCtx), false);
});

// ---------------------------------------------------------------------------
// isTaskVisible (selector + list visibility: hidden flag AND when condition)
// ---------------------------------------------------------------------------

test("isTaskVisible shows a plain task", () => {
	assert.equal(isTaskVisible({ name: "a", prompt: "p" }, dirtyCtx), true);
	assert.equal(isTaskVisible({ name: "a", prompt: "p" }, nonGitCtx), true);
});

test("isTaskVisible hides a hidden task even when its when condition passes", () => {
	const hidden = { name: "a", prompt: "p", hidden: true };
	assert.equal(isTaskVisible(hidden, dirtyCtx), false);
	assert.equal(isTaskVisible({ ...hidden, when: "git" }, dirtyCtx), false);
});

test("isTaskVisible hides a task whose when condition fails, even when not hidden", () => {
	const gitOnly = { name: "a", prompt: "p", when: "git" };
	assert.equal(isTaskVisible(gitOnly, dirtyCtx), true);
	assert.equal(isTaskVisible(gitOnly, nonGitCtx), false);
});

test("isTaskVisible matches the built-in Review commits (hidden) and Browse commits (when: git)", () => {
	const review = DEFAULT_TASKS.find((t) => t.name === "Review commits");
	const browse = DEFAULT_TASKS.find((t) => t.name === "Browse commits");
	assert.ok(review && browse);
	assert.equal(isTaskVisible(review, dirtyCtx), false, "hidden Review commits is never in the selector");
	assert.equal(isTaskVisible(browse, dirtyCtx), true, "Browse commits shows in a git repo");
	assert.equal(isTaskVisible(browse, nonGitCtx), false, "Browse commits hides outside git");
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

test("evaluateGuards lets a task through when no guard is set", () => {
	assert.equal(evaluateGuards({ name: "a", prompt: "p" }, cleanCtx), null);
});

test("evaluateGuards blocks a requireDirty task only on a clean tree", () => {
	const guarded = { name: "a", prompt: "p", requireDirty: true };
	assert.equal(evaluateGuards(guarded, dirtyCtx), null, "dirty tree passes");
	assert.equal(evaluateGuards(guarded, cleanCtx), "working tree is clean — nothing to review");
});

test("evaluateGuards honors requireBranch", () => {
	const onBranch: DoAlwaysTask = { name: "a", prompt: "p", guards: [{ type: "requireBranch", value: "main" }] };
	const otherBranch: DoAlwaysTask = { name: "a", prompt: "p", guards: [{ type: "requireBranch", value: "release" }] };
	assert.equal(evaluateGuards(onBranch, dirtyCtx), null, "branch passes");
	assert.match(evaluateGuards(otherBranch, dirtyCtx)!, /not on branch "release"/);
});

test("evaluateGuards honors requireRepo", () => {
	const thisRepo: DoAlwaysTask = { name: "a", prompt: "p", guards: [{ type: "requireRepo", value: "proj" }] };
	const otherRepo: DoAlwaysTask = { name: "a", prompt: "p", guards: [{ type: "requireRepo", value: "elsewhere" }] };
	assert.equal(evaluateGuards(thisRepo, dirtyCtx), null, "repo passes");
	assert.match(evaluateGuards(otherRepo, dirtyCtx)!, /not in repo "elsewhere"/);
});

test("evaluateGuards honors requireFilePattern within a segment", () => {
	const tsMatch: DoAlwaysTask = { name: "a", prompt: "p", guards: [{ type: "requireFilePattern", value: "*.ts" }] };
	const jsOnly: DoAlwaysTask = { name: "a", prompt: "p", guards: [{ type: "requireFilePattern", value: "*.js" }] };
	assert.equal(evaluateGuards(tsMatch, dirtyCtx), null, "matching file passes");
	assert.match(evaluateGuards(jsOnly, dirtyCtx)!, /no changed files match "\*\.js"/);
});

test("evaluateGuards honors requireFilePattern with a ** glob across segments", () => {
	const ctx: TaskContext = { ...dirtyCtx, files: ["src/deep/nested/util.ts"] };
	const anyTs: DoAlwaysTask = { name: "a", prompt: "p", guards: [{ type: "requireFilePattern", value: "**/*.ts" }] };
	const deepOnly: DoAlwaysTask = { name: "a", prompt: "p", guards: [{ type: "requireFilePattern", value: "src/**" }] };
	const noMatch: DoAlwaysTask = { name: "a", prompt: "p", guards: [{ type: "requireFilePattern", value: "**/*.py" }] };
	assert.equal(evaluateGuards(anyTs, ctx), null, "** matches across segments");
	assert.equal(evaluateGuards(deepOnly, ctx), null, "prefix glob passes");
	assert.match(evaluateGuards(noMatch, ctx)!, /no changed files match "\*\*\/\*\.py"/);
});

test("evaluateGuards combines legacy requireDirty with new guards", () => {
	// Dirty tree + branch matches -> passes even though requireDirty is set.
	const combined: DoAlwaysTask = {
		name: "a",
		prompt: "p",
		requireDirty: true,
		guards: [{ type: "requireBranch", value: "main" }],
	};
	assert.equal(evaluateGuards(combined, dirtyCtx), null);
	// Clean tree -> legacy requireDirty still blocks first.
	assert.equal(evaluateGuards(combined, cleanCtx), "working tree is clean — nothing to review");
	// Dirty but wrong branch -> the new guard blocks.
	const otherCtx: TaskContext = { ...dirtyCtx, branch: "dev" };
	assert.match(evaluateGuards(combined, otherCtx)!, /not on branch "main"/);
});

test("requireFilePattern sees files beyond the display cap", () => {
	// 25 changed files: file 21 is past MAX_FILES_LISTED, so the capped
	// `files_changed` string no longer contains it — the guard must still see it.
	const files = Array.from({ length: 25 }, (_, i) => `f${i}.js`);
	const ctx: TaskContext = { ...dirtyCtx, files };
	const pastCap: DoAlwaysTask = { name: "a", prompt: "p", guards: [{ type: "requireFilePattern", value: "f21.js" }] };
	assert.equal(evaluateGuards(pastCap, ctx), null, "file past the cap still matches");
	const noMatch: DoAlwaysTask = { name: "a", prompt: "p", guards: [{ type: "requireFilePattern", value: "*.ts" }] };
	assert.match(evaluateGuards(noMatch, ctx)!, /no changed files match/, "no match still blocks past the cap");
});

test("requireFilePattern handles filenames containing commas", () => {
	const ctx: TaskContext = { ...dirtyCtx, files: ["src/a,b.ts"] };
	const exact: DoAlwaysTask = { name: "a", prompt: "p", guards: [{ type: "requireFilePattern", value: "src/a,b.ts" }] };
	assert.equal(evaluateGuards(exact, ctx), null, "a comma in the filename does not split the file");
	const glob: DoAlwaysTask = { name: "a", prompt: "p", guards: [{ type: "requireFilePattern", value: "src/*.ts" }] };
	assert.equal(evaluateGuards(glob, ctx), null, "glob matches across the comma");
});

test("when:git uses the authoritative isGitRepo flag, not the branch sentinel", () => {
	// A branch literally named "unknown" (detached HEAD reports "HEAD") must not
	// make a git repo look non-git.
	const oddBranch: TaskContext = { ...dirtyCtx, branch: "unknown", isGitRepo: true };
	assert.equal(evaluateWhen({ name: "a", prompt: "p", when: "git" }, oddBranch), true);
	assert.equal(evaluateWhen({ name: "a", prompt: "p", when: "!git" }, oddBranch), false);
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

test("GUARD_TYPES and Guard interfaces are properly exported", () => {
	assert.ok(Array.isArray(GUARD_TYPES));
	assert.ok(GUARD_TYPES.includes("requireDirty"));
	assert.ok(GUARD_TYPES.includes("requireBranch"));
	assert.ok(GUARD_TYPES.includes("requireRepo"));
	assert.ok(GUARD_TYPES.includes("requireFilePattern"));
	const g: Guard = { type: "requireBranch", value: "main" };
	assert.equal(g.type, "requireBranch");
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
// toPromptContext (structured → string view)
// ---------------------------------------------------------------------------

test("toPromptContext maps every structured fact to its string view", () => {
	const out: PromptContext = toPromptContext(dirtyCtx);
	assert.deepEqual(out, {
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
		selected_commits: "none",
	});
});

test("toPromptContext renders empty lists as 'none' with an exact count", () => {
	const out = toPromptContext(cleanCtx);
	assert.equal(out.files_changed, "none");
	assert.equal(out.files_changed_count, "0");
	assert.equal(out.staged_files, "none");
	assert.equal(out.unstaged_files, "none");
});

test("toPromptContext caps files_changed at MAX_FILES_LISTED but keeps the exact count", () => {
	const many: TaskContext = { ...dirtyCtx, files: Array.from({ length: 25 }, (_, i) => `f${i}.ts`) };
	const out = toPromptContext(many);
	assert.equal(out.files_changed_count, "25");
	assert.ok(out.files_changed.startsWith("f0.ts, f1.ts"));
	assert.ok(out.files_changed.endsWith("… (+5 more)"));
	assert.equal(out.files_changed.split(", ").length, MAX_FILES_LISTED + 1); // 20 paths + suffix
});

test("toPromptContext joins staged/unstaged lists with newlines", () => {
	const ctx: TaskContext = { ...dirtyCtx, stagedFiles: ["a.ts", "b.ts"], unstagedFiles: ["c.ts"] };
	const out = toPromptContext(ctx);
	assert.equal(out.staged_files, "a.ts\nb.ts");
	assert.equal(out.unstaged_files, "c.ts");
});

test("PROMPT_CONTEXT_KEYS includes selected_commits", () => {
	assert.ok((PROMPT_CONTEXT_KEYS as readonly string[]).includes("selected_commits"));
});

test("toPromptContext passes selectedCommits through", () => {
	const ctx = { ...dirtyCtx, selectedCommits: "Commit aaaaaaa (…)" };
	assert.equal(toPromptContext(ctx).selected_commits, "Commit aaaaaaa (…)");
});

test("toPromptContext caps staged_files and unstaged_files at MAX_FILE_LINES", () => {
	const manyStaged = Array.from({ length: 65 }, (_, i) => `staged-${i}.ts`);
	const manyUnstaged = Array.from({ length: 55 }, (_, i) => `unstaged-${i}.ts`);
	const ctx: TaskContext = { ...dirtyCtx, stagedFiles: manyStaged, unstagedFiles: manyUnstaged };
	const out = toPromptContext(ctx);
	const stagedLines = out.staged_files.split("\n");
	assert.equal(stagedLines.length, MAX_FILE_LINES + 1);
	assert.equal(stagedLines[0], "staged-0.ts");
	assert.equal(stagedLines[MAX_FILE_LINES], "… (+15 more)");
	const unstagedLines = out.unstaged_files.split("\n");
	assert.equal(unstagedLines.length, MAX_FILE_LINES + 1);
	assert.equal(unstagedLines[0], "unstaged-0.ts");
	assert.equal(unstagedLines[MAX_FILE_LINES], "… (+5 more)");
});

// ---------------------------------------------------------------------------
// parseStatusPorcelain / parseStatusStagedUnstaged / parseCommitSubject /
// parseConfigRegexpValueForKey
// ---------------------------------------------------------------------------

test("parseStatusPorcelain extracts paths, skips short lines, dedupes, and sorts", () => {
	const status = [" M zeta.ts", " M alpha.ts", "A  beta.ts", " M alpha.ts", "x", ""].join("\n");
	assert.deepEqual(parseStatusPorcelain(status), ["alpha.ts", "beta.ts", "zeta.ts"]);
});

test("parseStatusPorcelain handles quoted paths and rename arrows", () => {
	const status = [
		' M "file with spaces.ts"',
		"R  old-name.ts -> new-name.ts",
		'R  "old space.ts" -> "new space.ts"',
	].join("\n");
	assert.deepEqual(parseStatusPorcelain(status), [
		"file with spaces.ts",
		"new space.ts",
		"new-name.ts",
	]);
});

test("parseStatusPorcelain returns [] for empty input", () => {
	assert.deepEqual(parseStatusPorcelain(""), []);
});

test("parseStatusStagedUnstaged splits staged, unstaged, and untracked files", () => {
	const status = [" M a.ts", "M  b.ts", "?? c.ts", "MM d.ts", " D e.ts", "D  f.ts"].join("\n");
	const { staged, unstaged } = parseStatusStagedUnstaged(status);
	// Porcelain v1: the path starts at index 3 — no leading spaces in the results.
	assert.deepEqual(staged, ["b.ts", "c.ts", "d.ts", "f.ts"]);
	assert.deepEqual(unstaged, ["a.ts", "e.ts"]);
});

test("parseStatusStagedUnstaged handles quoted paths and rename arrows", () => {
	const status = [
		' M "unstaged with space.ts"',
		'M  "staged with space.ts"',
		'R  "old name.ts" -> "new renamed.ts"',
	].join("\n");
	const { staged, unstaged } = parseStatusStagedUnstaged(status);
	assert.deepEqual(staged, ["staged with space.ts", "new renamed.ts"]);
	assert.deepEqual(unstaged, ["unstaged with space.ts"]);
});

test("parseStatusStagedUnstaged skips short lines and dedupes paths", () => {
	const { staged, unstaged } = parseStatusStagedUnstaged("M\n M x.ts\nM  x.ts\n");
	assert.deepEqual(staged, []);
	assert.deepEqual(unstaged, ["x.ts"]);
});

test("parseStatusStagedUnstaged returns empty lists for empty input", () => {
	assert.deepEqual(parseStatusStagedUnstaged(""), { staged: [], unstaged: [] });
});

test("parseCommitSubject keeps the full subject after the hash", () => {
	assert.equal(parseCommitSubject("abc123 Fix login null check"), "Fix login null check");
	assert.equal(parseCommitSubject("abc123 fix: a and b"), "fix: a and b");
});

test("parseCommitSubject returns unknown for missing or subject-less lines", () => {
	assert.equal(parseCommitSubject(undefined), "unknown");
	assert.equal(parseCommitSubject("abc123"), "unknown");
	assert.equal(parseCommitSubject("abc123 "), "unknown");
});

test("parseConfigRegexpValueForKey extracts the named key's value", () => {
	const raw = "user.name John Doe\nremote.origin.url git@github.com:aginies/pi-do-always.git";
	assert.equal(parseConfigRegexpValueForKey(raw, "user.name"), "John Doe");
	assert.equal(parseConfigRegexpValueForKey(raw, "remote.origin.url"), "git@github.com:aginies/pi-do-always.git");
});

test("parseConfigRegexpValueForKey returns undefined for missing keys or empty values", () => {
	assert.equal(parseConfigRegexpValueForKey(undefined, "user.name"), undefined);
	assert.equal(parseConfigRegexpValueForKey("user.email a@b.c", "user.name"), undefined);
	assert.equal(parseConfigRegexpValueForKey("user.name", "user.name"), undefined);
	assert.equal(parseConfigRegexpValueForKey("user.name ", "user.name"), undefined);
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
		staged_files: "a.ts\nb.ts",
		unstaged_files: "c.ts",
		selected_commits: "none",
	};
	for (const t of DEFAULT_TASKS) {
		assert.doesNotMatch(renderPrompt(t.prompt, ctx), /\{\{/, t.name);
	}
});

test("the shipped sample config stays in sync with DEFAULT_TASKS", () => {
	const samplePath = join(dirname(fileURLToPath(import.meta.url)), "..", "do-always.json");
	const { tasks } = parseConfig(readFileSync(samplePath, "utf-8"), "do-always.json");
	const key = (t: DoAlwaysTask) =>
		JSON.stringify([t.name, t.category, t.description, t.prompt, t.requireDirty, t.when, t.autoRun, t.browser, t.hidden, t.notForCommits]);
	assert.deepEqual(
		orderTasksByCategory(tasks).map(key),
		orderTasksByCategory(DEFAULT_TASKS).map(key),
		"extensions/pi-do-always/do-always.json drifted from DEFAULT_TASKS — regenerate it from tasks.ts",
	);
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
		selected_commits: "none",
	};
	for (const t of DEFAULT_TASKS) {
		assert.doesNotMatch(renderPrompt(t.prompt, ctx), /\{\{/, t.name);
	}
});

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------

test("chainClear returns an empty chain", () => {
	assert.deepEqual(chainClear(), { items: [], history: [] });
});

test("chainAdd appends a new task and records it in the history", () => {
	const { state, result } = chainAdd(chainClear(), "build");
	assert.equal(result, "added");
	assert.deepEqual(state, { items: ["build"], history: ["build"] });
});

test("chainAdd moves a re-added task to the end", () => {
	let s = chainClear();
	s = chainAdd(s, "a").state;
	s = chainAdd(s, "b").state;
	const { state, result } = chainAdd(s, "a");
	assert.equal(result, "movedToEnd");
	assert.deepEqual(state.items, ["b", "a"]);
	assert.deepEqual(state.history, ["a", "b", "a"]);
});

test("chainAdd reports full at CHAIN_MAX and leaves the state unchanged", () => {
	let s = chainClear();
	for (let i = 0; i < CHAIN_MAX; i++) s = chainAdd(s, `t${i}`).state;
	const { state, result } = chainAdd(s, "overflow");
	assert.equal(result, "full");
	assert.equal(state, s, "state object is returned unchanged");
	assert.equal(state.items.length, CHAIN_MAX);
});

test("chainRemove removes a task and is a no-op for absent names", () => {
	const s = chainAdd(chainAdd(chainClear(), "a").state, "b").state;
	assert.deepEqual(chainRemove(s, "a").items, ["b"]);
	assert.equal(chainRemove(s, "zzz"), s, "absent name returns the same state");
});

test("chainUndo removes the most recent add still in the chain", () => {
	let s = chainClear();
	s = chainAdd(s, "a").state;
	s = chainAdd(s, "b").state;
	const { state, removed } = chainUndo(s);
	assert.equal(removed, "b");
	assert.deepEqual(state.items, ["a"]);
	assert.deepEqual(state.history, ["a"]);
});

test("chainUndo skips names that were already removed", () => {
	let s = chainClear();
	s = chainAdd(s, "a").state;
	s = chainAdd(s, "b").state;
	s = chainRemove(s, "b");
	const { state, removed } = chainUndo(s);
	assert.equal(removed, "a", 'skips the removed "b" and undoes "a"');
	assert.deepEqual(state.items, []);
});

test("chainUndo returns null when nothing is left to undo", () => {
	const s = chainClear();
	assert.deepEqual(chainUndo(s), { state: s, removed: null });
});

test("formatChainSequence numbers tasks and marks auto-run ones", () => {
	const t1 = { name: "a", prompt: "p" };
	const t2 = { name: "b", prompt: "p" };
	const t3 = { name: "c", prompt: "p", autoRun: true };
	assert.equal(formatChainSequence([t1, t2, t3], { items: ["a", "b"], history: [] }), "1.a → 2.b");
	assert.equal(formatChainSequence([t1, t2, t3], { items: ["c", "a"], history: [] }), "1.⚡c → 2.a");
	assert.equal(formatChainSequence([t1], { items: ["a"], history: [] }), "1.a");
});

test("reportFileName is do-always-report-tasks-YYYY-MM-DD-HHMM.md", () => {
	assert.equal(resolveReportPath("/tmp", new Date("2024-01-01T12:00:00Z")).includes("do-always-report-tasks-"), true);
});

test("reportHeader has the title, project, and step list", () => {
	const header = reportHeader("/tmp/project", ["review", "build"], new Date("2024-01-01T12:00:00Z"));
	assert.equal(header.includes("# do-always chain report"), true);
	assert.equal(header.includes("/tmp/project"), true);
	assert.equal(header.includes("review"), true);
	assert.equal(header.includes("build"), true);
});

test("chainRunLabel is a placeholder for zero, singular for one, counted for two", () => {
	assert.equal(chainRunLabel(0), "run the chain (0)");
	assert.equal(chainRunLabel(1), "Run the task");
	assert.equal(chainRunLabel(2), "Run the chain (2)");
	assert.equal(chainRunLabel(8), "Run the chain (8)");
});

test("buildTableRows emits headers, ordered task rows and the run row last", () => {
	const groups = groupTasksByCategory([
		{ name: "review", category: "Plan", prompt: "p" },
		{ name: "build", category: "Do", prompt: "p" },
	]);
	let chain = chainClear();
	chain = chainAdd(chain, "build").state;
	chain = chainAdd(chain, "review").state;
	const rows = buildTableRows(groups, chain);
	assert.deepEqual(
		rows.map((r) => [r.kind, r.name, r.order]),
		[
			["header", "Plan", undefined],
			["task", undefined, 2],
			["header", "Do", undefined],
			["task", undefined, 1],
			["run", "Run the chain (2)", undefined],
		],
	);
	assert.equal(rows[1].task?.name, "review");
	assert.equal(rows[3].task?.name, "build");
});

test("buildTableRows omits empty groups and shows the empty-chain run label", () => {
	const groups = groupTasksByCategory([{ name: "a", category: "Plan", prompt: "p" }]);
	const rows = buildTableRows(groups, chainClear());
	assert.deepEqual(rows.map((r) => r.kind), ["header", "task", "run"]);
	assert.equal(rows[2].name, "run the chain (0)");
});

test("formatChainSequence numbers tasks and marks auto-run ones", () => {
	const tasks: DoAlwaysTask[] = [
		{ name: "review", category: "Plan", prompt: "p" },
		{ name: "build", prompt: "p" },
	];
	let chain = chainClear();
	chain = chainAdd(chain, "review").state;
	chain = chainAdd(chain, "build").state;
	assert.equal(formatChainSequence(tasks, chain), "1.⚡review → 2.build");
	// Stale names are skipped; numbering follows the chain position.
	const stale = { items: ["ghost", "build"], history: [] };
	assert.equal(formatChainSequence(tasks, stale), "2.build");
});

test("validateChain returns the first failing step with the guard message", () => {
	const tasks: DoAlwaysTask[] = [
		{ name: "ok", prompt: "p" },
		{ name: "dirty", prompt: "p", requireDirty: true },
		{ name: "also-ok", prompt: "p" },
	];
	let chain = chainClear();
	for (const n of ["ok", "dirty", "also-ok"]) chain = chainAdd(chain, n).state;
	const failure = validateChain(tasks, chain, cleanCtx);
	assert.equal(failure?.step, 2);
	assert.equal(failure?.task.name, "dirty");
	assert.match(failure!.message, /clean/);
	assert.equal(validateChain(tasks, chain, dirtyCtx), null, "all guards pass on a dirty tree");
});

test("validateChain skips stale names and passes an empty chain", () => {
	const tasks: DoAlwaysTask[] = [{ name: "ok", prompt: "p" }];
	const stale = { items: ["ghost", "ok"], history: [] };
	assert.equal(validateChain(tasks, stale, cleanCtx), null);
	assert.equal(validateChain(tasks, chainClear(), cleanCtx), null);
});

// ── Chain report ───────────────────────────────────────────────────────

test("reportFileName is do-always-report-tasks-YYYY-MM-DD-HHMM.md", () => {
	const now = new Date(2025, 0, 15, 9, 5); // local 2025-01-15 09:05
	assert.equal(reportFileName(now), "do-always-report-tasks-2025-01-15-0905.md");
	const noon = new Date(2025, 11, 31, 23, 59);
	assert.equal(reportFileName(noon), "do-always-report-tasks-2025-12-31-2359.md");
});

test("resolveReportPath returns the plain path when free, -N when taken", () => {
	const dir = mkdtempSync(join(tmpdir(), "do-always-report-"));
	try {
		const now = new Date(2025, 0, 15, 9, 5);
		const free = resolveReportPath(dir, now);
		assert.equal(free, join(dir, "do-always-report-tasks-2025-01-15-0905.md"));
		// Occupy the base name and the -2 name; the resolver must pick -3.
		writeFileSync(free, "");
		writeFileSync(join(dir, "do-always-report-tasks-2025-01-15-0905-2.md"), "");
		const taken = resolveReportPath(dir, now);
		assert.equal(taken, join(dir, "do-always-report-tasks-2025-01-15-0905-3.md"));
		// A custom existence check is honored (no filesystem needed): every
		// name is taken except -7, so the resolver must land on -7.
		const custom = resolveReportPath(dir, now, (p) => !p.endsWith("-7.md"));
		assert.equal(custom, join(dir, "do-always-report-tasks-2025-01-15-0905-7.md"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reportHeader has the title, project, and step list", () => {
	const now = new Date(2025, 0, 15, 14, 32);
	const header = reportHeader("/home/u/proj", ["Review", "Build"], now);
	assert.match(header, /^# do-always chain report — 2025-01-15 14:32$/m);
	assert.match(header, /- Project: \/home\/u\/proj/);
	assert.match(header, /- Steps: Review → Build/);
	assert.ok(header.endsWith("\n"));
});

test("reportStepSection shows index, name, status, times, and result", () => {
	const start = new Date(2025, 0, 15, 14, 32);
	const end = new Date(2025, 0, 15, 14, 35);
	const section = reportStepSection(0, "Review", "completed", start, end, "3 issues found\n");
	assert.match(section, /^## 1\. Review — completed \(14:32 → 14:35\)$/m);
	assert.match(section, /3 issues found/);
	// failed-to-start: no start time, single time shown
	const failed = reportStepSection(1, "Build", "failed-to-start", null, end, "");
	assert.match(failed, /^## 2\. Build — failed-to-start \(14:35\)$/m);
	assert.match(failed, /_\(no result text\)_/);
});

test("reportFooter summarizes completion and early stop", () => {
	const now = new Date(2025, 0, 15, 14, 38);
	const done = reportFooter(["completed", "completed", "completed"], now);
	assert.match(done, /\*\*Chain finished:\*\* 2025-01-15 14:38 — 3\/3 completed/);
	assert.ok(!done.includes("stopped early"));
	const stopped = reportFooter(["completed", "aborted", "pending"], now);
	assert.match(stopped, /1\/3 completed — chain stopped early/);
});

test("reportAbandonedFooter marks a chain that never finished", () => {
	const now = new Date(2025, 0, 15, 14, 38);
	const footer = reportAbandonedFooter(["completed", "running", "pending"], now);
	assert.match(footer, /\*\*Chain abandoned:\*\* 2025-01-15 14:38 — 1\/3 completed/);
	assert.ok(!footer.includes("finished"));
});

test("reportWorthKeeping keeps reports with progress or result text", () => {
	// A completed step keeps the file even without result text.
	assert.equal(reportWorthKeeping(["completed", "pending"], false), true);
	// Result text keeps the file even when no step completed.
	assert.equal(reportWorthKeeping(["error", "pending"], true), true);
	// Neither → the (mostly) empty file is removed.
	assert.equal(reportWorthKeeping(["error", "pending"], false), false);
	assert.equal(reportWorthKeeping(["failed-to-start"], false), false);
	assert.equal(reportWorthKeeping(["aborted"], false), false);
	// Skipped steps count as no progress, but result text still counts.
	assert.equal(reportWorthKeeping(["skipped", "pending"], false), false);
	assert.equal(reportWorthKeeping(["skipped", "pending"], true), true);
});

test("assistantText handles string content, text parts, and mixed parts", () => {
	assert.equal(assistantText("plain"), "plain");
	assert.equal(
		assistantText([
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
		]),
		"a\nb",
	);
	// Non-text parts (tool calls) are skipped.
	assert.equal(
		assistantText([
			{ type: "toolCall" },
			{ type: "text", text: "result" },
			{ type: "thinking", text: "hidden" },
		]),
		"result",
	);
	assert.equal(assistantText([]), "");
	assert.equal(assistantText(null), "");
	assert.equal(assistantText(undefined), "");
});

test("parseConfig reads the report flag (default on, explicit off honored)", () => {
	const on = parseConfig(JSON.stringify({ tasks: [], report: true }), "t.json");
	assert.equal(on.report, true);
	const off = parseConfig(JSON.stringify({ tasks: [], report: false }), "t.json");
	assert.equal(off.report, false);
	const absent = parseConfig(JSON.stringify({ tasks: [] }), "t.json");
	assert.equal(absent.report, undefined);
	let warned = "";
	const invalid = parseConfig(JSON.stringify({ tasks: [], report: "yes" }), "t.json", (m) => (warned = m));
	assert.equal(invalid.report, undefined);
	assert.match(warned, /report/);
});

test("parseConfig reads per-task aliases as an array of strings", () => {
	const out = parseConfig(
		JSON.stringify([{ name: "x", prompt: "p", aliases: ["r", "x-alias"] }]),
		"t.json",
	);
	assert.equal(out.tasks.length, 1);
	assert.deepEqual(out.tasks[0].aliases, ["r", "x-alias"]);
});

test("parseConfig drops empty alias strings", () => {
	const out = parseConfig(
		JSON.stringify([{ name: "x", prompt: "p", aliases: ["r", "", " bl "] }]),
		"t.json",
	);
	assert.deepEqual(out.tasks[0].aliases, ["r", " bl "]);
});

test("parseConfig ignores invalid aliases (not an array)", () => {
	let warned = "";
	const out = parseConfig(
		JSON.stringify([{ name: "x", prompt: "p", aliases: "not-array" }]),
		"t.json",
		(m) => (warned = m),
	);
	assert.equal(out.tasks[0].aliases, undefined);
	assert.match(warned, /aliases/);
});

test("parseConfig ignores aliases containing non-strings", () => {
	let warned = "";
	const out = parseConfig(
		JSON.stringify([{ name: "x", prompt: "p", aliases: ["r", 42] }]),
		"t.json",
		(m) => (warned = m),
	);
	assert.equal(out.tasks[0].aliases, undefined);
	assert.match(warned, /aliases/);
});

test("parseConfig reads the global alias map", () => {
	const out = parseConfig(
		JSON.stringify({ tasks: [], aliases: { r: "review", b: "build" } }),
		"t.json",
	);
	assert.deepEqual(out.aliases, { r: "review", b: "build" });
});

test("parseConfig trims alias keys and values", () => {
	const out = parseConfig(
		JSON.stringify({ tasks: [], aliases: { " r ": " review " } }),
		"t.json",
	);
	assert.deepEqual(out.aliases, { r: "review" });
});

test("parseConfig drops invalid alias entries (empty key or non-string value)", () => {
	const out = parseConfig(
		JSON.stringify({ tasks: [], aliases: { "": "x", "r": 123, "b": "build" } }),
		"t.json",
	);
	assert.deepEqual(out.aliases, { b: "build" });
});

test("parseConfig returns undefined aliases when absent", () => {
	const out = parseConfig(JSON.stringify({ tasks: [] }), "t.json");
	assert.equal(out.aliases, undefined);
});

test("parseConfig returns undefined aliases for a bare array (no object key)", () => {
	const out = parseConfig(JSON.stringify([{ name: "x", prompt: "p" }]), "t.json");
	assert.equal(out.aliases, undefined);
});

// ── Chain step summary ───────────────────────────────────────────────────

test("formatDuration formats milliseconds", () => {
	assert.equal(formatDuration(500), "500ms");
	assert.equal(formatDuration(1000), "1s");
	assert.equal(formatDuration(3500), "3s");
	assert.equal(formatDuration(60000), "1m");
	assert.equal(formatDuration(125000), "2m5s");
	assert.equal(formatDuration(3661000), "61m1s");
});

test("stepSummary formats completed step with files and duration", () => {
	assert.equal(
		stepSummary("completed", "Build", 134000, 3),
		"✓ Build — 3 files changed — 2m14s",
	);
});

test("stepSummary formats completed step with no files", () => {
	assert.equal(
		stepSummary("completed", "Review code", 45000, 0),
		"✓ Review code — 45s",
	);
});

test("stepSummary formats completed step without duration", () => {
	assert.equal(
		stepSummary("completed", "Readme", 0, 1),
		"✓ Readme — 1 file changed",
	);
});

test("stepSummary formats completed step without files or duration", () => {
	assert.equal(stepSummary("completed", "Commit", 0, 0), "✓ Commit");
});

test("stepSummary formats error step", () => {
	assert.equal(
		stepSummary("error", "Tests", 45000, 0),
		"✗ Tests — 45s",
	);
});

test("stepSummary formats aborted step", () => {
	assert.equal(stepSummary("aborted", "Review changes", 0, 0), "⊘ Review changes");
});

test("stepSummary formats failed-to-start step", () => {
	assert.equal(
		stepSummary("failed-to-start", "Deploy", 0, 0),
		"✗ Deploy",
	);
});

test("chainSummary shows all-done with time", () => {
	assert.equal(chainSummary(4, 4, 402000), "✅ 4/4 steps completed in 6m42s");
});

test("chainSummary shows all-done without time", () => {
	assert.equal(chainSummary(3, 3, 0), "✅ 3/3 steps completed");
});

// ── Commit browser constants & types ─────────────────────────────────────

test("COMMIT_BROWSER_MAX is 20", () => {
	assert.equal(COMMIT_BROWSER_MAX, 20);
});

test("COMMIT_SELECT_MAX is 20", () => {
	assert.equal(COMMIT_SELECT_MAX, 20);
});

// ---------------------------------------------------------------------------
// formatSelectedCommits (commit detail block)
// ---------------------------------------------------------------------------

test("formatSelectedCommits formats a single commit without numbering", () => {
	const c: SelectedCommit = {
		hash: "a1b2c3d4".padEnd(40, "a"),
		shortHash: "a1b2c3d",
		subject: "fix: handle null user",
		date: "2026-10-01",
		author: "Agine",
		filesChanged: 2,
		insertions: 10,
		deletions: 3,
		selectionOrder: 1,
	};
	assert.equal(
		formatSelectedCommits([c]),
		`Commit a1b2c3d (${c.hash})\n   Subject: fix: handle null user\n   Author:  Agine on 2026-10-01\n   Stats:   2 files changed, +10/-3 lines`,
	);
});

test("formatSelectedCommits numbers multiple commits", () => {
	const mk = (i: number): SelectedCommit => ({
		hash: `${i}${"0".repeat(39)}`,
		shortHash: `${i}000000`,
		subject: `commit ${i}`,
		date: "2026-10-01",
		author: "Agine",
		filesChanged: 1,
		insertions: 1,
		deletions: 0,
		selectionOrder: i,
	});
	const out = formatSelectedCommits([mk(1), mk(2)]);
	assert.ok(out.startsWith("1. Commit 1000000"));
	assert.ok(out.includes("2. Commit 2000000"));
});

test("formatCommitReviewPrompt embeds the formatSelectedCommits block", () => {
	const c: SelectedCommit = {
		hash: "a".repeat(40),
		shortHash: "aaaaaaa",
		subject: "s",
		date: "2026-10-01",
		author: "A",
		filesChanged: 1,
		insertions: 1,
		deletions: 1,
		selectionOrder: 1,
	};
	assert.ok(formatCommitReviewPrompt([c]).includes(formatSelectedCommits([c])));
});

// Verify the 'Review commits' task exists in DEFAULT_TASKS and auto-runs (Plan category).
const reviewTask = DEFAULT_TASKS.find((t) => t.name === "Review commits");
test("'Review commits' task exists in DEFAULT_TASKS", () => {
	assert.ok(reviewTask, "'Review commits' should be in DEFAULT_TASKS");
});
test("'Review commits' auto-runs (Plan category)", () => {
	assert.ok(reviewTask?.category === "Plan", "'Review commits' is in Plan category");
	assert.ok(shouldAutoRun(reviewTask!), "'Review commits' should auto-run via Plan category");
});

test("'Review commits' declares browser: commits", () => {
	assert.equal(reviewTask?.browser, "commits");
});

test("'Review commits' is hidden from the selector (commit-picker option only)", () => {
	assert.equal(reviewTask?.hidden, true);
	// Still a Plan task whose `when` passes, so the commit picker offers it.
	assert.equal(reviewTask?.category, "Plan");
	assert.equal(evaluateWhen(reviewTask, dirtyCtx), true);
});

test("commit picker candidates: notForCommits Plan tasks excluded, the rest kept", () => {
	const byName = (n: string) => DEFAULT_TASKS.find((t) => t.name === n);
	for (const n of ["Review changes", "Review code", "Propose features"]) {
		assert.equal(byName(n)?.notForCommits, true, `${n} should be notForCommits`);
	}
	for (const n of ["Cleanup", "Security", "Performance", "Review commits"]) {
		assert.ok(!byName(n)?.notForCommits, `${n} should stay a picker candidate`);
	}
});

test("DEFAULT_TASKS includes Browse commits (Browse category, commits browser, git only)", () => {
	const browse = DEFAULT_TASKS.find((t) => t.name === "Browse commits");
	assert.ok(browse, "'Browse commits' should be in DEFAULT_TASKS");
	assert.equal(browse?.category, "Browse");
	assert.equal(browse?.browser, "commits");
	assert.equal(browse?.when, "git");
});

test("Browse commits is only shown inside a git repo (when: git)", () => {
	const browse = DEFAULT_TASKS.find((t) => t.name === "Browse commits");
	assert.ok(browse);
	assert.equal(evaluateWhen(browse, nonGitCtx), false);
	assert.equal(evaluateWhen(browse, dirtyCtx), true);
});

test("DEFAULT_TASKS 'Review commits' prompt consumes {{selected_commits}}", () => {
	assert.match(reviewTask?.prompt ?? "", /\{\{\s*selected_commits\s*\}\}/);
});

test("formatCommitReviewPrompt formats single commit prompt", () => {
	const commits: SelectedCommit[] = [
		{
			hash: "a".repeat(40),
			shortHash: "abc1234",
			subject: "feat: new feature",
			date: "2025-01-15",
			author: "Alice",
			filesChanged: 3,
			insertions: 50,
			deletions: 2,
			selectionOrder: 1,
		},
	];
	const prompt = formatCommitReviewPrompt(commits);
	assert.ok(prompt.includes("Review the following git commit:"));
	assert.ok(prompt.includes("Commit abc1234 (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)"));
	assert.ok(prompt.includes("feat: new feature"));
	assert.ok(prompt.includes("git show aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
});

test("formatCommitReviewPrompt formats multiple commits prompt", () => {
	const commits: SelectedCommit[] = [
		{
			hash: "a".repeat(40),
			shortHash: "abc1234",
			subject: "feat: first",
			date: "2025-01-15",
			author: "Alice",
			filesChanged: 1,
			insertions: 10,
			deletions: 0,
			selectionOrder: 1,
		},
		{
			hash: "b".repeat(40),
			shortHash: "def5678",
			subject: "fix: second",
			date: "2025-01-14",
			author: "Bob",
			filesChanged: 2,
			insertions: 5,
			deletions: 3,
			selectionOrder: 2,
		},
	];
	const prompt = formatCommitReviewPrompt(commits);
	assert.ok(prompt.includes("Review the following git commits:"));
	assert.ok(prompt.includes("1. Commit abc1234"));
	assert.ok(prompt.includes("2. Commit def5678"));
	assert.ok(prompt.includes("git show <hash>"));
});

// Verify parseGitLogOutput
test("parseGitLogOutput handles empty output", () => {
	assert.deepEqual(parseGitLogOutput(""), []);
	assert.deepEqual(parseGitLogOutput("   \n\n  "), []);
});

test("parseGitLogOutput parses commits with and without stats", () => {
	const logSample = [
		`COMMIT\t${"a".repeat(40)}\tabc1234\tfeat: first commit\t2025-01-15\tAlice`,
		"",
		" 3 files changed, 50 insertions(+), 2 deletions(-)",
		`COMMIT\t${"b".repeat(40)}\tdef5678\tfix: second commit\t2025-01-15\tBob`,
		"",
		" 1 file changed, 10 insertions(+)",
		`COMMIT\t${"c".repeat(40)}\tghi9012\tdocs: third commit\t2025-01-14\tCarol`,
		"",
		" 2 files changed, 5 deletions(-)",
		`COMMIT\t${"d".repeat(40)}\tjkl3456\tempty commit\t2025-01-14\tDave`,
	].join("\n");

	const parsed = parseGitLogOutput(logSample);
	assert.equal(parsed.length, 4);

	assert.equal(parsed[0].hash, "a".repeat(40));
	assert.equal(parsed[0].shortHash, "abc1234");
	assert.equal(parsed[0].subject, "feat: first commit");
	assert.equal(parsed[0].date, "2025-01-15");
	assert.equal(parsed[0].author, "Alice");
	assert.equal(parsed[0].filesChanged, 3);
	assert.equal(parsed[0].insertions, 50);
	assert.equal(parsed[0].deletions, 2);

	assert.equal(parsed[1].hash, "b".repeat(40));
	assert.equal(parsed[1].filesChanged, 1);
	assert.equal(parsed[1].insertions, 10);
	assert.equal(parsed[1].deletions, 0);

	assert.equal(parsed[2].hash, "c".repeat(40));
	assert.equal(parsed[2].filesChanged, 2);
	assert.equal(parsed[2].insertions, 0);
	assert.equal(parsed[2].deletions, 5);

	assert.equal(parsed[3].hash, "d".repeat(40));
	assert.equal(parsed[3].filesChanged, 0);
	assert.equal(parsed[3].insertions, 0);
	assert.equal(parsed[3].deletions, 0);
});

test("parseGitLogOutput handles subjects with tabs", () => {
	const logSample = `COMMIT\t${"e".repeat(40)}\txyz9999\tsubject\twith\ttabs\t2025-01-13\tEve\n\n 1 file changed, 1 insertion(+)`;
	const parsed = parseGitLogOutput(logSample);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].subject, "subject\twith\ttabs");
	assert.equal(parsed[0].date, "2025-01-13");
	assert.equal(parsed[0].author, "Eve");
});

// Verify groupCommitsByDate
test("groupCommitsByDate groups commits sharing the same date", () => {
	const commits: CommitInfo[] = [
		{ hash: "1".repeat(40), shortHash: "1111111", subject: "c1", date: "2025-01-15", author: "A", filesChanged: 1, insertions: 1, deletions: 0 },
		{ hash: "2".repeat(40), shortHash: "2222222", subject: "c2", date: "2025-01-15", author: "B", filesChanged: 2, insertions: 2, deletions: 1 },
		{ hash: "3".repeat(40), shortHash: "3333333", subject: "c3", date: "2025-01-14", author: "C", filesChanged: 0, insertions: 0, deletions: 0 },
	];
	const groups = groupCommitsByDate(commits);
	assert.equal(groups.length, 2);
	assert.equal(groups[0].date, "2025-01-15");
	assert.equal(groups[0].count, 2);
	assert.equal(groups[0].commits.length, 2);
	assert.equal(groups[1].date, "2025-01-14");
	assert.equal(groups[1].count, 1);
	assert.equal(groups[1].commits.length, 1);
});

// Verify DateGroup shape via a manual construction.
const sampleGroup: DateGroup = {
	date: "2025-01-15",
	count: 2,
	commits: [
		{ hash: "a".repeat(40), shortHash: "abc1234", subject: "feat: add x", date: "2025-01-15", author: "A", filesChanged: 3, insertions: 50, deletions: 2 },
		{ hash: "b".repeat(40), shortHash: "def5678", subject: "fix: y", date: "2025-01-15", author: "B", filesChanged: 1, insertions: 10, deletions: 5 },
	],
};
test("DateGroup has correct shape", () => {
	assert.equal(sampleGroup.date, "2025-01-15");
	assert.equal(sampleGroup.count, 2);
	assert.equal(sampleGroup.commits.length, 2);
});

// Verify SelectedCommit shape.
const sampleSelected: SelectedCommit = {
	hash: "c".repeat(40),
	shortHash: "ghi9012",
	subject: "chore: z",
	date: "2025-01-14",
	author: "C",
	filesChanged: 0,
	insertions: 0,
	deletions: 0,
	selectionOrder: 1,
};
test("SelectedCommit has correct shape", () => {
	assert.equal(sampleSelected.selectionOrder, 1);
	assert.equal(sampleSelected.hash.length, 40);
});

// ── Plan proposal ──────────────────────────────────────────────────────────

/** A reply with a well-formed plan block (the happy path fixture). */
const planReply =
	"Here is my review of the changes.\n\n" +
	"```plan\n" +
	'{"summary":"2 critical bugs, 3 cleanups","tiers":[' +
	'{"id":"P0","label":"Critical","items":[' +
	'{"title":"Fix null deref in parse()","detail":"src/foo.ts:42 — throws on empty input"},' +
	'{"title":"Validate input length"}' +
	"]}," +
	'{"id":"P1","label":"Important","items":[' +
	'{"title":"Remove unused imports","detail":"src/bar.ts:7"}' +
	"]}" +
	"]}\n" +
	"```\n";

test("parsePlanProposal parses a well-formed plan block", () => {
	const p = parsePlanProposal(planReply);
	assert.ok(p);
	assert.equal(p.summary, "2 critical bugs, 3 cleanups");
	assert.equal(p.tiers.length, 2);
	assert.equal(p.tiers[0].id, "P0");
	assert.equal(p.tiers[0].label, "Critical");
	assert.equal(p.tiers[0].items.length, 2);
	assert.equal(p.tiers[0].items[0].title, "Fix null deref in parse()");
	assert.equal(p.tiers[0].items[0].detail, "src/foo.ts:42 — throws on empty input");
	assert.equal(p.tiers[0].items[1].detail, undefined);
	assert.equal(p.tiers[1].id, "P1");
	assert.equal(p.tiers[1].label, "Important");
});

test("parsePlanProposal returns null when there is no plan block", () => {
	assert.equal(parsePlanProposal("Just a summary, no block."), null);
	assert.equal(parsePlanProposal("```json\n{}\n```"), null);
	assert.equal(parsePlanProposal(""), null);
});

test("parsePlanProposal returns null for malformed JSON", () => {
	assert.equal(parsePlanProposal("```plan\n{not json}\n```"), null);
	assert.equal(parsePlanProposal("```plan\n[1,2,3]\n```"), null);
});

test("parsePlanProposal takes the last valid block when several exist", () => {
	const text =
		"```plan\n{\"tiers\":[{\"items\":[{\"title\":\"first\"}]}]}\n```\n" +
		"correction:\n" +
		"```plan\n{\"tiers\":[{\"id\":\"P9\",\"items\":[{\"title\":\"second\"}]}]}\n```\n";
	const p = parsePlanProposal(text);
	assert.ok(p);
	assert.equal(p.tiers.length, 1);
	assert.equal(p.tiers[0].items[0].title, "second");
});

test("parsePlanProposal falls back to an earlier valid block when the last is malformed", () => {
	const text =
		"```plan\n{\"tiers\":[{\"items\":[{\"title\":\"good\"}]}]}\n```\n" +
		"```plan\n{broken\n```\n";
	const p = parsePlanProposal(text);
	assert.ok(p);
	assert.equal(p.tiers[0].items[0].title, "good");
});

test("parsePlanProposal accepts the flat items shape with a tier field", () => {
	const text =
		'```plan\n{"items":[{"tier":"P1","title":"b"},{"tier":"P0","title":"a"},{"title":"c"}]}\n```\n';
	const p = parsePlanProposal(text);
	assert.ok(p);
	assert.equal(p.tiers.length, 2);
	// First-seen order of the tier field; items without a tier join "P0".
	assert.equal(p.tiers[0].id, "P1");
	assert.equal(p.tiers[0].items[0].title, "b");
	assert.equal(p.tiers[1].id, "P0");
	assert.equal(p.tiers[1].items.length, 2);
	assert.equal(p.tiers[1].items[0].title, "a");
	assert.equal(p.tiers[1].items[1].title, "c");
});

test("parsePlanProposal defaults missing ids and labels by position", () => {
	const text = "```plan\n{\"tiers\":[{\"items\":[{\"title\":\"x\"}]},{\"items\":[{\"title\":\"y\"}]}]}\n```\n";
	const p = parsePlanProposal(text);
	assert.ok(p);
	assert.equal(p.tiers[0].id, "P0");
	assert.equal(p.tiers[0].label, "P0");
	assert.equal(p.tiers[1].id, "P1");
	assert.equal(p.tiers[1].label, "P1");
});

test("parsePlanProposal drops invalid entries and returns null when nothing survives", () => {
	assert.equal(parsePlanProposal("```plan\n{\"tiers\":[{\"items\":[42, \"\", {\"title\":\"\"}]}]}\n```\n"), null);
	assert.equal(parsePlanProposal("```plan\n{\"tiers\":[]}\n```\n"), null);
	assert.equal(parsePlanProposal("```plan\n{}\n```\n"), null);
	const p = parsePlanProposal(
		"```plan\n{\"tiers\":[{\"items\":[{\"title\":\"keep\"}, null, {\"detail\":\"no title\"}]},{\"items\":[]}]}\n```\n",
	);
	assert.ok(p);
	assert.equal(p.tiers.length, 1);
	assert.equal(p.tiers[0].items.length, 1);
});

test("parsePlanProposal trims the summary and drops it when blank", () => {
	const p = parsePlanProposal(
		"```plan\n{\"summary\":\"  padded  \",\"tiers\":[{\"items\":[{\"title\":\"x\"}]}]}\n```\n",
	);
	assert.ok(p);
	assert.equal(p.summary, "padded");
	const p2 = parsePlanProposal("```plan\n{\"summary\":\"   \",\"tiers\":[{\"items\":[{\"title\":\"x\"}]}]}\n```\n");
	assert.ok(p2);
	assert.equal(p2.summary, undefined);
});

test("parsePlanProposal accepts string items and a plan fence with trailing spaces", () => {
	const p = parsePlanProposal("```plan   \n{\"tiers\":[{\"items\":[\"just a title\"]}]}\n```\n");
	assert.ok(p);
	assert.equal(p.tiers[0].items[0].title, "just a title");
});

// ── Plan block stripping ───────────────────────────────────────────────────

test("stripPlanBlocks removes a trailing plan block", () => {
	const { text, removed } = stripPlanBlocks(planReply);
	assert.equal(removed, true);
	assert.equal(text, "Here is my review of the changes.");
});

test("stripPlanBlocks leaves text without a plan fence unchanged", () => {
	assert.deepEqual(stripPlanBlocks("Just prose."), { text: "Just prose.", removed: false });
	assert.deepEqual(stripPlanBlocks("```json\n{}\n```"), { text: "```json\n{}\n```", removed: false });
	assert.deepEqual(stripPlanBlocks(""), { text: "", removed: false });
});

test("stripPlanBlocks removes every plan block and keeps the prose", () => {
	const input =
		"first\n\n" +
		"```plan\n{\"tiers\":[{\"items\":[{\"title\":\"old\"}]}]}\n```\n" +
		"middle\n" +
		"```plan\n{\"tiers\":[{\"items\":[{\"title\":\"new\"}]}]}\n```\n" +
		"last";
	const { text, removed } = stripPlanBlocks(input);
	assert.equal(removed, true);
	assert.equal(text, "first\n\nmiddle\n\nlast");
});

test("stripPlanBlocks handles a block at the start of the text", () => {
	const { text, removed } = stripPlanBlocks(
		"```plan\n{\"tiers\":[{\"items\":[{\"title\":\"x\"}]}]}\n```\n\nafter",
	);
	assert.equal(removed, true);
	assert.equal(text, "after");
});

test("stripPlanBlocks yields empty text when the block is the whole reply", () => {
	const { text, removed } = stripPlanBlocks("```plan\n{}\n```\n");
	assert.equal(removed, true);
	assert.equal(text, "");
});

test("stripPlanBlocks removes an unclosed plan fence with JSON at the end", () => {
	const input = "Review done.\n\n```plan\n{\"tiers\":[{\"items\":[{\"title\":\"x\"}]}]}\n";
	const { text, removed } = stripPlanBlocks(input);
	assert.equal(removed, true);
	assert.equal(text, "Review done.");
});

test("stripPlanBlocks removes an unclosed fence with split JSON objects and leaked tags", () => {
	// The failure mode reported in the wild: two JSON objects (summary, then
	// empty tiers), leaked tool-call XML, and a truncated closing tag — the
	// fence is never closed, but the region carries parseable JSON.
	const input =
		"Here are five feature ideas.\n\n" +
		"```plan\n" +
		'  {"summary":"Propose 5 low-risk feature upgrades"}\n' +
		'  {"tiers":[]}\n' +
		"  </parameter>\n" +
		"  </invoke>\n" +
		"  </function>\n" +
		"   _";
	const { text, removed } = stripPlanBlocks(input);
	assert.equal(removed, true);
	assert.equal(text, "Here are five feature ideas.");
});

test("stripPlanBlocks leaves an unclosed plan fence without JSON alone", () => {
	// A prose mention of a plan fence (or a truncated prose-only block) must
	// not delete the rest of the reply: the strip guard requires a parseable
	// JSON object in the unclosed region.
	const input = "Review done.\n\n```plan\nI would fix the auth module first, then the tests.";
	assert.deepEqual(stripPlanBlocks(input), { text: input, removed: false });
	const mention = 'The reply must end with a ```plan block.\nKeep this paragraph.';
	assert.deepEqual(stripPlanBlocks(mention), { text: mention, removed: false });
});

test("stripPlanBlocks strips the block but the parser still reads the raw capture", () => {
	// The message_end flow: the questionnaire parses the raw capture, the
	// transcript shows the stripped text (which carries no plan block).
	const proposal = parsePlanProposal(planReply);
	assert.ok(proposal);
	assert.equal(proposal.summary, "2 critical bugs, 3 cleanups");
	const { text } = stripPlanBlocks(planReply);
	assert.equal(parsePlanProposal(text), null);
});

// ── Plan questionnaire selection ───────────────────────────────────────────

const selProposal: PlanProposal = {
	summary: "s",
	tiers: [
		{ id: "P0", label: "Critical", items: [{ title: "a" }, { title: "b" }] },
		{ id: "P1", label: "Important", items: [{ title: "c" }, { title: "d" }, { title: "e" }] },
	],
};

test("planSelectionClear returns an empty set", () => {
	assert.equal(planSelectionClear().size, 0);
});

test("planItemKey encodes tier and item positions", () => {
	assert.equal(planItemKey(0, 0), "0:0");
	assert.equal(planItemKey(1, 2), "1:2");
});

test("planToggleItem adds then removes", () => {
	let sel = planSelectionClear();
	sel = planToggleItem(sel, "0:0");
	assert.equal(sel.size, 1);
	sel = planToggleItem(sel, "0:0");
	assert.equal(sel.size, 0);
	// The input set is never mutated.
	const base = planSelectionClear();
	planToggleItem(base, "0:0");
	assert.equal(base.size, 0);
});

test("planToggleTier selects all when not fully selected", () => {
	let sel = planSelectionClear();
	// Partial: one item of tier 1 already selected.
	sel = planToggleItem(sel, planItemKey(1, 0));
	const { selection, selected } = planToggleTier(selProposal, 1, sel);
	assert.equal(selected, true);
	assert.equal(selection.size, 3); // all of tier 1
	assert.equal(planTierState(selProposal, 1, selection), "all");
});

test("planToggleTier clears a fully selected tier", () => {
	const sel = planSelectAll(selProposal, planSelectionClear());
	const { selection, selected } = planToggleTier(selProposal, 0, sel);
	assert.equal(selected, false);
	assert.equal(selection.size, 3); // only tier 1 remains
	assert.equal(planTierState(selProposal, 0, selection), "none");
});

test("planToggleTier leaves other tiers untouched and ignores unknown tiers", () => {
	const sel = planToggleItem(planSelectionClear(), planItemKey(0, 0));
	const { selection } = planToggleTier(selProposal, 1, sel);
	assert.equal(selection.has(planItemKey(0, 0)), true);
	const unknown = planToggleTier(selProposal, 9, selection);
	assert.equal(unknown.selection, selection);
	assert.equal(unknown.selected, false);
});

test("planSelectAll selects every item", () => {
	const sel = planSelectAll(selProposal, planSelectionClear());
	assert.equal(sel.size, 5);
	assert.equal(planTierState(selProposal, 0, sel), "all");
	assert.equal(planTierState(selProposal, 1, sel), "all");
});

test("planTierState reports none, partial, and all", () => {
	const empty = planSelectionClear();
	assert.equal(planTierState(selProposal, 0, empty), "none");
	const partial = planToggleItem(empty, planItemKey(0, 0));
	assert.equal(planTierState(selProposal, 0, partial), "partial");
	const full = planSelectAll(selProposal, empty);
	assert.equal(planTierState(selProposal, 0, full), "all");
	assert.equal(planTierState(selProposal, 5, full), "none"); // unknown tier
});

test("planSelectedItems returns selected items in tier then item order", () => {
	const sel = planSelectionClear();
	// Select out of order: tier 1 item 0, then tier 0 item 1.
	let s = planToggleItem(sel, planItemKey(1, 0));
	s = planToggleItem(s, planItemKey(0, 1));
	const items = planSelectedItems(selProposal, s);
	assert.equal(items.length, 2);
	assert.equal(items[0].item.title, "b"); // tier 0 first
	assert.equal(items[0].tier.id, "P0");
	assert.equal(items[1].item.title, "c");
	assert.equal(items[1].tier.id, "P1");
	assert.equal(planSelectedItems(selProposal, sel).length, 0);
});

// ── Plan execution prompt ──────────────────────────────────────────────────

test("formatPlanExecutionPrompt lists the selected items in order with tier tags", () => {
	const sel = planSelectAll(selProposal, planSelectionClear());
	const prompt = formatPlanExecutionPrompt(planSelectedItems(selProposal, sel), "Review changes");
	// No "above": the plan block is stripped from the transcript, so the
	// prompt must not point the model at a proposal that isn't there.
	assert.ok(prompt.includes('"Review changes" plan proposal, in exactly this order'));
	assert.ok(!prompt.includes("above"));
	assert.ok(prompt.includes("1. [P0] a"));
	assert.ok(prompt.includes("2. [P0] b"));
	assert.ok(prompt.includes("3. [P1] c"));
	assert.ok(prompt.includes("4. [P1] d"));
	assert.ok(prompt.includes("5. [P1] e"));
});

test("formatPlanExecutionPrompt appends the detail when present", () => {
	const entry = [{ tier: selProposal.tiers[0], item: { title: "Fix bug", detail: "src/foo.ts:42" } }];
	const prompt = formatPlanExecutionPrompt(entry, "Security");
	assert.ok(prompt.includes("1. [P0] Fix bug — src/foo.ts:42"));
});

test("formatPlanExecutionPrompt excludes unselected items", () => {
	const sel = planToggleItem(planSelectionClear(), planItemKey(1, 2));
	const prompt = formatPlanExecutionPrompt(planSelectedItems(selProposal, sel), "Cleanup");
	assert.ok(prompt.includes("1. [P1] e"));
	assert.ok(!prompt.includes("[P0] a"));
	assert.ok(!prompt.includes("[P1] d"));
});

// ── Plan block diagnostics ─────────────────────────────────────────────────

test("planBlockDiagnostics reports none when there is no plan fence", () => {
	assert.deepEqual(planBlockDiagnostics("no block here"), { kind: "none" });
	assert.deepEqual(planBlockDiagnostics(""), { kind: "none" });
});

test("planBlockDiagnostics reports malformed JSON with the parse error", () => {
	const diag = planBlockDiagnostics("text\n```plan\n{not json}\n```\n");
	assert.equal(diag.kind, "malformed");
	if (diag.kind === "malformed") assert.ok(diag.detail.length > 0);
});

test("planBlockDiagnostics strips position info from JSON.parse errors", () => {
	// JSON.parse in Node.js reports "at position N (line L column C)" —
	// this is meaningless in a large plan block, so it is stripped.
	const diag = planBlockDiagnostics(
		'```plan\n{"tiers":[{"items":[{"title":"a"},{"title":"b"} "missing comma"]}]}\n```',
	);
	assert.equal(diag.kind, "malformed");
	if (diag.kind === "malformed") {
		assert.ok(!diag.detail.includes("at position"));
		assert.ok(!diag.detail.includes("column"));
		assert.ok(diag.detail.length > 0);
	}
});

test("planBlockDiagnostics reports empty when the JSON parses but has no items", () => {
	assert.deepEqual(planBlockDiagnostics("```plan\n{}\n```"), { kind: "empty" });
	assert.deepEqual(planBlockDiagnostics('```plan\n{"tiers":[]}\n```'), { kind: "empty" });
	assert.deepEqual(planBlockDiagnostics('```plan\n{"tiers":[{"id":"P0","items":[]}]}\n```'), { kind: "empty" });
	assert.deepEqual(planBlockDiagnostics('```plan\n[1,2]\n```'), { kind: "empty" });
});

test("planBlockDiagnostics reports ok with the item count", () => {
	const diag = planBlockDiagnostics(
		'```plan\n{"tiers":[{"id":"P0","items":[{"title":"a"},{"title":"b"}]},{"id":"P1","items":[{"title":"c"}]}]}\n```',
	);
	assert.deepEqual(diag, { kind: "ok", itemCount: 3 });
});

test("planBlockDiagnostics tries blocks from last to first, like the parser", () => {
	// Last block malformed, earlier one valid → ok: the parser takes the
	// earlier block, so the diagnostics must agree.
	const mixed =
		'```plan\n{"tiers":[{"items":[{"title":"old"}]}]}\n```\n' +
		"```plan\n{broken}\n```";
	assert.deepEqual(planBlockDiagnostics(mixed), { kind: "ok", itemCount: 1 });
	// Last block valid, earlier one malformed → ok (the last block wins).
	const fixed =
		"```plan\n{broken}\n```\n" +
		'```plan\n{"tiers":[{"items":[{"title":"new"}]}]}\n```';
	assert.deepEqual(planBlockDiagnostics(fixed), { kind: "ok", itemCount: 1 });
	// Only malformed blocks → malformed, reporting the LAST block's error.
	const allBad = "```plan\n{broken1}\n```\n```plan\n{broken2}\n```";
	const diag = planBlockDiagnostics(allBad);
	assert.equal(diag.kind, "malformed");
	if (diag.kind === "malformed") {
		assert.ok(diag.detail.length > 0);
		assert.ok(!diag.detail.includes("broken1")); // the first block's error is not the one reported
	}
});

test("planBlockDiagnostics agrees with parsePlanProposal", () => {
	const samples: Array<[string, boolean]> = [
		["no block", false],
		["```plan\n{bad}\n```", false],
		["```plan\n{}\n```", false],
		['```plan\n{"tiers":[{"id":"P0","items":[{"title":"a"}]}]}\n```', true],
	];
	for (const [text, expectOk] of samples) {
		const diag = planBlockDiagnostics(text);
		assert.equal(diag.kind === "ok", expectOk, text);
	}
});

// ── Plan item notes ────────────────────────────────────────────────────────

test("planSelectedItems carries notes for selected items only", () => {
	const sel = planSelectAll(selProposal, planSelectionClear());
	const notes = new Map<string, string>([
		[planItemKey(0, 0), "keep the API"],
		[planItemKey(1, 0), "  "], // whitespace-only: dropped
		[planItemKey(1, 3), "note for unselected item"], // not selected: ignored
	]);
	const items = planSelectedItems(selProposal, sel, notes);
	const withNotes = items.filter((e) => e.note !== undefined);
	assert.equal(withNotes.length, 1);
	assert.equal(withNotes[0].item.title, "a");
	assert.equal(withNotes[0].note, "keep the API");
	// Without the notes argument the output is unchanged.
	const plain = planSelectedItems(selProposal, sel);
	assert.ok(plain.every((e) => e.note === undefined));
});

test("formatPlanExecutionPrompt appends the note in brackets", () => {
	const entry = [
		{ tier: selProposal.tiers[0], item: { title: "Fix bug", detail: "src/foo.ts:42" }, note: "keep the API" },
		{ tier: selProposal.tiers[1], item: { title: "No note" } },
	];
	const prompt = formatPlanExecutionPrompt(entry, "Security");
	assert.ok(prompt.includes("1. [P0] Fix bug — src/foo.ts:42 [note: keep the API]"));
	assert.ok(prompt.includes("2. [P1] No note"));
	assert.ok(!prompt.includes("2. [P1] No note ["));
});

// ── isPlanTask ─────────────────────────────────────────────────────────────

test("isPlanTask matches the Plan category case-insensitively", () => {
	assert.equal(isPlanTask({ name: "x", prompt: "p", category: "Plan" }), true);
	assert.equal(isPlanTask({ name: "x", prompt: "p", category: "plan" }), true);
	assert.equal(isPlanTask({ name: "x", prompt: "p", category: " plan " }), true);
	assert.equal(isPlanTask({ name: "x", prompt: "p", category: "Do" }), false);
	assert.equal(isPlanTask({ name: "x", prompt: "p" }), false);
});

// ── Test-mode samples (/do-always testplan) ────────────────────────────────

test("TEST_PLAN_SAMPLE_OK parses through the strict path and strips cleanly", () => {
	const p = parsePlanProposal(TEST_PLAN_SAMPLE_OK);
	assert.ok(p);
	assert.equal(p.tiers.length, 2);
	assert.equal(p.tiers.reduce((n, t) => n + t.items.length, 0), 2);
	assert.deepEqual(planBlockDiagnostics(TEST_PLAN_SAMPLE_OK), { kind: "ok", itemCount: 2 });
	// The closed fence is stripped from the transcript.
	const { text, removed } = stripPlanBlocks(TEST_PLAN_SAMPLE_OK);
	assert.ok(removed);
	assert.ok(!text.includes("```plan"));
});

test("TEST_PLAN_SAMPLE_MALFORMED parses through the lenient path (unclosed fence, truncated JSON, trailing tags)", () => {
	const p = parsePlanProposal(TEST_PLAN_SAMPLE_MALFORMED);
	assert.ok(p);
	assert.equal(p.tiers.length, 2);
	assert.equal(p.tiers.reduce((n, t) => n + t.items.length, 0), 3);
	assert.deepEqual(planBlockDiagnostics(TEST_PLAN_SAMPLE_MALFORMED), { kind: "ok", itemCount: 3 });
	// The unclosed fence is stripped from the transcript like a closed one —
	// its region carries parseable JSON (the lenient path auto-closes the
	// truncated root brace), so the raw block no longer leaks into the reply.
	const { text, removed } = stripPlanBlocks(TEST_PLAN_SAMPLE_MALFORMED);
	assert.equal(removed, true);
	assert.equal(text, "Review finished. The plan:");
});

// ── Robust plan block extraction & lenient parsing ─────────────────────────

test("parsePlanProposal parses an unclosed plan fence at end of text", () => {
	const text = "Review finished:\n```plan\n{\"tiers\":[{\"items\":[{\"title\":\"unclosed item\"}]}]}\n";
	const p = parsePlanProposal(text);
	assert.ok(p);
	assert.equal(p.tiers.length, 1);
	assert.equal(p.tiers[0].items[0].title, "unclosed item");
});

test("parsePlanProposal accepts fence variations (plan json, plan:json, indented, tildes)", () => {
	const variations = [
		'```plan json\n{"tiers":[{"items":[{"title":"var1"}]}]}\n```',
		'```plan:json\n{"tiers":[{"items":[{"title":"var2"}]}]}\n```',
		'``` plan\n{"tiers":[{"items":[{"title":"var3"}]}]}\n```',
		'````plan\n{"tiers":[{"items":[{"title":"var4"}]}]}\n````',
		'~~~plan\n{"tiers":[{"items":[{"title":"var5"}]}]}\n~~~',
		'```plan\n{"tiers":[{"items":[{"title":"var6"}]}]}\n   ```',
	];
	for (const v of variations) {
		const p = parsePlanProposal(v);
		assert.ok(p, `failed to parse variation: ${v}`);
		assert.equal(p.tiers[0].items.length, 1);
	}
});

test("parsePlanProposal parses blocks with trailing tool XML tags", () => {
	const text =
		"Review finished.\n```plan\n" +
		'{"tiers":[{"items":[{"title":"clean dead code"}]}]}\n' +
		"  </parameter>\n" +
		"  </function>\n" +
		"  </tool_call>\n";
	const p = parsePlanProposal(text);
	assert.ok(p);
	assert.equal(p.tiers[0].items[0].title, "clean dead code");
	const diag = planBlockDiagnostics(text);
	assert.deepEqual(diag, { kind: "ok", itemCount: 1 });
});

test("parsePlanProposal handles unescaped newlines in JSON strings from word wrapping", () => {
	const text =
		"```plan\n" +
		'{"summary":"First line of summary\nsecond line of summary","tiers":[{"items":[{"title":"Long title with\nwrapped line","detail":"Long detail with\nwrapped line"}]}]}\n' +
		"```";
	const p = parsePlanProposal(text);
	assert.ok(p);
	assert.ok(p.summary?.includes("First line of summary"));
	assert.ok(p.tiers[0].items[0].title.includes("Long title with"));
	assert.ok(p.tiers[0].items[0].detail?.includes("Long detail with"));
});

test("parsePlanProposal auto-balances missing root closing braces", () => {
	// Cut off before the root closing brace
	const text = '```plan\n{"tiers":[{"items":[{"title":"item"}]}]';
	const p = parsePlanProposal(text);
	assert.ok(p);
	assert.equal(p.tiers[0].items[0].title, "item");
});

test("parsePlanProposal successfully parses the full MoCap report sample", () => {
	const text =
		"```plan                                                                                                                       \n" +
		'  {"summary":"Fix 2 pre-existing test failures, remove 5 dead code items, consolidate 5 duplicated-logic sites across the     \n' +
		'Python MoCap stack, behavior unchanged","tiers":[{"id":"P0","label":"Critical","items":[{"title":"Align the 5 divergent       \n' +
		'version strings to one value (1.4.0)","detail":"test_version_number fails: mocap_core.py:55, mocap_server.py:30,              \n' +
		'mocap_web_server.py:63 say 1.2.0, fake_mocap_stream.py:41 says 1.4.0, firmware/src/esp32_mocap.ino:71 FIRMWARE_VERSION says   \n' +
		'1.3.0. Bump core/server/web and firmware to 1.4.0 (metadata only)."},{"title":"Fix stale test_fake_mocap_stream_generation    \n' +
		'timestamps","detail":"test_mocap.py:619-627: generate_motion(2.0/7.0/12.0) now lands in the new Phase 0 (capacities demo).    \n' +
		'Pass with_cap=False to the three generate_motion calls to restore the pre-Phase-0 phase boundaries the assertions were written\n' +
		'against; no generator change."}]},{"id":"P1","label":"High","items":[{"title":"Remove                                         \n' +
		'MocapReceiver.compute_frame","detail":"mocap_core.py:972-974 — never called anywhere; record_frame() is a strict superset     \n' +
		'(same compute_pose + frame bookkeeping)."},{"title":"Remove dead quat helpers in                                              \n' +
		'mocap_biomechanics","detail":"mocap_biomechanics.py:276-290 quat_to_euler_rad and :292-305 euler_rad_to_quat — zero references\n' +
		'in all modules and tests (confirmed by AST sweep)."},{"title":"Remove unused KALI_TRACKER_TO_JOINT                            \n' +
		'alias","detail":"mocap_core.py:335 — alias of TRACKER_TO_JOINT, no consumer in code, tests, or docs."},{"title":"Remove unused\n' +
		'CaptorPlacement class and CAPTOR_PLACEMENTS dict","detail":"mocap_core.py:290-300 and :338-362 — built at import but never    \n' +
		'consumed. Keep the fail-fast check by replacing with a direct assert that every TRACKER_TO_JOINT joint exists in SEGMENT_MAP  \n' +
		'and REST_POSITIONS (preserves import-time validation behavior)."}]},{"id":"P2","label":"Medium","items":[{"title":"Consolidate\n' +
		'quat primitives into mocap_biomechanics","detail":"Delete mocap_core.py:406-430 (quat_multiply, quat_conjugate,               \n' +
		'quat_normalize) and import them from mocap_biomechanics (identical, :191-212) so mocap_core.* names keep working for          \n' +
		'mocap_web_server imports. Note: zero-quaternion edge case changes NaN -> identity (strictly safer, only on corrupted          \n' +
		'packets)."},{"title":"Move SENSOR_MAPPING to mocap_core, import in both servers","detail":"Identical 23-entry dicts at        \n' +
		'mocap_server.py:38 and mocap_web_server.py:79 (comments differ only). Define once in mocap_core.py next to TRACKER_TO_JOINT;  \n' +
		'both files import it."},{"title":"Extract shared UDP frame parser in mocap_core","detail":"Three drifted copies of the        \n' +
		'NODE#seq#txmicros;sid,q0..q3[,ax,ay,az] text parser: mocap_core.py:883 _process_packet, mocap_web_server.py:776               \n' +
		'process_packet, mocap_server.py:65 parse_packet. Add parse_udp_frame(message) -> (node_id, seq, tx_timestamp, sensors) in     \n' +
		"mocap_core and use it in all three; keep each caller's post-parse policy (enabled-sensor filtering, state updates) intact.    \n" +
		'Medium risk — verify with the full test suite."},{"title":"Unify _to_float / _safe_float","detail":"Identical bodies at       \n' +
		'mocap_core.py:474 and mocap_analysis.py:184. Keep one in mocap_core (public name) and import it in                            \n' +
		'mocap_analysis.py."},{"title":"Build remaining quat->Euler copies on the shared core                                          \n' +
		'function","detail":"mocap_web_server.py:198 quat_to_euler_deg and mocap_analysis.py:92 euler_from_quat duplicate              \n' +
		'mocap_core.py:438 quat_to_euler (same ZYX formula). Reimplement the web version as rounded-degrees dict over core (keeps API  \n' +
		'contract) and the analysis version as a zero-guard wrapper (keeps its zero-quat -> zeros                                      \n' +
		'behavior)."}]},{"id":"P3","label":"Low","items":[{"title":"Decide fate of test-only                                           \n' +
		'mocap_core.quat_inverse","detail":"mocap_core.py:421-426 is referenced only by test_mocap.py:154. Public API — keep by        \n' +
		'default; only remove together with its test assertion if a slimmer API is desired."},{"title":"Optional: derive fake_stream   \n' +
		'Phase-3 sequence from JOINT_CAPABILITIES","detail":"fake_mocap_stream.py:165-189 sequence table is nearly derivable from      \n' +
		'JOINT_CAPABILITIES (:78-101) via _primary_axis, but the head entry (sid 22) intentionally uses pitch instead of its primary   \n' +
		'yaw axis — consolidating would change the visible demo. Do only if that behavior change is accepted."}]}]                     \n' +
		"  </parameter>                                                                                                                \n" +
		"  </function>                                                                                                                 \n" +
		"  </tool_call>";
	const p = parsePlanProposal(text);
	assert.ok(p);
	assert.equal(p.tiers.length, 4);
	const totalItems = p.tiers.reduce((n, t) => n + t.items.length, 0);
	assert.equal(totalItems, 13);
	assert.deepEqual(planBlockDiagnostics(text), { kind: "ok", itemCount: 13 });
});
